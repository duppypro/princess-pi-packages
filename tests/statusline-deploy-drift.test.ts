// statusline/ must reach ~/.claude — and drift must fail loudly (#227)
//
// Sibling of tests/hooks-deploy-drift.test.ts, split out rather than folded in
// because the destination is different in a way that matters: hooks land in
// ~/.claude/hooks/, a directory this repo effectively owns outright, while
// statusline scripts land in ~/.claude/ ITSELF — next to settings.json, which
// holds a live credential (princess-pi-brain#12) and which this installer must
// never touch. "Deploys the right files" and "touches nothing else in that
// directory" are two claims, and only the second one needs the neighbours.
//
// The gap this closes (dotfiles-doctor#17): `settings.json` invoked
// `bash ~/.claude/subagent-statusline.sh` while NO repo tracked that file —
// not this one, not dotfiles-doctor, whose three capture paths all structurally
// miss it. A fresh host got a statusline command pointing at a file that did
// not exist. Its sibling statusline-command.sh WAS tracked (by dotfiles-doctor),
// which is what made the gap easy to miss: the statusline looked covered.
//
// ADR 0001 makes both files harness enhancements — executable tooling, not
// configuration — so they are sourced here and deployed by install-workflow-tools.
//
// Run with: bun run test statusline-deploy-drift

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { skip } from "./lib/skips.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const STATUSLINE_SRC = path.join(REPO_ROOT, "statusline");

/**
 * Every tracked statusline script — read from disk, so adding one is covered
 * without editing this test (the same convention TRACKED_HOOKS uses).
 */
const TRACKED = fs
	.readdirSync(STATUSLINE_SRC)
	.filter((f) => f.endsWith(".sh"))
	.sort();

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ✅ ${label}`);
	} else {
		console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
		failures++;
	}
}

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "statusline-deploy-home-"));
}

/**
 * A PATH identical to this host's except that `name` resolves nowhere on it.
 *
 * Dropping the directory outright would take bash/awk/jq with it (they live
 * alongside), so this shadows the one binary: a fresh dir symlinking every
 * OTHER entry from each directory that provides it, spliced in ahead of those
 * directories, which are then dropped. Same shape as pathWithoutJq() in
 * tests/install-workflow-tools-self-deploy.test.ts, generalised — and dropping
 * EVERY provider matters here for the same reason it did there: /bin is a
 * symlink to /usr/bin on this host, so one binary appears under two PATH
 * entries and shadowing only the first leaves the alias reachable.
 */
function pathWithout(name: string): string {
	const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const provides = (dir: string) => {
		try {
			return fs.existsSync(path.join(dir, name));
		} catch {
			return false;
		}
	};
	const dirs = parts.filter(provides);
	if (dirs.length === 0) return process.env.PATH ?? "";
	const shadow = fs.mkdtempSync(path.join(os.tmpdir(), `statusline-no-${name}-`));
	for (const dir of dirs) {
		for (const entry of fs.readdirSync(dir)) {
			if (entry === name) continue;
			try {
				fs.symlinkSync(path.join(dir, entry), path.join(shadow, entry));
			} catch {
				// already linked from an earlier provider, or a broken target
			}
		}
	}
	return [shadow, ...parts.filter((p) => !dirs.includes(p))].join(path.delimiter);
}

function run(home: string, args: string[] = []): { code: number; out: string } {
	const r = spawnSync("bash", [INSTALLER, ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}` };
}

console.log("statusline deploy + drift gate (#227)");

check(TRACKED.length > 0, "statusline/ is non-empty", `read ${STATUSLINE_SRC}`);

// 1. Install deploys every tracked script to ~/.claude, byte-identical, executable.
{
	const home = freshHome();
	const { code, out } = run(home);

	check(code === 0, "installer exits 0 on a fresh machine", `got ${code}, out:\n${out}`);
	for (const f of TRACKED) {
		const dest = path.join(home, ".claude", f);
		const exists = fs.existsSync(dest);
		check(exists, `'${f}' deployed to ~/.claude`, out);
		if (!exists) continue;
		check(
			fs.readFileSync(dest, "utf8") === fs.readFileSync(path.join(STATUSLINE_SRC, f), "utf8"),
			`'${f}' deployed byte-identical to source`,
		);
		// settings.json invokes these as `bash ~/.claude/<name>.sh`, so the
		// exec bit is not strictly load-bearing today — but `--check` treats a
		// non-executable managed file as drift, and a file deployed one way
		// and audited another is a gate that reports on a fiction.
		check((fs.statSync(dest).mode & 0o111) !== 0, `'${f}' deployed executable`);
	}

	const second = run(home);
	check(second.code === 0, "second install run → exit 0 (idempotent)", second.out);
}

// 2. --check on a machine that never deployed: exit 1, names the file, writes nothing.
{
	const home = freshHome();
	const { code, out } = run(home, ["--check"]);

	check(code === 1, "--check with nothing deployed → exit 1", `got ${code}, out:\n${out}`);
	for (const f of TRACKED) {
		check(out.includes(f), `--check names the missing '${f}'`, out);
		check(!fs.existsSync(path.join(home, ".claude", f)), `--check deployed nothing for '${f}'`, out);
	}
}

// 3. --check after a real install: in sync → exit 0.
{
	const home = freshHome();
	run(home);
	const { code, out } = run(home, ["--check"]);
	check(code === 0, "--check after install → exit 0 (in sync)", `got ${code}, out:\n${out}`);
}

// 4. Drift: deployed copy edited behind source. Report, don't repair; a plain
//    install run then repairs it.
{
	const home = freshHome();
	run(home);
	const dest = path.join(home, ".claude", TRACKED[0]);
	const stale = "#!/usr/bin/env bash\n# pretend this is behind source\nexit 0\n";
	fs.writeFileSync(dest, stale);

	const { code, out } = run(home, ["--check"]);
	check(code === 1, `--check with a drifted '${TRACKED[0]}' → exit 1`, `got ${code}, out:\n${out}`);
	check(out.includes(TRACKED[0]), "--check names the drifted script", out);
	check(fs.readFileSync(dest, "utf8") === stale, "--check left the drifted file alone (report, not repair)");

	const repair = run(home);
	check(repair.code === 0, "install run after drift → exit 0", repair.out);
	check(
		fs.readFileSync(dest, "utf8") === fs.readFileSync(path.join(STATUSLINE_SRC, TRACKED[0]), "utf8"),
		"install run overwrote the drifted script with source",
	);
}

// 5. The neighbours in ~/.claude are untouched. This is the property that makes
//    deploying INTO ~/.claude acceptable at all: settings.json holds a live
//    credential (princess-pi-brain#12), and CLAUDE.md is prose dotfiles-doctor
//    owns under ADR 0001. Sentinel bytes, so a pass can only mean "not written".
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	const neighbours: Record<string, string> = {
		"settings.json": '{"SENTINEL":"do-not-touch","apiKeyHelper":"secret"}',
		"settings.local.json": '{"SENTINEL":"do-not-touch-local"}',
		"CLAUDE.md": "# SENTINEL — dotfiles-doctor owns this prose\n",
	};
	for (const [name, body] of Object.entries(neighbours)) {
		fs.writeFileSync(path.join(home, ".claude", name), body);
	}

	const { code, out } = run(home);
	check(code === 0, "install with neighbours present → exit 0", out);
	for (const [name, body] of Object.entries(neighbours)) {
		check(
			fs.readFileSync(path.join(home, ".claude", name), "utf8") === body,
			`install left ~/.claude/${name} byte-for-byte untouched`,
		);
	}
}

// 6. Behaviour: each script still renders from the payload shape it documents.
//    Deploying a file that no longer runs is the same failure as not deploying
//    it, one layer down — and both scripts fail SOFT by design, so "exit 0" is
//    not enough on its own; the output has to carry the field under test.
//
//    HOME is sandboxed: statusline-command.sh appends an audit record to
//    ~/.claude/statusline-logs/<session>.jsonl on every render (its own
//    reconciliation evidence against wtft, #149). Without the override this
//    suite would write into THIS host's live log every run.
{
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-behaviour-home-"));

	const render = (script: string, payload: unknown, env: Record<string, string> = {}): { code: number; out: string } => {
		const r = spawnSync("bash", [path.join(STATUSLINE_SRC, script)], {
			input: JSON.stringify(payload),
			encoding: "utf8",
			env: { ...process.env, HOME: tmpHome, ...env },
		});
		return { code: r.status ?? -1, out: `${r.stdout || ""}` };
	};

	if (TRACKED.includes("statusline-command.sh")) {
		const res = render("statusline-command.sh", {
			model: { display_name: "Opus 5" },
			workspace: { current_dir: REPO_ROOT },
			context_window: { total_input_tokens: 1200, total_output_tokens: 300, remaining_percentage: 75 },
			cost: { total_cost_usd: 1.234 },
			transcript_path: "/tmp/abcdef01-2345-6789-abcd-ef0123456c1a.jsonl",
		});
		check(res.code === 0, "statusline-command.sh exits 0 on a well-formed payload", res.out);
		check(res.out.includes("Opus 5"), "statusline-command.sh renders the model name", res.out);
		check(res.out.includes("1.5k tok"), "statusline-command.sh renders summed tokens (1200+300)", res.out);
		check(res.out.includes("$1.23"), "statusline-command.sh renders session cost", res.out);
		check(res.out.includes("25%"), "statusline-command.sh renders context used (100 - remaining)", res.out);

		// Empty payload: a status line that throws is worse than one that is
		// terse — it renders as noise on every redraw.
		const empty = render("statusline-command.sh", {});
		check(empty.code === 0, "statusline-command.sh exits 0 on an empty payload (fails soft)", empty.out);

		// `bc` absent (PR #278 review, reproduced before fixing). Not a
		// hypothetical host: Debian/Ubuntu do not install bc by default, and
		// this repo's own installer only warns about jq. The old `bc -l` path
		// failed in the worst available way — an empty command substitution
		// that `printf "%.1fk"` rendered as a confident **0.0k**, with the
		// only hint on a stderr stream nothing displays.
		//
		// Asserted on the >=1000 branch specifically: that is the ONLY branch
		// that ever called bc, so a payload under 1k would pass against the
		// broken version too and prove nothing.
		const noBc = render(
			"statusline-command.sh",
			{
				model: { display_name: "Opus 5" },
				context_window: { total_input_tokens: 1200, total_output_tokens: 300 },
			},
			{ PATH: pathWithout("bc") },
		);
		check(noBc.code === 0, "statusline-command.sh exits 0 with bc absent from PATH", noBc.out);
		check(noBc.out.includes("1.5k tok"), "statusline-command.sh renders real tokens with bc absent (not 0.0k)", noBc.out);
		check(!noBc.out.includes("0.0k"), "statusline-command.sh does not silently report 0.0k with bc absent", noBc.out);

		// And the dependency is gone from the source, not merely worked
		// around on the >=1000 path — bc was this file's one single-use
		// dependency, so a reintroduction anywhere should fail here.
		check(
			!/\bbc\b/.test(fs.readFileSync(path.join(STATUSLINE_SRC, "statusline-command.sh"), "utf8").replace(/^\s*#.*$/gm, "")),
			"statusline-command.sh calls bc nowhere (awk covers both float sites)",
		);
	}

	if (TRACKED.includes("subagent-statusline.sh")) {
		const res = render("subagent-statusline.sh", {
			tasks: [
				{
					model: "claude-opus-5",
					status: "running",
					label: "review changes",
					tokenCount: 42_000,
					contextWindowSize: 200_000,
					startTime: 0,
					tokenSamples: [1, 2, 3],
				},
			],
		});
		check(res.code === 0, "subagent-statusline.sh exits 0 on a well-formed row", res.out);
		// The loud-opus rendering is the point of the script, not a flourish:
		// the routing rule's failure mode is silent inheritance of the
		// flagship model by mechanical work.
		check(res.out.includes("OPUS!"), "subagent-statusline.sh flags an opus row loudly", res.out);
		check(res.out.includes("42k"), "subagent-statusline.sh renders the humanised token count", res.out);
		check(res.out.includes("21%"), "subagent-statusline.sh renders context share", res.out);

		const stalled = render("subagent-statusline.sh", {
			tasks: [
				{ model: "claude-sonnet-5", status: "running", label: "grep", tokenCount: 10, contextWindowSize: 100, startTime: 0, tokenSamples: [7, 7, 7] },
			],
		});
		check(stalled.out.includes("idle"), "subagent-statusline.sh marks an all-identical token series idle", stalled.out);

		const none = render("subagent-statusline.sh", { tasks: [] });
		check(none.code === 0, "subagent-statusline.sh exits 0 with no task rows (fails soft)", none.out);
		check(none.out.includes("no task data"), "subagent-statusline.sh says so rather than rendering '? 0'", none.out);
	}
}

// 7. THIS host. Compare against what settings.json actually wires, not an
//    assumed path — the same reasoning as hooks-deploy-drift's live check. A
//    host wiring a script this repo does not track is the dotfiles-doctor#17
//    state exactly, and it must fail here rather than be discovered on a fresh
//    machine that has the settings.json and none of the scripts.
{
	const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
	if (!fs.existsSync(settingsPath)) {
		skip("no ~/.claude/settings.json — not a Claude Code host, so the live drift check did not run");
	} else {
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const wired: string[] = [settings?.statusLine?.command, settings?.subagentStatusLine?.command]
			.filter((c): c is string => typeof c === "string" && c.length > 0);

		check(wired.length > 0, "settings.json wires at least one statusline command", JSON.stringify(settings?.statusLine ?? null));

		for (const command of wired) {
			// The path is the last whitespace-separated token that looks like a
			// script (`bash ~/.claude/<name>.sh`).
			const token = command.split(/\s+/).find((t) => t.endsWith(".sh")) ?? "";
			const wiredPath = token.replace(/^~/, os.homedir());
			const name = path.basename(wiredPath);

			check(
				TRACKED.includes(name),
				`the statusline this host runs ('${name}') is tracked in statusline/`,
				`settings.json wires ${command}, but statusline/ holds: ${TRACKED.join(", ")}\nThis is the dotfiles-doctor#17 shape: wired by path, tracked by nobody.`,
			);
			if (!TRACKED.includes(name)) continue;

			const live = fs.existsSync(wiredPath) ? fs.readFileSync(wiredPath, "utf8") : null;
			check(
				live === fs.readFileSync(path.join(STATUSLINE_SRC, name), "utf8"),
				`the ${name} this host actually runs matches statusline/${name}`,
				`${wiredPath} is ${live === null ? "MISSING" : "BEHIND/AHEAD of"} source.\nFix: bin/install-workflow-tools`,
			);
		}
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} statusline deploy + drift: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

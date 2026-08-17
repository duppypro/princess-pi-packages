// install-workflow-tools: the installer must not delete anything (#235)
//
// Direction B (Duppy, 2026-08-11): the installer stops mutating anything it
// did not install, but reports stale workflow tools it finds on PATH instead
// of silently disappearing them. Drives the REAL bin/install-workflow-tools
// against a throwaway $HOME, because the property under test — "does this
// script rm anything" — cannot be verified without actually running it.
//
// Run with: bun run test install-workflow-tools-no-delete

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const MANAGED_SCRIPTS = ["git-checkpoint", "git-overview", "pr-open", "pr-merge", "pr-reject", "pr-cleanup", "pr-threads"];

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
	return fs.mkdtempSync(path.join(os.tmpdir(), "iwt-home-"));
}

function run(home: string, extraPath?: string): { code: number; out: string } {
	let code = 0;
	let out = "";
	const path_ = extraPath ? `${extraPath}${path.delimiter}${process.env.PATH}` : process.env.PATH;
	try {
		out = execFileSync("bash", [INSTALLER], {
			encoding: "utf8",
			env: { ...process.env, HOME: home, PATH: path_ },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	return { code, out };
}

console.log("install-workflow-tools: removes nothing, reports stale tools (#235)");

// 1. Seed $HOME/bin with two known-stale names and one unrelated file. The
//    unrelated file is the important assertion: it proves the installer's
//    blast radius is bounded to names it knows about, not "everything here".
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "merge"), "#!/bin/sh\necho old\n");
	fs.writeFileSync(path.join(bin, "git-ship"), "#!/bin/sh\necho old\n");
	fs.writeFileSync(path.join(bin, "my-unrelated-tool"), "#!/bin/sh\necho mine\n");

	const { code, out } = run(home);

	check(code === 0, "installer exits 0 with stale tools present", `got ${code}, out:\n${out}`);
	check(fs.existsSync(path.join(bin, "merge")), "stale 'merge' still exists after install", out);
	check(fs.existsSync(path.join(bin, "git-ship")), "stale 'git-ship' still exists after install", out);
	check(fs.existsSync(path.join(bin, "my-unrelated-tool")), "unrelated file untouched", out);
	for (const script of MANAGED_SCRIPTS) {
		check(fs.existsSync(path.join(bin, script)), `managed script '${script}' was installed`, out);
	}
}

// 2. Report fires: a stale tool present is named in the output, and its
//    presence doesn't turn a successful install into a failure.
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "merge"), "#!/bin/sh\necho old\n");

	const { code, out } = run(home);

	check(code === 0, "stale tool present → exit status still 0 (a report is not a failure)", `got ${code}`);
	check(/merge/.test(out) && /stale/i.test(out), "stale 'merge' is named in the report", out);
}

// 3. Fresh machine: empty $HOME/bin, clean install, no report lines at all.
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });

	const { code, out } = run(home);

	check(code === 0, "fresh machine → exit 0", `got ${code}`);
	check(!/stale/i.test(out), "fresh machine → no stale-tool report lines", out);
}

// 4. Idempotent: running twice against the same $HOME changes nothing further
//    and produces the same result both times.
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "post-merge-cleanup"), "#!/bin/sh\necho old\n");

	const first = run(home);
	const before = fs.readdirSync(bin).sort();
	const second = run(home);
	const after = fs.readdirSync(bin).sort();

	check(first.code === 0 && second.code === 0, "idempotent: exit 0 both runs", `${first.code}, ${second.code}`);
	check(JSON.stringify(before) === JSON.stringify(after), "idempotent: $HOME/bin contents unchanged between runs", `${before.join(",")} vs ${after.join(",")}`);
}

// 5. Stale tool elsewhere on PATH — not in $HOME/bin at all — is still
//    caught (#240 review: the original version only checked $INSTALL_DIR,
//    so a stale copy in e.g. ~/.local/bin sat unreported).
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-elsewhere-"));
	const stalePath = path.join(elsewhere, "git-ship");
	fs.writeFileSync(stalePath, "#!/bin/sh\necho old\n");
	fs.chmodSync(stalePath, 0o755);

	const { code, out } = run(home, elsewhere);

	check(code === 0, "stale tool elsewhere on PATH → exit status still 0", `got ${code}`);
	check(out.includes(stalePath), "stale tool elsewhere on PATH → reported with its real location, not assumed to be in ~/bin", out);
}

// 6. The converse of #5: a stale name that exists on disk but is NOT on
//    PATH at all must not be reported — nothing can shadow it, so it isn't
//    the "stale tool sitting on PATH unnoticed" risk this feature guards.
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	const notOnPath = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-not-on-path-"));
	fs.writeFileSync(path.join(notOnPath, "merge"), "#!/bin/sh\necho old\n");

	const { code, out } = run(home); // note: notOnPath never added to PATH

	check(code === 0, "unreachable stale tool present on disk → exit status still 0", `got ${code}`);
	check(!/stale/i.test(out), "stale name that exists but isn't on PATH anywhere → not reported", out);
}

// 7. Bare-name PATH collision with an unrelated binary must NOT be reported
//    as stale — the false positive at the center of #246: /usr/bin/merge
//    (RCS three-way merge, ships with rcs/diffutils, zero relation to this
//    repo) shares the retired "merge" name and used to get flagged "removed
//    in #201, replaced by pr-open" on any host that happens to have that
//    package installed. Every script this repo has ever shipped — every
//    current bash entry AND the old merge.ts/merge.mjs before #201 — opens
//    with a shebang (`#!`); a compiled binary's first two bytes never do.
//    Simulate the collision with raw ELF-magic bytes rather than a real
//    binary, since the fixture only needs to prove "not a script we could
//    plausibly have shipped".
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });
	const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-collision-"));
	const collision = path.join(elsewhere, "merge");
	fs.writeFileSync(collision, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])); // ELF magic, no shebang
	fs.chmodSync(collision, 0o755);

	const { code, out } = run(home, elsewhere);

	check(code === 0, "unrelated PATH binary sharing a stale name → exit status still 0", `got ${code}`);
	check(!/stale/i.test(out), "unrelated binary with no shebang → not reported as stale", out);
	check(!out.includes(collision), "unrelated binary's path not named in the report", out);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} install-workflow-tools no-delete: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

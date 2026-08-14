// No path in $HOME is written by two installers (#227 step 7, ADR 0001)
//
// ADR 0001 traded dotfiles-doctor's single-writer invariant for a narrower one:
// **every artifact has exactly one owning repo**, and the owner holds the
// source, the tests, and the installer. That trade is only safe if the new
// invariant is machine-checked, because the failure it replaces was invisible
// by construction — `install-workflow-tools --check` reports "in sync"
// truthfully while knowing nothing about the other repo's copy, and so does
// dotfiles-doctor's snapshot pass.
//
// What that cost, measured 2026-08-14 (dotfiles-doctor#18): block-edit-on-main.sh
// existed in three places, and the two repo copies had drifted in OPPOSITE
// directions — dotfiles-doctor held the .git/-internals exemption (its #15),
// princess-pi-packages held the symlink canonicalization (#267). Whichever
// installer ran last silently reverted the other. The live host matched us, so
// dotfiles-doctor's own shipped fix was running on no machine at all.
//
// Two halves, deliberately different in strength:
//
//   A. THIS repo's own claim — hard gates, always run. What the installer
//      declares, what it actually writes, and what it must never write.
//   B. The cross-repo overlap — asserted against dotfiles-doctor when that
//      clone is present, skipped cleanly when it is not, and waived per-path
//      for the overlaps the campaign has not reached yet. A waiver names its
//      issue and fails once it is no longer needed, so the list drains itself.
//
// Run with: bun run test installer-path-ownership

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const INSTALLER_SRC = fs.readFileSync(INSTALLER, "utf8");
const DOTFILES_DOCTOR = path.join(os.homedir(), "git-projects", "dotfiles-doctor");

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

/**
 * Read one bash array from the installer, dropping comment lines.
 *
 * Parsed rather than restated for the reason #263 established the hard way: a
 * second hardcoded copy of a manifest drifts the moment a branch adds an entry,
 * and the resulting failure is invisible on either branch alone.
 */
function bashArray(name: string): string[] {
	const m = INSTALLER_SRC.match(new RegExp(`(?:^|\\n)${name}=\\(([\\s\\S]*?)\\n\\)`));
	if (!m) throw new Error(`${name} array not found in bin/install-workflow-tools`);
	return m[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}

console.log("installer path ownership (#227 step 7, ADR 0001)");

// ---
// A. What this repo claims — derived from the installer's own manifests.
// ---

/** $HOME-relative paths this installer writes, by manifest. */
const CLAIMED: Array<{ rel: string; manifest: string }> = [
	...bashArray("SCRIPTS").map((s) => ({ rel: `bin/${s}`, manifest: "SCRIPTS" })),
	...bashArray("HOOKS").map((h) => ({ rel: `.claude/hooks/${h}`, manifest: "HOOKS" })),
	...bashArray("STATUSLINES").map((s) => ({ rel: `.claude/${s}`, manifest: "STATUSLINES" })),
];
const CLAIMED_PATHS = new Set(CLAIMED.map((c) => c.rel));

check(CLAIMED.length > 0, "installer manifests parse to at least one managed path");

// A1. No path is claimed twice by our OWN manifests. Cheap, and the failure it
//     catches is a real one: ~/.claude/<x>.sh from STATUSLINES and
//     ~/.claude/hooks/<x>.sh from HOOKS are different paths, but a future
//     manifest that shares a destination directory would race itself.
{
	const seen = new Map<string, string>();
	const dupes: string[] = [];
	for (const { rel, manifest } of CLAIMED) {
		const prior = seen.get(rel);
		if (prior) dupes.push(`${rel} (${prior} and ${manifest})`);
		else seen.set(rel, manifest);
	}
	check(dupes.length === 0, "no $HOME path appears in two of this installer's manifests", dupes.join("\n"));
}

// A2. Configuration and prose are never claimed. ~/.claude/settings.json holds
//     a live credential (princess-pi-brain#12); the CLAUDE.md files are prose
//     ADR 0001 leaves with dotfiles-doctor. Declared list first — a manifest
//     entry naming one of these is a bug even before the installer runs.
const NEVER_WRITE = [
	".claude/settings.json",
	".claude/settings.local.json",
	".claude/CLAUDE.md",
	"git-projects/CLAUDE.md",
	".claude/duppy-voice-card.md",
];
for (const forbidden of NEVER_WRITE) {
	check(!CLAIMED_PATHS.has(forbidden), `no manifest claims ~/${forbidden} (config/prose — dotfiles-doctor's)`);
}

// A3. And empirically: a real install into a temp $HOME writes EXACTLY the
//     claimed set and nothing else. The declared list above is the intent; this
//     is the behaviour. They are different claims — deploy() could grow a
//     directory sync, or a `mkdir -p` could become a `cp -r`, without any
//     manifest changing.
{
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-ownership-home-"));
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(home, "git-projects"), { recursive: true });

	// Sentinels for every path the installer must leave alone, seeded so the
	// assertion is "unchanged bytes", not the weaker "still exists".
	const sentinels: Record<string, string> = {};
	for (const rel of NEVER_WRITE) {
		const p = path.join(home, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		sentinels[rel] = `SENTINEL ${rel} — must survive install untouched\n`;
		fs.writeFileSync(p, sentinels[rel]);
	}

	const r = spawnSync("bash", [INSTALLER], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const out = `${r.stdout || ""}${r.stderr || ""}`;
	check(r.status === 0, "install into a seeded temp $HOME → exit 0", `got ${r.status}, out:\n${out}`);

	for (const rel of NEVER_WRITE) {
		check(
			fs.readFileSync(path.join(home, rel), "utf8") === sentinels[rel],
			`install left ~/${rel} byte-for-byte untouched`,
		);
	}

	/** Every regular file under $HOME after the install, $HOME-relative. */
	const walk = (dir: string, acc: string[] = []): string[] => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, acc);
			else acc.push(path.relative(home, full));
		}
		return acc;
	};
	const written = walk(home)
		.filter((rel) => !NEVER_WRITE.includes(rel))
		// statusline-command.sh writes an audit record on RENDER, not on
		// install; nothing here renders one, but exclude the directory
		// explicitly so a future accident there reads as a real failure
		// somewhere it can be seen rather than as a mysterious extra file.
		.filter((rel) => !rel.startsWith(".claude/statusline-logs/"))
		.sort();
	const unexpected = written.filter((rel) => !CLAIMED_PATHS.has(rel));
	const missing = [...CLAIMED_PATHS].filter((rel) => !written.includes(rel)).sort();

	check(unexpected.length === 0, "install wrote nothing it does not declare", unexpected.join("\n"));
	check(missing.length === 0, "install wrote everything it declares", missing.join("\n"));
}

// ---
// B. The cross-repo overlap. Skipped where dotfiles-doctor is not cloned —
//    this test's job is to catch a two-writer path, and on a host with one
//    repo there cannot be one.
// ---

/**
 * Waivers for overlaps the campaign has not reached yet
 * (campaigns/2026-08-14-harness-tooling-ownership.yaml, step 5 —
 * dotfiles-doctor demotes these from stow source to captured mirror).
 *
 * A waiver expires by failing: once the overlap is gone the entry is asserted
 * unnecessary, so the list drains rather than accumulating. That matters more
 * than it sounds — a permanent waiver list is how a gate becomes decoration.
 */
const WAIVED: Record<string, string> = {
	".claude/hooks/block-edit-on-main.sh": "dotfiles-doctor#18 step 5 — demote to captured mirror (.stow-local-ignore)",
	".claude/hooks/preedit-reread-check.py": "dotfiles-doctor#18 step 5 — demote to captured mirror (.stow-local-ignore)",
	".claude/statusline-command.sh": "dotfiles-doctor#18 step 5 — demote to captured mirror (.stow-local-ignore)",
};

if (!fs.existsSync(DOTFILES_DOCTOR)) {
	console.log(`  ⏭️  no ${DOTFILES_DOCTOR} clone — only one installer on this host, skipping overlap check`);
} else {
	/**
	 * dotfiles-doctor's stow packages. Union of the two lists that exist,
	 * because either can be the one that runs: install/bootstrap.sh's PACKAGES
	 * default is what `stow --restow` actually receives, and install/doctor.sh
	 * carries its own (longer) list. A path stowable under EITHER is a path
	 * that can overwrite ours, so the union is the honest question.
	 */
	const packages = (() => {
		const found = new Set<string>();
		for (const rel of ["install/bootstrap.sh", "install/doctor.sh"]) {
			const p = path.join(DOTFILES_DOCTOR, rel);
			if (!fs.existsSync(p)) continue;
			const src = fs.readFileSync(p, "utf8");
			for (const m of src.matchAll(/^PACKAGES=(?:"\$\{PACKAGES:-)?"?([a-z0-9 _-]+)"?\}?"?$/gim)) {
				for (const pkg of m[1].trim().split(/\s+/)) found.add(pkg);
			}
		}
		return [...found].sort();
	})();

	check(packages.length > 0, "parsed dotfiles-doctor's stow package list", `looked in install/bootstrap.sh, install/doctor.sh`);

	/**
	 * `.stow-local-ignore` semantics, approximated: each non-comment line is a
	 * regex, matched against the package-relative path and against the
	 * basename. stow's real rules are fiddlier (anchoring differs between
	 * top-level and deeper entries), and the approximation errs toward calling
	 * a path IGNORED — which is the safe direction here only because a false
	 * "ignored" turns into a failing waiver below rather than a silent pass.
	 */
	const ignoreMatchers = (pkgDir: string): RegExp[] => {
		const p = path.join(pkgDir, ".stow-local-ignore");
		if (!fs.existsSync(p)) return [];
		return fs
			.readFileSync(p, "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"))
			.flatMap((l) => {
				try {
					return [new RegExp(l)];
				} catch {
					return [];
				}
			});
	};

	/** $HOME-relative paths dotfiles-doctor would STOW (not merely capture). */
	const stowed = new Set<string>();
	for (const pkg of packages) {
		const pkgDir = path.join(DOTFILES_DOCTOR, pkg);
		if (!fs.existsSync(pkgDir)) continue;
		const matchers = ignoreMatchers(pkgDir);
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				const rel = path.relative(pkgDir, full);
				if (rel === ".stow-local-ignore") continue;
				if (matchers.some((re) => re.test(rel) || re.test(path.basename(rel)))) continue;
				stowed.add(rel);
			}
		};
		walk(pkgDir);
	}

	const overlap = [...CLAIMED_PATHS].filter((rel) => stowed.has(rel)).sort();
	const unwaived = overlap.filter((rel) => !(rel in WAIVED));
	check(
		unwaived.length === 0,
		"no $HOME path is stowable by dotfiles-doctor AND deployed by install-workflow-tools",
		unwaived.length === 0
			? ""
			: `${unwaived.map((r) => `  ~/${r}`).join("\n")}\n\nADR 0001: one owning repo per artifact. Either drop it from this repo's\nmanifest, or demote dotfiles-doctor's copy (.stow-local-ignore) so it is a\ncaptured mirror rather than a stow source.`,
	);

	// Waivers must still be needed. An entry whose overlap is gone is stale
	// bookkeeping that quietly widens the gate for the next path added there.
	for (const [rel, why] of Object.entries(WAIVED)) {
		if (!CLAIMED_PATHS.has(rel)) {
			check(false, `waiver for ~/${rel} names a path this installer no longer deploys — delete the waiver`, why);
			continue;
		}
		check(
			stowed.has(rel),
			`waiver for ~/${rel} is still needed`,
			`dotfiles-doctor no longer stows it — delete this waiver from WAIVED.\n(${why})`,
		);
	}

	if (overlap.length > 0) {
		console.log(
			`  ℹ️  ${overlap.length} waived overlap${overlap.length === 1 ? "" : "s"} pending dotfiles-doctor#18 step 5:\n${overlap.map((r) => `       ~/${r}`).join("\n")}`,
		);
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} installer path ownership: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

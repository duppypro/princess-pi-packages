// install-workflow-tools deploys itself to ~/bin (#263)
//
// The gap: nine workflow scripts land on PATH via this installer; the
// installer itself did not, so the one script whose job is "make the
// documented `~/bin` standard true" was the only one you couldn't run the
// documented way — you had to know its repo path.
//
// Two things make "add itself to the manifest" harder than it sounds, both
// covered here:
//   1. Once deployed, bash sets $0 to the resolved ~/bin path when the
//      script is invoked by bare name — so the naive `dirname "$0"/..`
//      REPO_DIR resolution silently resolves to $HOME instead of the repo.
//      install-workflow-tools falls back to $HOME/git-projects/princess-pi-packages,
//      and tests override that via INSTALL_WORKFLOW_TOOLS_REPO_DIR to stay
//      hermetic (no dependency on this host's real ~/git-projects layout).
//   2. Deploying over yourself means the file bash is currently reading may
//      be the exact file being overwritten. `deploy()` writes to a sibling
//      temp file and `mv`s it into place — an atomic rename — instead of
//      `cp`-ing over the live inode in place.
//
// Run with: bun test install-workflow-tools-self-deploy

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const INSTALLER_SRC = fs.readFileSync(INSTALLER, "utf8");

// Derive the fixture's script set from the installer's own SCRIPTS array rather
// than restating it. Two hardcoded copies of the list lived here and drifted the
// moment a branch added an entry: the fixture repo never created the new script,
// so the installer correctly reported it MISSING FROM SOURCE and the suite failed
// for a reason that had nothing to do with what it tests. That failure is
// invisible on either branch alone and only appears once they merge, which is the
// worst time to meet it. Comment lines are dropped — a bash array may carry them,
// and #263's `# Itself (#263)` is exactly the shape that broke the naive parsers
// in tests/dev-workflow-spec-consistency.test.ts and
// tests/install-path-no-ax-surrealdb.test.ts.
const FIXTURE_SCRIPTS = (() => {
	const m = INSTALLER_SRC.match(/SCRIPTS=\(([\s\S]*?)\n\)/);
	if (!m) throw new Error("SCRIPTS array not found in bin/install-workflow-tools");
	return m[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
})();

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "iwt-self-home-"));
}

// A PATH with every directory intact EXCEPT that jq is unreachable anywhere
// on it (#267 finding: is_this_repo() used to shell out to jq to read
// package.json's "name" field, so a host without jq rejected a VALID
// checkout with a misleading "can't find the repo" — jq's 2>/dev/null'd
// absence read as a wrong-repo error, not a missing-dependency one). Simply
// removing jq's directory from PATH would also remove bash/cp/mkdir/etc if
// they live alongside it (as they do here) and break the harness itself, so
// this shadows just jq: a fresh directory symlinking every OTHER entry from
// jq's directory, spliced in ahead of that directory (which is then dropped)
// so nothing named jq resolves anywhere on the resulting PATH.
function pathWithoutJq(): string {
	const parts = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const hasJq = (dir: string) => {
		try {
			return fs.existsSync(path.join(dir, "jq"));
		} catch {
			return false;
		}
	};
	// Drop EVERY PATH entry that resolves a "jq" file, not just the first
	// match — /bin is commonly a symlink to /usr/bin (as it is here), so both
	// appear as distinct PATH entries serving the identical binary. Dropping
	// only the one `command -v` happened to report would leave the other
	// alias reachable and this whole test would silently not exercise the
	// jq-absent path it claims to.
	const jqDirs = parts.filter(hasJq);
	if (jqDirs.length === 0) return process.env.PATH ?? "";
	const shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-no-jq-"));
	for (const entry of fs.readdirSync(jqDirs[0])) {
		if (entry === "jq") continue;
		try {
			fs.symlinkSync(path.join(jqDirs[0], entry), path.join(shadowDir, entry));
		} catch {
			// broken symlink target etc — not needed for this test's purposes
		}
	}
	const rest = parts.filter((p) => !jqDirs.includes(p));
	return [shadowDir, ...rest].join(path.delimiter);
}

function run(
	installerPath: string,
	env: Record<string, string | undefined>,
	args: string[] = [],
): { code: number; out: string } {
	// spawnSync, not execFileSync: execFileSync's return value on a SUCCESSFUL
	// (exit 0) run is stdout only — stderr is only ever surfaced via the
	// thrown error's `.stderr`, so a warning the installer prints to stderr on
	// an otherwise-clean run (e.g. the jq-missing notice) would be silently
	// dropped from `out` exactly on the success path most likely to emit it.
	// spawnSync always returns both streams regardless of exit code.
	const result = spawnSync("bash", [installerPath, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { code: result.status ?? -1, out: `${result.stdout || ""}${result.stderr || ""}` };
}

describe("install-workflow-tools deploys itself (#263)", () => {
	test("fresh install includes install-workflow-tools in ~/bin, executable, byte-identical", () => {
		const home = freshHome();
		const { code, out } = run(INSTALLER, { HOME: home });
		const dest = path.join(home, "bin", "install-workflow-tools");

		expect(code, out).toBe(0);
		expect(fs.existsSync(dest)).toBe(true);
		expect(fs.readFileSync(dest, "utf8")).toBe(INSTALLER_SRC);
		expect((fs.statSync(dest).mode & 0o111) !== 0).toBe(true);
	});

	test("--check reports itself MISSING when every other script deployed but it wasn't", () => {
		const home = freshHome();
		run(INSTALLER, { HOME: home });
		fs.rmSync(path.join(home, "bin", "install-workflow-tools"));

		const { code, out } = run(INSTALLER, { HOME: home }, ["--check"]);

		expect(code).toBe(1);
		expect(out).toContain("install-workflow-tools");
		expect(out).toMatch(/install-workflow-tools MISSING/);
	});

	test("--check after a full install reports in sync, itself included", () => {
		const home = freshHome();
		run(INSTALLER, { HOME: home });

		const { code, out } = run(INSTALLER, { HOME: home }, ["--check"]);

		expect(code, out).toBe(0);
	});

	test("self-overwrite: running the deployed copy against its own path completes and leaves it intact", () => {
		const home = freshHome();
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin, { recursive: true });
		const deployed = path.join(bin, "install-workflow-tools");
		// Seed a functioning but byte-different "already installed" baseline:
		// the running script HAS to be a real installer (it deploys itself by
		// running its own deploy loop), so a dummy stub can't stand in here.
		// One comment line is altered so a pass here can only mean the
		// overwrite actually happened, not that src and dest already matched.
		const stale = INSTALLER_SRC.replace(
			"# install-workflow-tools — make this host match the repo",
			"# install-workflow-tools — STALE PLACEHOLDER BASELINE FOR TEST",
		);
		expect(stale).not.toBe(INSTALLER_SRC);
		fs.writeFileSync(deployed, stale);
		fs.chmodSync(deployed, 0o755);

		// Invoke the SANDBOX copy, not the repo copy — this is the file bash
		// would be reading mid-execution while deploy() overwrites it.
		// INSTALL_WORKFLOW_TOOLS_REPO_DIR substitutes for the $0-relative
		// resolution that a real ~/bin invocation would fall back on, so the
		// test stays hermetic.
		const { code, out } = run(deployed, { HOME: home, INSTALL_WORKFLOW_TOOLS_REPO_DIR: REPO_ROOT });

		expect(code, out).toBe(0);
		expect(fs.readFileSync(deployed, "utf8")).toBe(INSTALLER_SRC);
		expect((fs.statSync(deployed).mode & 0o111) !== 0).toBe(true);
		// Sanity: the run wasn't a no-op that skipped everything else either.
		expect(fs.existsSync(path.join(bin, "pr-open"))).toBe(true);
	});

	test("bare-name self-invocation with no override falls back to ~/git-projects/princess-pi-packages", () => {
		const home = freshHome();
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin, { recursive: true });

		// Fixture clone at the canonical fallback location, so resolve_repo_dir
		// finds a repo without any env override and without touching the real
		// host's ~/git-projects/princess-pi-packages.
		const fixtureRepo = path.join(home, "git-projects", "princess-pi-packages");
		fs.mkdirSync(path.join(fixtureRepo, "bin"), { recursive: true });
		fs.mkdirSync(path.join(fixtureRepo, "hooks"), { recursive: true });
		// resolve_repo_dir's identity check (#267 finding) requires package.json's
		// "name" field, not just bin/+hooks/ shape — a bare bin+hooks pair is not
		// enough to prove this candidate really is the repo (that gap is what let
		// $HOME itself pass when an unrelated ~/hooks happened to exist).
		fs.writeFileSync(path.join(fixtureRepo, "package.json"), JSON.stringify({ name: "princess-pi-packages" }));
		for (const s of FIXTURE_SCRIPTS) {
			fs.copyFileSync(path.join(REPO_ROOT, "bin", s), path.join(fixtureRepo, "bin", s));
		}
		for (const h of fs.readdirSync(path.join(REPO_ROOT, "hooks")).filter((f) => f.endsWith(".sh") || f.endsWith(".py"))) {
			fs.copyFileSync(path.join(REPO_ROOT, "hooks", h), path.join(fixtureRepo, "hooks", h));
		}

		// Simulate "already deployed": drop just the installer binary at the
		// ~/bin path and invoke it directly by that path — the same $0 shape
		// bash produces for a bare-name PATH hit.
		const deployed = path.join(bin, "install-workflow-tools");
		fs.copyFileSync(INSTALLER, deployed);
		fs.chmodSync(deployed, 0o755);

		const { code, out } = run(deployed, { HOME: home, INSTALL_WORKFLOW_TOOLS_REPO_DIR: undefined });

		expect(code, out).toBe(0);
		expect(fs.existsSync(path.join(bin, "pr-open"))).toBe(true);
		expect(fs.readFileSync(deployed, "utf8")).toBe(INSTALLER_SRC);
	});

	test("identity check works with jq absent from PATH (#267 finding)", () => {
		// A valid checkout — bin/, hooks/, package.json naming this repo —
		// invoked with $0 pointing INTO it (not via INSTALL_WORKFLOW_TOOLS_REPO_DIR,
		// which would bypass is_this_repo() entirely and defeat the point of
		// this test). Before the fix, jq's absence made is_this_repo() silently
		// treat "unknown" as "not this repo" and the installer died claiming it
		// couldn't find a repo that was right there.
		const home = freshHome();
		const fixtureRepo = fs.mkdtempSync(path.join(os.tmpdir(), "iwt-no-jq-repo-"));
		fs.mkdirSync(path.join(fixtureRepo, "bin"), { recursive: true });
		fs.mkdirSync(path.join(fixtureRepo, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(fixtureRepo, "package.json"), JSON.stringify({ name: "princess-pi-packages" }));
		for (const s of FIXTURE_SCRIPTS) {
			fs.copyFileSync(path.join(REPO_ROOT, "bin", s), path.join(fixtureRepo, "bin", s));
		}
		for (const h of fs.readdirSync(path.join(REPO_ROOT, "hooks")).filter((f) => f.endsWith(".sh") || f.endsWith(".py"))) {
			fs.copyFileSync(path.join(REPO_ROOT, "hooks", h), path.join(fixtureRepo, "hooks", h));
		}

		const { code, out } = run(
			path.join(fixtureRepo, "bin", "install-workflow-tools"),
			{ HOME: home, PATH: pathWithoutJq(), INSTALL_WORKFLOW_TOOLS_REPO_DIR: undefined },
		);

		expect(code, out).toBe(0);
		expect(out).not.toContain("can't find the princess-pi-packages repo");
		expect(fs.existsSync(path.join(home, "bin", "pr-open"))).toBe(true);
		// The missing-dependency warning still fires — jq is absent, and the
		// tools this installer deploys (pr-threads, pr-merge, pr-cleanup) do
		// need it at runtime even though the installer itself no longer does.
		expect(out).toContain("jq not found on PATH");
	});

	test("identity check still rejects $HOME with jq absent from PATH", () => {
		// Reproduces the exact shape #267 originally exploited: $0 resolved to
		// ~/bin/install-workflow-tools, so dirname($0)/.. IS $HOME, and an
		// unrelated ~/hooks (no matching package.json) must still be rejected
		// — with no ~/git-projects/princess-pi-packages fallback present
		// either, so there is truly nowhere valid to land. Same jq-free PATH
		// as the previous test: proves the grep-based replacement still
		// discriminates real vs. unrelated, not just that it stopped erroring.
		const home = freshHome();
		const bin = path.join(home, "bin");
		fs.mkdirSync(bin, { recursive: true });
		fs.mkdirSync(path.join(home, "hooks"), { recursive: true }); // unrelated dir, no package.json
		const deployed = path.join(bin, "install-workflow-tools");
		fs.copyFileSync(INSTALLER, deployed);
		fs.chmodSync(deployed, 0o755);

		const { code, out } = run(deployed, { HOME: home, PATH: pathWithoutJq(), INSTALL_WORKFLOW_TOOLS_REPO_DIR: undefined });

		expect(code).toBe(1);
		expect(out).toContain("can't find the princess-pi-packages repo");
	});
});

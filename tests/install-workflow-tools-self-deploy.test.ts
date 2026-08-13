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

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const INSTALLER_SRC = fs.readFileSync(INSTALLER, "utf8");

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "iwt-self-home-"));
}

function run(
	installerPath: string,
	env: Record<string, string | undefined>,
	args: string[] = [],
): { code: number; out: string } {
	try {
		const out = execFileSync("bash", [installerPath, ...args], {
			encoding: "utf8",
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
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
		for (const s of ["git-checkpoint", "git-overview", "pr-open", "pr-merge", "pr-reject", "pr-cleanup", "pr-threads", "install-workflow-tools"]) {
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
});

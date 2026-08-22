/**
 * #421 round 2 (PR #424 review): a repo whose IDENTITY cannot be resolved must
 * fail CLOSED.
 *
 * repoKey/repo_key now key a lift on `git rev-parse --absolute-git-dir` instead
 * of on the words that named the repo. The review asked what happens when that
 * resolution fails: store and lookup then land in different namespaces, the
 * lookup misses, and `branch_of` answers with the PRE-switch branch — a lift to
 * `main` becomes invisible and the commit-on-main gate never fires. So an
 * unresolved key marks the LINE degraded, and every later miss on that line is
 * unknown — which every branch-scoped check already treats as protected.
 *
 * Both twins are exercised here rather than through
 * tests/fixtures/git-guardrails-cases.json, because that harness materialises a
 * real repo for every path it substitutes and this case needs a directory that
 * is deliberately NOT one.
 */

import { describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkGitCommand } from "../extensions/lib/git-guardrails-core";

const SH_HOOK = join(import.meta.dir, "..", "hooks", "block-dangerous-git.sh");

// Sandboxes are removed even when a suite calls process.exit on failure (#394).
const SANDBOXES: string[] = [];
process.on("exit", () => {
	for (const root of SANDBOXES.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	SANDBOXES.push(dir);
	return dir;
}

function repoOn(branch: string): string {
	const dir = sandbox("guardrail-degraded-repo-");
	execSync(`git init -q -b "${branch}"`, { cwd: dir });
	execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir });
	return dir;
}

function shVerdict(command: string, cwd: string): "allow" | "block" {
	const res = spawnSync("bash", [SH_HOOK], {
		input: JSON.stringify({ tool_input: { command, cwd } }),
		encoding: "utf8",
	});
	if (res.status === 0) return "allow";
	if (res.status === 2) return "block";
	throw new Error(`hook exited ${res.status}: ${res.stderr || res.stdout}`);
}

const tsVerdict = (command: string, cwd: string): "allow" | "block" =>
	checkGitCommand(command, cwd) === null ? "allow" : "block";

describe("#421 unresolvable repo identity fails closed", () => {
	test("a lift in a directory git cannot identify protects the rest of the line", () => {
		const cwd = repoOn("42-feat");
		const unidentifiable = sandbox("guardrail-degraded-nonrepo-");
		const command = `git -C ${unidentifiable} checkout -b 421-x && git commit -m x`;
		// Without the degraded marker both twins ALLOW this: the lift is filed
		// under the syntactic fallback key, the bare `commit` resolves its own
		// repo to an absolute git dir, misses, and reads the feature branch the
		// repo is still on. That miss is indistinguishable from the transient
		// failure that would hide a lift to main, so it is protected instead.
		expect(tsVerdict(command, cwd)).toBe("block");
		expect(shVerdict(command, cwd)).toBe("block");
	});

	test("no lift on the line means no degradation — an ordinary commit still passes", () => {
		const cwd = repoOn("42-feat");
		const unidentifiable = sandbox("guardrail-degraded-nonrepo-");
		// Same unresolvable directory, but nothing on this line lifts, so the
		// lift table stays empty and the key is never resolved at all. Protecting
		// this would over-block every line that merely mentions a non-repo path.
		const command = `git -C ${unidentifiable} status && git commit -m x`;
		expect(tsVerdict(command, cwd)).toBe("allow");
		expect(shVerdict(command, cwd)).toBe("allow");
	});

	test("the everyday create-and-commit line is untouched", () => {
		const cwd = repoOn("main");
		const command = "git --git-dir=.git checkout -b 421-y && git commit -m x";
		expect(tsVerdict(command, cwd)).toBe("allow");
		expect(shVerdict(command, cwd)).toBe("allow");
	});
});

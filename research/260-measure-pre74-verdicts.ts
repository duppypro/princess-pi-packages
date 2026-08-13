// #260 — run the frozen pre-#74 hook against all 124 fixture cases and report
// where it disagrees with the spec verdict. Measurement only; the results get
// hand-reviewed before any of them are encoded as `pre74` fields.
//
// Reuses the parity test's own materialize() logic so the branch state is
// identical — a difference here must come from the hook, not the harness.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import fixture from "../tests/fixtures/git-guardrails-cases.json";

const REPO_ROOT = join(import.meta.dir, "..");
const OLD = join(REPO_ROOT, "tests", "fixtures", "block-dangerous-git.pre-74.sh");
const NEW = join(REPO_ROOT, "hooks", "block-dangerous-git.sh");

interface Case {
	id: string;
	command: string;
	verdict: "allow" | "block";
	branch?: string;
	cwd_branch?: string;
	c_path_branch?: string;
	c_path_rel?: string;
	why: string;
}

function repoOnBranch(branch: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pre74-case-"));
	execSync(`git init -q -b "${branch}"`, { cwd: dir });
	return dir;
}
function nonRepoDir(): string {
	return mkdtempSync(join(tmpdir(), "pre74-nonrepo-"));
}
function materialize(c: Case): { command: string; cwd: string } {
	let command = c.command;
	const cwdBranch = c.cwd_branch !== undefined ? c.cwd_branch : c.branch;
	const cwd = cwdBranch ? repoOnBranch(cwdBranch) : nonRepoDir();
	if (c.c_path_branch !== undefined) {
		if (c.c_path_rel !== undefined) {
			execSync(`git init -q -b "${c.c_path_branch}" "${c.c_path_rel}"`, { cwd });
		} else {
			const cRepo = repoOnBranch(c.c_path_branch);
			command = command.replaceAll("/repo", cRepo);
		}
	}
	return { command, cwd };
}

function verdictOf(hook: string, command: string, cwd: string): string {
	const input = JSON.stringify({ tool_input: { command, cwd } });
	const res = spawnSync("bash", [hook], { input, encoding: "utf8" });
	if (res.status === 0) return "allow";
	if (res.status === 2) return "block";
	return `exit${res.status}`;
}

const cases = (fixture as { cases: Case[] }).cases;
const overBlock: Case[] = []; // spec says allow, old hook blocked
const underBlock: Case[] = []; // spec says block, old hook allowed
const weird: string[] = [];

for (const c of cases) {
	const { command, cwd } = materialize(c);
	const old = verdictOf(OLD, command, cwd);
	const cur = verdictOf(NEW, command, cwd);
	if (cur !== c.verdict) weird.push(`CURRENT HOOK DISAGREES WITH SPEC: ${c.id} (${cur} vs ${c.verdict})`);
	if (old === c.verdict) continue;
	if (old === "block" && c.verdict === "allow") overBlock.push(c);
	else if (old === "allow" && c.verdict === "block") underBlock.push(c);
	else weird.push(`${c.id}: old hook returned ${old}`);
}

console.log(`cases: ${cases.length}`);
console.log(`\n=== OVER-BLOCK (spec: allow, pre-74: block) — ${overBlock.length}`);
for (const c of overBlock) console.log(`  ${c.id}\n      ${JSON.stringify(c.command)}`);
console.log(`\n=== UNDER-BLOCK (spec: block, pre-74: allow) — ${underBlock.length}`);
for (const c of underBlock) console.log(`  ${c.id}\n      ${JSON.stringify(c.command)}`);
console.log(`\n=== ANOMALIES — ${weird.length}`);
for (const w of weird) console.log(`  ${w}`);
console.log(`\nagreed with spec: ${cases.length - overBlock.length - underBlock.length - weird.length}`);

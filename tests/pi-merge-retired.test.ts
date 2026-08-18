// --- #226: the Pi /merge command is retired, and no command face touches git ---
//
// `/merge` shipped as a Pi slash command that ran `git checkout main` → merge →
// `git push` → `git push origin --delete <branch>`. Two things made that worse
// than merely stale:
//
//   1. It contradicted the domain rule in ~/git-projects/CLAUDE.md ("Never merge
//      locally"), which every other tool in this repo enforces.
//   2. Nothing could stop it. The git guardrail is a BASH-SPAWN hook — it
//      inspects a command string on its way to a shell. A slash command handler
//      calls child_process in-process and spawns no shell, so `/merge`'s push to
//      main passed no gate in either harness.
//
// Duppy's decision (#226, 2026-08-11) was shell-first: workflow tools get no Pi
// command face at all. That closes the hole STRUCTURALLY rather than by adding a
// second guardrail for the extension surface — every git-touching invocation now
// goes through bash, where the hook can see it.
//
// This suite is what keeps that true. It is deliberately structural (file layout
// and source shape) rather than behavioural: a Pi command handler cannot be
// invoked without a live harness, so the only thing a test can pin here is that
// the surface does not exist to be invoked.
//
// Run with: bun run test pi-merge-retired

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

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

/** Every .ts under extensions/, recursively. */
function extensionSources(dir = path.join(REPO, "extensions")): string[] {
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...extensionSources(p));
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const rel = (p: string) => path.relative(REPO, p);

// Comments carry the history of what these files USED to do. Strip them before
// looking for an execution, or this suite fails on its own explanations.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

// A git MUTATION reached through child_process. Two spellings, because both
// appear in this repo: a shell string (`git push origin main`) and argv form
// (execFileSync("git", ["push", …])).
const MUTATING_VERBS = "checkout|switch|push|merge|rebase|reset|clean|cherry-pick|commit";
const GIT_SHELL_STRING = new RegExp(`git\\s+(?:-C\\s+\\S+\\s+)?(?:${MUTATING_VERBS}|branch\\s+-[dD])`);
const GIT_ARGV = new RegExp(`["'\`]git["'\`]\\s*,\\s*\\[[^\\]]*["'\`](?:${MUTATING_VERBS})["'\`]`);
const EXEC_CALL = /\b(?:execSync|execFileSync|spawnSync|execFile|spawn|exec)\s*\(/g;

/**
 * Mutating git reachable from a child_process call in this file.
 *
 * Scoped to CALL SITES rather than the whole file on purpose. An earlier cut of
 * this check stripped string literals to avoid matching quoted hint text like
 * "run 'git checkout -b'" — which also stripped the real commands, since those
 * ARE string literals. It passed a deliberate probe that pushed to main. Look
 * at what is being executed, not at what the file happens to contain.
 */
function mutatingGitCallSites(src: string): string[] {
	const code = stripComments(src);
	const hits: string[] = [];
	for (const m of code.matchAll(EXEC_CALL)) {
		const window = code.slice(m.index, m.index + 300);
		if (GIT_SHELL_STRING.test(window) || GIT_ARGV.test(window)) {
			hits.push(window.split("\n")[0].trim().slice(0, 120));
		}
	}
	return hits;
}

console.log("#226: Pi /merge is retired");

// ---
// 1. The command, its manifest, and its rendered doc are gone.
// ---
console.log("\n— the surface no longer exists");

for (const gone of [
	"extensions/merge.ts",
	"extensions/lib/merge/core.ts",
	"extensions/lib/merge",
	"docs/manifests/merge-cmd.json",
	"docs/EXT_MERGE.html",
]) {
	check(!fs.existsSync(path.join(REPO, gone)), `${gone} is deleted`);
}

// ---
// 2. No extension registers a `merge` command, and nothing imports the engine.
//    Checked across ALL extensions, not just the deleted file — the point is
//    that the command cannot come back by another route.
// ---
console.log("\n— no command face, by any route");

const sources = extensionSources();
const registrars = sources.filter((f) =>
	/registerCommand\(\s*["'`]merge["'`]/.test(fs.readFileSync(f, "utf8")),
);
check(registrars.length === 0, "no extension registers a 'merge' command", registrars.map(rel).join("\n"));

const importers = sources.filter((f) => /runMerge|lib\/merge\//.test(fs.readFileSync(f, "utf8")));
check(importers.length === 0, "no extension imports runMerge or lib/merge/", importers.map(rel).join("\n"));

// ---
// 3. The structural guarantee: no extension MUTATES git in-process.
//
//    This is the assertion that makes shell-first mean something. Reads are
//    fine — they cannot violate a branch rule. Mutations are what the bash
//    guardrail exists to catch and what an in-process call would slip past.
// ---
console.log("\n— no extension mutates git in-process");

// git-guardrails-core.ts is the one file that legitimately contains these verbs
// in live code: it PARSES bash command strings to decide whether to block them.
// Its own only execution is `git show-ref --verify`, a read. An allowlist rather
// than a carve-out in the regex, so a NEW file doing the same thing has to be
// added here deliberately, in a diff someone reviews.
// git-guardrails-core.ts is the one file that legitimately executes git while
// deciding whether to block a command — and its only execution is
// `git show-ref --verify`, a read, so it is expected to hold ZERO mutating call
// sites. An allowlist rather than a carve-out in the regex, so a NEW file doing
// this has to be added here deliberately, in a diff someone reviews.
const MUTATION_ALLOWLIST = new Set<string>([]);

const mutators: string[] = [];
for (const f of sources) {
	if (MUTATION_ALLOWLIST.has(rel(f))) continue;
	for (const hit of mutatingGitCallSites(fs.readFileSync(f, "utf8"))) {
		mutators.push(`${rel(f)}: ${hit}`);
	}
}
check(
	mutators.length === 0,
	"no extension executes a mutating git command in-process",
	mutators.join("\n"),
);

// Guard against the check silently going blind: it must still SEE a violation.
// Without this, a regex that stopped matching anything would read as a clean
// codebase — which is exactly how the first cut of this suite passed a probe
// that pushed to main.
const PROBE = [
	'execSync(`git push origin main`);',
	'execFileSync("git", ["checkout", "main"]);',
	'execSync("git -C /tmp/x reset --hard");',
].join("\n");
check(
	mutatingGitCallSites(PROBE).length === 3,
	"the detector still catches a known-bad probe (shell, argv, and -C forms)",
	`caught ${mutatingGitCallSites(PROBE).length} of 3`,
);

// A read must NOT trip it, or the allowlist grows to hide false positives.
check(
	mutatingGitCallSites('execSync(`git show-ref --verify --quiet ${ref}`);').length === 0,
	"a git READ does not trip the detector",
);

// ---
// 4. What SURVIVED the delete, and why.
//
//    `lib/merge/help.ts` was never merge-specific — it renders --help/--why from
//    a manifest, and yada, serve and wtft all go through it. It outlived the tool
//    it was named after, so it moved to a name that says what it does. Without
//    this check the rename is invisible and the next reader deletes it as
//    leftover merge code.
// ---
console.log("\n— the shared manifest renderer survived, under an honest name");

const HELPER = "extensions/lib/manifest-help.ts";
check(fs.existsSync(path.join(REPO, HELPER)), `${HELPER} exists`);

const CONSUMERS = [
	"bin/yada.ts",
	"extensions/serve.ts",
	"extensions/lib/wtft-cli-shared.ts",
];
for (const c of CONSUMERS) {
	const src = fs.readFileSync(path.join(REPO, c), "utf8");
	check(/manifest-help/.test(src), `${c} imports the renderer by its new path`);
	check(!/lib\/merge\/help|merge\/help\.js/.test(src), `${c} has no stale lib/merge/help path`);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #226: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

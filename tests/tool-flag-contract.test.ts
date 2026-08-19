// The flag contract: what a tool implements, and where that is written down.
//
// Two issues, one mechanical suite, because they are the same question asked from
// both ends:
//
//   #363 — every flag a shipped script IMPLEMENTS must appear in a readable
//          artifact. The `--version` class: #178 added `--version` to 12 scripts
//          and documented it nowhere, and nothing counted that for months.
//   #365 — every flag a readable artifact REQUIRES must be implemented by the
//          tools it claims to govern. `docs/agents/tool-conventions.md` mandated
//          `--why` for "every tool"; 11 of 12 shell scripts had never had one.
//
// The bar this suite sets is deliberately mechanical, per #363's own argument:
// "a violation is countable here." No model, no judgement, no prose review — a
// flag either appears in the artifact or it does not.
//
// KNOWN LIMIT, stated because a silent one reads as coverage (macroscopeapp, PR
// #371): the two classes are NOT checked to the same depth. Workflow scripts get
// both directions per flag. Manifest-backed commands get only the roster and
// `--why` — nothing here proves a manifest flag is implemented, or that an
// implemented flag reached its manifest, because that means parsing the
// TypeScript. A new or undocumented flag on serve/wtft/yada passes this suite.
//
// WHY BOTH DIRECTIONS. A one-way check invites the wrong fix. Checking only
// "implemented ⇒ documented" lets someone delete a flag from the code to satisfy
// it; checking only "documented ⇒ implemented" lets someone delete the sentence.
// Requiring both makes the cheapest way to green be the correct one: keep them
// in agreement.
//
// Run with: bun run test tool-flag-contract

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(REPO_ROOT, "bin");
const MANIFESTS = path.join(REPO_ROOT, "docs/manifests");
const SPEC_PATH = path.join(REPO_ROOT, "docs/dev-workflow-spec.md");
const CONVENTIONS_PATH = path.join(REPO_ROOT, "docs/agents/tool-conventions.md");

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

/** Shipped shell scripts: executable, directly in bin/, not generated or source. */
function shippedScripts(): string[] {
	return fs
		.readdirSync(BIN)
		.filter((n) => !n.startsWith(".") && !n.endsWith(".mjs") && !n.endsWith(".ts") && !n.endsWith(".json"))
		.filter((n) => {
			const st = fs.lstatSync(path.join(BIN, n));
			return !st.isSymbolicLink() && st.isFile() && (st.mode & 0o111) !== 0;
		})
		.sort();
}

/**
 * Flags a script implements, read from its `case` arms.
 *
 * Takes everything before the first `)` on a line, splits on `|`, and keeps only
 * whole tokens shaped like a flag. That drops `-*)`, `--)`, `*)`, `"")` and the
 * non-flag arms of unrelated `case` statements (`DIRTY|DRAFT)`), and it cannot be
 * fooled by prose inside a heredoc, because a help line like
 * `git diff --stat (unstaged only)` yields one token with spaces in it.
 *
 * Parsing source rather than probing behaviour is deliberate: probing can only
 * find flags you already thought to try, which is the exact blind spot that let
 * `--version` ship undocumented on 12 scripts.
 */
function implementedFlags(script: string): string[] {
	const src = fs.readFileSync(path.join(BIN, script), "utf8");
	const flags = new Set<string>();
	for (const line of src.split("\n")) {
		const m = line.match(/^\s*([^)]*)\)/);
		if (!m) continue;
		for (const raw of m[1].split("|")) {
			const f = raw.trim();
			if (/^--?[A-Za-z][A-Za-z0-9-]*$/.test(f)) flags.add(f);
		}
	}
	return [...flags].sort();
}

function helpText(script: string): string {
	const r = spawnSync(path.join(BIN, script), ["--help"], { encoding: "utf8", timeout: 15_000 });
	return `${r.stdout || ""}`;
}

const SCRIPTS = shippedScripts();
const SPEC = fs.readFileSync(SPEC_PATH, "utf8");
const CONVENTIONS = fs.readFileSync(CONVENTIONS_PATH, "utf8");

console.log(`tool flag contract (#363 implemented⇒documented, #365 documented⇒implemented) — ${SCRIPTS.length} scripts`);

// --- #363: every implemented flag is documented ------------------------------
// Two artifacts, two different jobs:
//   its own --help — the artifact a reader reaches from the command line, and
//     the only one that is per-script exact.
//   docs/dev-workflow-spec.md — the artifact a reader reaches from the repo.
//     Checked as a whole-file floor rather than per-row: every script-specific
//     flag name here is unique across the family, so a hit is that script's row
//     in practice, while the family-wide flags are covered by the family
//     paragraph exactly once, which is where they belong.
console.log("\n#363 — implemented ⇒ documented");
for (const s of SCRIPTS) {
	const flags = implementedFlags(s);
	check(flags.length > 0, `${s} → flags extracted from its case arms`,
		"extracted none; the parser found no flag arms, which means this whole check is vacuous for this script");
	const help = helpText(s);
	for (const f of flags) {
		check(help.includes(f), `${s} --help names ${f}`,
			`the flag is implemented and the script's own help never mentions it — the #178 --version class`);
		check(SPEC.includes(f), `docs/dev-workflow-spec.md names ${f} (${s})`,
			"implemented, and absent from the spec a reader browses instead of the source");
	}
}

// --- #365: every required flag is implemented --------------------------------
// Road 2 (Duppy, 2026-08-18): `--why` is scoped to manifest-backed tools. The
// conventions page used to mandate it for "every tool", which was false for all
// 12 shell scripts — and `--why` answers "why would I run this", which the spec's
// Scripts table already answers once per script. A second copy is the drift
// generator #365 is about.
console.log("\n#365 — documented ⇒ implemented");

const manifestTools = fs
	.readdirSync(MANIFESTS)
	.filter((n) => n.endsWith("-cmd.json"))
	.map((n) => n.replace(/-cmd\.json$/, ""))
	.sort();

check(manifestTools.length > 0, "manifest-backed tools discovered", "docs/manifests/ has no *-cmd.json");

// The page must name its roster, and the roster must be the manifests on disk.
// This is what makes the scoped claim countable instead of merely softer: adding
// a manifest without listing it here, or listing a tool with no manifest, fails.
for (const t of manifestTools) {
	check(CONVENTIONS.includes(`\`${t}\``), `tool-conventions.md names ${t} in its manifest-backed roster`,
		"a manifest exists on disk that the conventions page's roster does not list");
	const manifest = JSON.parse(fs.readFileSync(path.join(MANIFESTS, `${t}-cmd.json`), "utf8"));
	check(Array.isArray(manifest.why) && manifest.why.length > 0, `${t}-cmd.json has a non-empty why[]`,
		"the page requires --why of exactly this class of tool");
	const r = spawnSync(path.join(BIN, `${t}.mjs`), ["--why"], { encoding: "utf8", timeout: 30_000 });
	check(r.status === 0, `${t} --why → exit 0`, `got exit ${r.status}: ${(r.stderr || "").slice(0, 160)}`);
	check((r.stdout || "").trim().length > 0, `${t} --why → prints something`, "exit 0 with empty output");
}

// The universal claims are gone. Pinned to the exact retired sentences rather
// than to a summary, so this fails on a revert and not on a rewording that keeps
// the scope correct.
const RETIRED_CLAIMS = [
	"Every tool must support `--why`",
	"`--why` must appear in every tool's `--help` output.",
	"Every tool targets **both Pi and Claude Code**",
];
for (const claim of RETIRED_CLAIMS) {
	check(!CONVENTIONS.includes(claim), `tool-conventions.md no longer claims: ${claim.slice(0, 52)}…`,
		"the page asserts of every tool something that is false for all 12 shell scripts (#365)");
}

// And the shell family is described somewhere on that page, since #226 made it
// the MAIN line rather than the exception the page never mentioned.
check(/workflow scripts?/i.test(CONVENTIONS) && CONVENTIONS.includes("--why"),
	"tool-conventions.md states what workflow shell scripts ship instead",
	"scoping the claim without saying what the other class does leaves the reader where they started");

// A shell script implementing `--why` is permitted, not required — `repo-gate`
// has one. Asserted so that "permitted" is a fact about the suite, not a hope:
// the #363 loop above already demands it be documented like any other flag.
const withWhy = SCRIPTS.filter((s) => implementedFlags(s).includes("--why"));
check(withWhy.every((s) => helpText(s).includes("--why")),
	`shell scripts implementing --why document it (${withWhy.join(", ") || "none"})`,
	"optional does not mean undocumented");

console.log(`\n${failures === 0 ? "✅" : "❌"} tool flag contract: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

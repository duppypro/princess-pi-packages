/**
 * The docs claim controls; this asserts the controls exist (#228).
 *
 * The drift this catches is the one that opened #228: `docs/dev-workflow-spec.md`
 * and `bin/pr-threads` both stated that the server ruleset requires review threads
 * to be resolved before merging, while `required_review_thread_resolution` was
 * `false`. The spec then taught `--admin` as the remedy for a block that could not
 * occur. Nothing detected that for months, because nothing could: a claim written
 * in prose about a setting stored on GitHub has no checker unless someone writes
 * one.
 *
 * So each row below is a claim SOMEONE MADE IN A FILE, paired with the live value
 * it asserts. Both directions are checked:
 *
 *   - the live setting matches the claim — the ruleset was not quietly loosened;
 *   - the file still makes the claim — a row whose `citation` no longer appears in
 *     its file fails, so deleting the prose without deleting the check is caught
 *     too. A test asserting a promise nobody makes any more is dead weight that
 *     reads as coverage.
 *
 * Skips honestly (`##SKIP##`, tests/lib/skips.ts) when `gh` is missing,
 * unauthenticated, or offline — which is every CI runner and every fresh laptop.
 * A green run here means "the claims were checked", and when it skips the run says
 * so out loud rather than passing quietly.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { skip } from "./lib/skips.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REPO = "duppypro/princess-pi-packages";
const RULESET_ID = "18684693";

// ---
// The claims
// ---

interface Claim {
	/** What the file promises, in one line. */
	claim: string;
	/** The file that promises it. */
	file: string;
	/** A substring that must still appear in that file. */
	citation: string;
	/** Read the live value out of the ruleset payload. */
	actual: (ruleset: any) => unknown;
	expected: unknown;
}

const prRule = (rs: any) => rs.rules?.find((r: any) => r.type === "pull_request")?.parameters ?? {};
const hasRule = (rs: any, type: string) => (rs.rules ?? []).some((r: any) => r.type === type);
const statusRule = (rs: any) => rs.rules?.find((r: any) => r.type === "required_status_checks")?.parameters ?? {};
const requiredCheck = (rs: any, context: string) =>
	(statusRule(rs).required_status_checks ?? []).find((c: any) => c.context === context);

const CLAIMS: Claim[] = [
	{
		claim: "the ruleset is switched on at all",
		file: "docs/dev-workflow-spec.md",
		citation: "The repository ruleset requires review threads to be resolved before merging",
		actual: rs => rs.enforcement,
		expected: "active",
	},
	{
		claim: "review threads must be resolved before merging",
		file: "bin/pr-threads",
		citation: "required_review_thread_resolution",
		actual: rs => prRule(rs).required_review_thread_resolution,
		expected: true,
	},
	// WITHDRAWN by #349. pr-merge used to tell the caller that
	// required_review_thread_resolution "will refuse this merge too" whenever
	// pr-threads exited 1 — including when zero threads were unresolved and the
	// only finding was a stale review, which that rule says nothing about. The
	// claim was true of the ruleset and false of the PR in front of it, which is
	// the worst kind: it told the caller not to attempt a merge the server would
	// have accepted. pr-merge now reads mergeStateStatus and quotes the server
	// instead of predicting it, so there is no such promise left to guard.
	// The rule itself is still asserted above, via bin/pr-threads.
	{
		claim: "merges go through a pull request — 'never merge locally' is enforced, not just written",
		file: "docs/dev-workflow-spec.md",
		citation: '"never merge locally" means the workflow does not produce that state',
		actual: rs => hasRule(rs, "pull_request"),
		expected: true,
	},
	{
		claim: "squash is an allowed merge method (pr-merge runs `gh pr merge --squash`)",
		file: "bin/pr-merge",
		citation: "--squash",
		actual: rs => (prRule(rs).allowed_merge_methods ?? []).includes("squash"),
		expected: true,
	},
	{
		claim: "history is append-only — no force-push to the default branch",
		file: "docs/dev-workflow-spec.md",
		citation: "ruleset",
		actual: rs => hasRule(rs, "non_fast_forward"),
		expected: true,
	},

	// --- CI as a merge gate (#228). Added once the rule was live, so that the
	// requirement is itself checked. A required check nobody verifies is the same
	// shape as the unenforced ruleset bit this whole issue was opened about.
	{
		claim: "CI is REQUIRED, not merely reported — the merge button waits on it",
		file: "docs/dev-workflow-spec.md",
		citation: "check** on ruleset `18684693`, so the merge button is unavailable until it passes",
		actual: rs => hasRule(rs, "required_status_checks"),
		expected: true,
	},
	{
		claim: "the required check is the workflow this repo actually ships",
		// Cited against the WORKFLOW, not prose: renaming `name:` in test.yml
		// silently orphans the ruleset's context and the gate goes permanently
		// pending. This is the row that catches that rename.
		file: ".github/workflows/test.yml",
		citation: "name: test",
		actual: rs => Boolean(requiredCheck(rs, "test")),
		expected: true,
	},
	{
		claim: "only GitHub Actions can satisfy the gate — no other app can report a green `test`",
		file: "docs/dev-workflow-spec.md",
		citation: "pinned to the **GitHub Actions** app (`integration_id` 15368)",
		actual: rs => requiredCheck(rs, "test")?.integration_id,
		expected: 15368,
	},
	{
		claim: "branches must be up to date before merging, so CI ran against the merged content",
		file: "docs/dev-workflow-spec.md",
		citation: "strict_required_status_checks_policy",
		actual: rs => statusRule(rs).strict_required_status_checks_policy,
		expected: true,
	},
];

// ---
// Live read
// ---

function readRuleset(): { ruleset?: any; skipReason?: string } {
	const env = Object.fromEntries(
		// A stale GH_TOKEN shadows working keyring auth and `gh` never falls back to
		// it, so both are unset here rather than left to decide the outcome.
		Object.entries(process.env).filter(([k]) => k !== "GH_TOKEN" && k !== "GITHUB_TOKEN"),
	) as NodeJS.ProcessEnv;

	// tests/run.ts hands every suite a fresh empty XDG_CONFIG_HOME so no developer
	// config can reach the code under test (#158). `gh` keeps its credentials under
	// $XDG_CONFIG_HOME/gh, so that isolation also hides them and this suite skipped
	// under `bun run test` while passing under `bun test <file>`. Point gh at the
	// real directory: its credentials are exactly the host state this suite exists
	// to read, and nothing else here goes near XDG.
	env.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), ".config", "gh");

	const gh = spawnSync("gh", ["api", `repos/${REPO}/rulesets/${RULESET_ID}`], {
		encoding: "utf8",
		env,
		timeout: 30_000,
	});

	if (gh.error && (gh.error as any).code === "ENOENT") return { skipReason: "`gh` is not installed" };
	if (gh.status !== 0) {
		const why = `${gh.stderr ?? ""}`.trim().split("\n")[0] || `gh exited ${gh.status}`;
		return { skipReason: `cannot read ruleset ${RULESET_ID} (${why})` };
	}
	try {
		return { ruleset: JSON.parse(gh.stdout) };
	} catch {
		return { skipReason: "gh returned output that is not JSON" };
	}
}

// ---
// Tests
// ---

describe("every ruleset claim in the docs is still true", () => {
	// The citation half needs no network, so it runs unconditionally. A claim
	// deleted from its file is caught on a laptop with no gh at all.
	for (const c of CLAIMS) {
		it(`${c.file} still claims: ${c.claim}`, () => {
			const src = fs.readFileSync(path.join(REPO_ROOT, c.file), "utf8");
			assert.ok(src.includes(c.citation),
				`${c.file} no longer contains "${c.citation}".\n` +
				`  If the claim was withdrawn on purpose, delete its row from CLAIMS here too — ` +
				`a check guarding a promise nobody makes reads as coverage and is not.`);
		});
	}

	const { ruleset, skipReason } = readRuleset();

	it("the live ruleset is reachable", () => {
		if (skipReason) {
			skip(`no live ruleset check — ${skipReason}; ${CLAIMS.length} documented controls went unverified`);
			return;
		}
		assert.ok(ruleset, "expected a ruleset payload");
	});

	for (const c of CLAIMS) {
		it(`live: ${c.claim}`, () => {
			if (!ruleset) return; // already reported by the reachability check above
			assert.deepStrictEqual(c.actual(ruleset), c.expected,
				`${c.file} claims "${c.claim}", but ruleset ${RULESET_ID} disagrees.\n` +
				`  Either the ruleset was loosened (fix the ruleset) or the claim is stale (fix the doc).\n` +
				`  Do not "fix" this by deleting the assertion.`);
		});
	}
});

console.log("✅ All ruleset-claim tests passed.");

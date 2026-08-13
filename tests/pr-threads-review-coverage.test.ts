// --- pr-threads: review coverage of the current head (#254) ---
//
// Same harness as tests/pr-threads-count.test.ts and pr-threads-json.test.ts:
// real bin/pr-threads, a stub `gh` on PATH serving fixture GraphQL responses.
// This suite drives the NEW half of the query — headRefOid and reviews — that
// the older suites' fixtures never populate (proving, incidentally, that this
// work stayed backward compatible: those suites still pass unmodified).
//
// The defect this closes: zero unresolved threads is two different states
// wearing one output — "reviewer looked at the current head and had nothing
// to say" vs "reviewer has never seen the current head". Observed live on
// dotfiles-doctor#11: a bot reviewed the first commit, findings were fixed
// and threads resolved, and no review ever landed against the new head — yet
// pr-threads printed the ✅ that authorizes a merge.
//
// Advisory-vs-blocking decision (the open question #254 left for this work):
//   - NO review has EVER been submitted on the PR → advisory. Printed with
//     ℹ️, exit 0. Rationale: a repo with no review bot installed would
//     otherwise have EVERY PR stuck non-zero forever — that's the "nothing
//     reviews this repo" case the issue explicitly says not to punish.
//   - At least one review exists, but NONE of them targets the current head
//     → blocking. Printed with ⚠️, exit 1, no ✅. This is the dotfiles-doctor
//     case: a reviewer plainly exists and plainly hasn't looked at what's
//     about to merge, and #210's fail-closed rule treats "checked, found
//     stale" as a determined bad state, not an indeterminate one to wave
//     through.
//
// Run with: bun run test pr-threads-review-coverage

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_THREADS = path.join(REPO_ROOT, "bin", "pr-threads");

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

// ---
// Fixtures — recorded-shape GraphQL responses, no live PR needed.
// ---

interface FixtureOpts {
	headRefOid?: string;
	/** commit oids of reviews that have been submitted, in submission order */
	reviewCommits?: string[];
	/** commit oids of PENDING (unsubmitted draft) reviews — submittedAt: null */
	pendingReviewCommits?: string[];
	unresolvedThreads?: number;
	totalThreads?: number;
	/** omit reviews/headRefOid entirely — the pre-#254 fixture shape */
	legacy?: boolean;
}

function page(opts: FixtureOpts = {}): string {
	const unresolved = opts.unresolvedThreads ?? 0;
	const total = opts.totalThreads ?? unresolved;
	const nodes = Array.from({ length: total }, (_, i) => ({
		id: `T${i}`,
		isResolved: i >= unresolved,
		isOutdated: false,
		path: `bin/file${i}.ts`,
		line: 1,
		comments: {
			nodes: [
				{
					path: `bin/file${i}.ts`,
					url: `https://github.com/o/r/pull/1#discussion_r${i}`,
					body: "finding",
					createdAt: "2026-08-12T00:00:00Z",
					authorAssociation: "NONE",
					author: { login: "macroscopeapp" },
				},
			],
		},
	}));

	const pullRequest: any = {
		reviewThreads: {
			totalCount: total,
			pageInfo: { hasNextPage: false, endCursor: null },
			nodes,
		},
	};
	if (!opts.legacy) {
		pullRequest.headRefOid = opts.headRefOid ?? "head0000";
		pullRequest.reviews = {
			nodes: [
				...(opts.reviewCommits ?? []).map((oid, i) => ({
					commit: { oid },
					submittedAt: `2026-08-1${i}T00:00:00Z`,
				})),
				...(opts.pendingReviewCommits ?? []).map((oid) => ({
					commit: { oid },
					submittedAt: null,
				})),
			],
		};
	}

	return JSON.stringify({ data: { repository: { pullRequest } } });
}

function stubGh(dir: string, pages: string[]): string {
	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir, { recursive: true });
	pages.forEach((p, i) => fs.writeFileSync(path.join(dir, `page${i}.json`), p));
	const counter = path.join(dir, "callcount");
	fs.writeFileSync(counter, "0");
	const gh = `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "graphql" ]; then
    n=$(cat ${JSON.stringify(counter)})
    echo $((n + 1)) > ${JSON.stringify(counter)}
    cat ${JSON.stringify(dir)}/page$n.json
    exit 0
  fi
done
echo "duppypro/princess-pi-packages"
`;
	const p = path.join(binDir, "gh");
	fs.writeFileSync(p, gh);
	fs.chmodSync(p, 0o755);
	return binDir;
}

function runPrThreads(pages: string[], args: string[] = ["1"]): { code: number; out: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-threads-coverage-"));
	const binDir = stubGh(dir, pages);
	try {
		const out = execFileSync("bash", [PR_THREADS, ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

function parse(out: string): any {
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

// ---
// Cases
// ---

console.log("pr-threads: review coverage of the current head (#254)");

// 1. Review predates head (the dotfiles-doctor#11 shape): warn, no ✅, block.
console.log("\nreview predates head (blocking):");
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: ["1284eaf"], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code !== 0, "stale review → non-zero", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "stale review → does NOT print the authorizing ✅", out);
	check(out.includes("fa8a8fb"), "stale review → names the current head", out);
	check(out.includes("1284eaf"), "stale review → names the latest (stale) review commit", out);
}

// 2. Review at head, zero unresolved: clean.
console.log("\nreview covers head, zero unresolved (clean):");
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: ["fa8a8fb"], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "review at head → exit 0", `got ${code}, output:\n${out}`);
	check(out.includes("✅"), "review at head → prints ✅", out);
}

// 3. Zero reviews ever: advisory, not a permanent false alarm.
console.log("\nno reviews at all (advisory, does not block):");
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: [], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "no reviews ever → exit 0 (advisory, not blocking)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "no reviews ever → withholds the authorizing ✅ (head genuinely unreviewed)", out);
	check(/no review/i.test(out), "no reviews ever → says so plainly", out);
}

// 3b. PENDING (unsubmitted draft) review at head, no submitted reviews at
//     all: the GraphQL reviews connection returns drafts to their own author
//     with submittedAt: null. Must NOT count as coverage — a bot's own
//     unpublished draft is not a review anyone (including a human) can see.
//     Falls back to the same "no reviews recorded" advisory as case 3, not a
//     false "reviewedHead: true".
console.log("\nPENDING draft review at head, nothing submitted (advisory, not covered):");
{
	const p = page({ headRefOid: "fa8a8fb", pendingReviewCommits: ["fa8a8fb"], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "pending draft only → exit 0 (advisory, not blocking)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "pending draft only → withholds the authorizing ✅", out);
	check(/no review/i.test(out), "pending draft only → treated as 'no reviews recorded'", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.reviewedHead === false, "pending draft only --json → reviewedHead: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === null, "pending draft only --json → latestReviewCommit: null (draft excluded)", JSON.stringify(doc));
}

// 3c. PENDING draft at head ALONGSIDE a genuine stale submitted review: the
//     draft must not paper over the fact that the submitted review is stale —
//     still blocks, and latestReviewCommit names the submitted one, not the draft.
console.log("\nPENDING draft at head PLUS a stale submitted review (still blocks):");
{
	const p = page({
		headRefOid: "fa8a8fb",
		reviewCommits: ["1284eaf"],
		pendingReviewCommits: ["fa8a8fb"],
		unresolvedThreads: 0,
	});
	const { code, out } = runPrThreads([p]);
	check(code !== 0, "draft + stale submitted review → non-zero (still blocks)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "draft + stale submitted review → does NOT print the authorizing ✅", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.reviewedHead === false, "draft + stale submitted → reviewedHead: false", JSON.stringify(doc));
	check(
		doc?.latestReviewCommit === "1284eaf",
		"draft + stale submitted → latestReviewCommit is the SUBMITTED review, not the draft",
		JSON.stringify(doc),
	);
}

// 4. Unresolved threads AND a stale review together: still blocks, still
//    reports both, thread listing untouched by the coverage addition.
console.log("\nunresolved threads AND stale review together:");
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: ["1284eaf"], unresolvedThreads: 2, totalThreads: 2 });
	const { code, out } = runPrThreads([p]);
	check(code !== 0, "both problems → non-zero", `got ${code}, output:\n${out}`);
	check(/\b2 unresolved conversation\(s\)/.test(out), "both problems → still reports thread count", out);
	check(out.includes("discussion_r"), "both problems → still lists thread URLs", out);
	check(/no review covers/i.test(out), "both problems → also names the coverage gap", out);
}

// 5. --json: reviewedHead correct in all three head-coverage states, and the
//    existing document shape (schema, totalCount, unresolvedCount, threads)
//    stays intact — the #232 contract this is additive to.
console.log("\n--json: reviewedHead and the existing contract:");
{
	const stale = page({ headRefOid: "aaa1111", reviewCommits: ["bbb2222"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([stale], ["1", "--json"]).out);
	check(doc?.schema === "pr-threads/list@1", "stale → schema unchanged", JSON.stringify(doc));
	check(doc?.head === "aaa1111", "stale → head is the current head sha", JSON.stringify(doc));
	check(doc?.reviewedHead === false, "stale → reviewedHead: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "bbb2222", "stale → latestReviewCommit is the stale review's sha", JSON.stringify(doc));
	check(typeof doc?.totalCount === "number", "stale → totalCount still present", JSON.stringify(doc));
	check(typeof doc?.unresolvedCount === "number", "stale → unresolvedCount still present", JSON.stringify(doc));
	check(Array.isArray(doc?.threads), "stale → threads[] still present", JSON.stringify(doc));
}
{
	const clean = page({ headRefOid: "aaa1111", reviewCommits: ["aaa1111"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([clean], ["1", "--json"]).out);
	check(doc?.reviewedHead === true, "review at head → reviewedHead: true", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "aaa1111", "review at head → latestReviewCommit == head", JSON.stringify(doc));
}
{
	const none = page({ headRefOid: "aaa1111", reviewCommits: [], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([none], ["1", "--json"]).out);
	check(doc?.reviewedHead === false, "no reviews → reviewedHead: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === null, "no reviews → latestReviewCommit: null", JSON.stringify(doc));
}
{
	// multiple reviews: latestReviewCommit is the LAST one (submission order), not just any match.
	const multi = page({ headRefOid: "ccc3333", reviewCommits: ["aaa1111", "bbb2222"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([multi], ["1", "--json"]).out);
	check(doc?.reviewedHead === false, "multiple stale reviews → still reviewedHead: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "bbb2222", "multiple reviews → latestReviewCommit is the most recent", JSON.stringify(doc));
}

// 6. Legacy fixture shape (no headRefOid/reviews at all, as the pre-#254
//    suites still exercise): falls back to thread-only behaviour rather than
//    guessing — proves the coverage feature cannot regress the older suites.
console.log("\nlegacy fixture with no head/review data at all:");
{
	const p = page({ legacy: true, unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "legacy shape, 0 unresolved → exit 0", `got ${code}, output:\n${out}`);
	check(out.includes("✅"), "legacy shape → still prints ✅ (head unknown, not 'known uncovered')", out);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.head === null, "legacy shape --json → head: null", JSON.stringify(doc));
	check(doc?.reviewedHead === false, "legacy shape --json → reviewedHead: false (not true, not unknown)", JSON.stringify(doc));
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-threads review coverage: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);

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
	/**
	 * count of SUBMITTED reviews whose `commit` is null (macroscopeapp finding
	 * on PR #267): the review happened but which commit it covers cannot be
	 * resolved — a force-pushed-over or GC'd object, typically.
	 */
	nullCommitReviews?: number;
	unresolvedThreads?: number;
	totalThreads?: number;
	/** omit reviews/headRefOid entirely — the pre-#254 fixture shape */
	legacy?: boolean;
	/**
	 * A response that carries `reviews` and `reviewThreads` normally but is
	 * missing `headRefOid` from the payload entirely (#258 macroscopeapp
	 * follow-up, rated High) — an incomplete/malformed GraphQL response, not
	 * the `legacy` all-fields-omitted shape above. Distinguishes "the whole
	 * head-coverage feature never shipped in this fixture" (legacy) from "the
	 * feature shipped, and THIS ONE response is missing the field it needs".
	 */
	noHeadRefOid?: boolean;
	/** Same defect, but `headRefOid` is present as explicit JSON `null` rather than omitted. */
	headRefOidNull?: boolean;
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
		if (opts.noHeadRefOid) {
			// key omitted entirely
		} else if (opts.headRefOidNull) {
			pullRequest.headRefOid = null;
		} else {
			pullRequest.headRefOid = opts.headRefOid ?? "head0000";
		}
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
				...Array.from({ length: opts.nullCommitReviews ?? 0 }, (_, i) => ({
					commit: null,
					submittedAt: `2026-08-2${i}T00:00:00Z`,
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

// 6. Legacy fixture shape (no headRefOid/reviews at all — the pre-#254
//    shape). The #258 macroscopeapp follow-up DELETED the old "fall back to
//    thread-only behaviour" fallback: a response with no resolvable head can
//    no longer exit 0 claiming coverage, legacy shape or not. This fixture
//    shape is kept only to prove the deletion — production and tests now
//    share the one code path, there is no longer a "tests take a different
//    branch than production" gap.
console.log("\nlegacy fixture with no head/review data at all (now indeterminate, not exit 0):");
{
	const p = page({ legacy: true, unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 5, "legacy shape, 0 unresolved → exit 5 (no fallback left)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "legacy shape → does NOT print the authorizing ✅", out);
	check(/could not determine review coverage/i.test(out), "legacy shape → names the actual problem", out);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.head === null, "legacy shape --json → head: null", JSON.stringify(doc));
	check(doc?.reviewedHead === false, "legacy shape --json → reviewedHead: false (not true, not unknown)", JSON.stringify(doc));
}

// 6b. The macroscopeapp finding, reproduced precisely: reviews and review
//     threads are present and well-formed (this is NOT the legacy shape —
//     the feature's other fields all showed up), but `headRefOid` itself is
//     missing from the payload. Before this fix, `head_known=false` here
//     disabled coverage gating entirely and this exited 0 — a review DID
//     happen, but which head it covers could never be checked.
console.log("\nreview threads present, headRefOid MISSING (the reported gap):");
{
	const p = page({ noHeadRefOid: true, reviewCommits: ["deadbeef"], unresolvedThreads: 0, totalThreads: 1 });
	const { code, out } = runPrThreads([p]);
	check(code === 5, "threads present, no headRefOid → exit 5 exactly (indeterminate, not 0)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "no headRefOid → does NOT print the authorizing ✅", out);
	check(/could not determine review coverage/i.test(out), "no headRefOid → names the actual problem", out);
	check(/headRefOid/.test(out), "no headRefOid → message names the missing field", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.head === null, "no headRefOid --json → head: null", JSON.stringify(doc));
	check(doc?.reviewedHead === false, "no headRefOid --json → reviewedHead: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "deadbeef", "no headRefOid --json → latestReviewCommit still reported (a review DID happen)", JSON.stringify(doc));
}

// 6c. Same defect, but `headRefOid` present as explicit JSON null rather
//     than omitted — GraphQL can serialize a nullable scalar either way.
console.log("\nreview threads present, headRefOid explicit null:");
{
	const p = page({ headRefOidNull: true, reviewCommits: ["deadbeef"], unresolvedThreads: 0, totalThreads: 1 });
	const { code, out } = runPrThreads([p]);
	check(code === 5, "headRefOid: null → exit 5 exactly", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "headRefOid: null → does NOT print the authorizing ✅", out);
}

// 6d. Unresolved threads AND missing headRefOid together: the determined bad
//     state (unresolved threads) still wins the exit code (1), same
//     precedence already proven for unresolved+indeterminate in case 8e —
//     but the coverage warning is still surfaced, not silently dropped.
console.log("\nunresolved threads AND headRefOid missing together:");
{
	const p = page({ noHeadRefOid: true, reviewCommits: ["deadbeef"], unresolvedThreads: 1, totalThreads: 1 });
	const { code, out } = runPrThreads([p]);
	check(code === 1, "unresolved threads dominate even when head is also missing → exit 1 exactly", `got ${code}, output:\n${out}`);
	check(/\b1 unresolved conversation\(s\)/.test(out), "unresolved + no headRefOid → still reports thread count", out);
	check(/could not determine|headRefOid/i.test(out), "unresolved + no headRefOid → still surfaces the coverage warning", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.unresolvedCount === 1, "unresolved + no headRefOid --json → unresolvedCount: 1", JSON.stringify(doc));
	check(doc?.head === null, "unresolved + no headRefOid --json → head: null", JSON.stringify(doc));
}

// 7. >100 reviews on a PR (#267 finding, rated High): `reviews` is fetched
//    without cursor pagination, so which ~100 reviews the GraphQL API hands
//    back depends entirely on `first:` vs `last:` in the query — this stub
//    harness can't execute that query text, so each case below feeds the
//    fixture EXACTLY what the real API would return under each argument,
//    to isolate the effect of that one choice.
//
// The GraphQL `reviews` connection returns submissions oldest-first. Any
// review covering the CURRENT head must have been submitted at or after that
// head was pushed, so it cannot be older than reviews of every prior head —
// making it impossible for a head-covering review to be excluded by `last:
// 100` (the newest 100) under normal (non-force-push) operation, while
// `first: 100` (the oldest 100) drops it the moment total reviews exceed 100.
console.log("\n>100 reviews on the PR (#267):");
{
	// 150 reviews submitted over the PR's life; the current head's covering
	// review is the very last one submitted (index 149, the common case: the
	// most recent push got the most recent review).
	const allCommits = Array.from({ length: 150 }, (_, i) => `c${String(i).padStart(4, "0")}`);
	const headSha = allCommits[149];

	// 7a. What `reviews(first: 100)` (the OLD, buggy query) would have hand
	//     back: the oldest 100 — commit index 149 is not among them. This is
	//     the reported defect reproduced: a review DOES cover the current
	//     head, but the query never even fetched it, so pr-threads reports no
	//     coverage and blocks a merge that should be clean.
	const firstHundred = page({ headRefOid: headSha, reviewCommits: allCommits.slice(0, 100), unresolvedThreads: 0 });
	{
		const { code, out } = runPrThreads([firstHundred]);
		check(
			code !== 0,
			">100 reviews, head covered but only oldest 100 fetched (first:100 shape) → wrongly blocks",
			`got ${code}, output:\n${out}`,
		);
		const doc = parse(runPrThreads([firstHundred], ["1", "--json"]).out);
		check(
			doc?.reviewedHead === false,
			">100 reviews, first:100 shape → reviewedHead: false (the bug: a covering review exists but wasn't in the fetched page)",
			JSON.stringify(doc),
		);
	}

	// 7b. What `reviews(last: 100)` (the FIX applied to bin/pr-threads) hands
	//     back: the newest 100 — commit index 149 IS among them (it's the
	//     newest of all). Same underlying data, same script, only the slice
	//     of the connection changes — proving `last: 100` alone resolves the
	//     defect without needing full cursor pagination.
	const lastHundred = page({ headRefOid: headSha, reviewCommits: allCommits.slice(50, 150), unresolvedThreads: 0 });
	{
		const { code, out } = runPrThreads([lastHundred]);
		check(
			code === 0,
			">100 reviews, head covered and newest 100 fetched (last:100 shape) → correctly clean",
			`got ${code}, output:\n${out}`,
		);
		check(out.includes("✅"), ">100 reviews, last:100 shape → prints the authorizing ✅", out);
		const doc = parse(runPrThreads([lastHundred], ["1", "--json"]).out);
		check(doc?.reviewedHead === true, ">100 reviews, last:100 shape → reviewedHead: true", JSON.stringify(doc));
		check(doc?.latestReviewCommit === headSha, ">100 reviews, last:100 shape → latestReviewCommit is the head", JSON.stringify(doc));
	}

	// 7c. Sanity check on the actual deployed query: confirms bin/pr-threads
	//     itself asks for `last: 100`, not `first: 100` — a source-text pin so
	//     a future edit can't silently revert the fix while 7a/7b keep passing
	//     against hand-fed fixtures that no longer reflect what the script
	//     really requests.
	const src = fs.readFileSync(PR_THREADS, "utf8");
	check(/reviews\(last:\s*100\)/.test(src), "bin/pr-threads requests reviews(last: 100), not first:100", src.match(/reviews\([^)]*\)/)?.[0]);
}
//
// Known, deliberately unhandled edge: a force-push that REVERTS the head to
// a commit SHA already reviewed more than 100 reviews ago, with 100+ more
// reviews submitted against later heads in between. `last: 100` would miss
// that old review too — but reaching that shape requires a force-push revert
// to an old commit in a workflow that otherwise always advances forward, and
// even then the "coverage" it would have proven is a review of a stale
// snapshot from long before the intervening history. Not constructed here
// because it does not occur in this workflow (same standard this file
// already applies to the 100-comments-per-thread and 100-reviews-flat caps);
// the fix if it ever does is cursor pagination on `reviews`, not this test.

// 8. macroscopeapp finding on PR #267 (rated High): a SUBMITTED review whose
//    `commit` is null used to be silently dropped by the `.commit.oid //
//    empty` map, and if that emptied reviews_json entirely, the script took
//    the ADVISORY exit-0 path even though a review DID happen — a fail-open
//    ("could not determine coverage" reported as "nothing to determine").
//    Four states, exact exit codes per the #224 precedent this script
//    already follows (not `!== 0` — a wrong-but-nonzero code would pass that
//    assertion just as easily as the right one):
console.log("\n#267 null-commit review coverage (exact exit codes):");

// 8a. Coverage PROVEN despite a null-commit review elsewhere: some OTHER
//     submitted review has a usable oid that matches head. The null-commit
//     review must not veto proof that already exists — exit 0, unchanged.
{
	const p = page({
		headRefOid: "fa8a8fb",
		reviewCommits: ["fa8a8fb"],
		nullCommitReviews: 1,
		unresolvedThreads: 0,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 0, "proven-despite-a-null → exit 0 exactly", `got ${code}, output:\n${out}`);
	check(out.includes("✅"), "proven-despite-a-null → prints the authorizing ✅", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.reviewedHead === true, "proven-despite-a-null --json → reviewedHead: true", JSON.stringify(doc));
	check(
		doc?.nullCommitReviewCount === 1,
		"proven-despite-a-null --json → nullCommitReviewCount still reported (1)",
		JSON.stringify(doc),
	);
}

// 8b. INDETERMINATE: the only submitted review(s) have no resolvable commit,
//     and nothing else proves coverage. Distinct from both "no reviews exist"
//     (advisory, 0) and "reviews exist but none covers head" (blocking, 1) —
//     #210's undetermined-state rule says this is exit 5, never a permissive 0.
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: [], nullCommitReviews: 1, unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 5, "indeterminate (only null-commit review) → exit 5 exactly", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "indeterminate → withholds the authorizing ✅", out);
	check(!/no reviews recorded/i.test(out), "indeterminate → does NOT say 'no reviews' (one did happen)", out);
	check(
		/could not determine|indeterminate/i.test(out),
		"indeterminate → message names the actual state, not 'no reviews' or 'stale'",
		out,
	);
	check(/1 submitted review/.test(out), "indeterminate → message gives the count", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.reviewedHead === false, "indeterminate --json → reviewedHead: false", JSON.stringify(doc));
	check(doc?.nullCommitReviewCount === 1, "indeterminate --json → nullCommitReviewCount: 1", JSON.stringify(doc));
}

// 8b'. Indeterminate wins over "blocking" when BOTH a stale usable-oid review
//      AND a null-commit review exist, neither covering head: the coverage
//      question genuinely cannot be resolved from what's fetchable, so this
//      must not silently collapse into the more confident-sounding "blocked".
{
	const p = page({
		headRefOid: "fa8a8fb",
		reviewCommits: ["1284eaf"],
		nullCommitReviews: 1,
		unresolvedThreads: 0,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 5, "stale review + null-commit review → exit 5 exactly (indeterminate wins)", `got ${code}, output:\n${out}`);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.nullCommitReviewCount === 1, "stale + null-commit --json → nullCommitReviewCount: 1", JSON.stringify(doc));
}

// 8c. BLOCKING, precisely: reviews exist, all with usable oids, none matches
//     head, and no null-commit reviews at all — exit 1 exactly (this is
//     already covered loosely by case 1 above; pinned here to an EXACT code
//     alongside its 5/0 siblings so the four states are provable side by side).
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: ["1284eaf"], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 1, "blocking (stale review, no nulls) → exit 1 exactly", `got ${code}, output:\n${out}`);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.nullCommitReviewCount === 0, "blocking --json → nullCommitReviewCount: 0", JSON.stringify(doc));
}

// 8d. ADVISORY, precisely: zero submitted reviews at all, no null-commit ones
//     either — exit 0 exactly (already covered loosely by case 3; pinned here
//     to an EXACT code for the same side-by-side reason as 8c).
{
	const p = page({ headRefOid: "fa8a8fb", reviewCommits: [], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "advisory (zero reviews, no nulls) → exit 0 exactly", `got ${code}, output:\n${out}`);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.nullCommitReviewCount === 0, "advisory --json → nullCommitReviewCount: 0", JSON.stringify(doc));
}

// 8e. Unresolved threads are a determined bad state on their own — they win
//     the exit code (1) even when coverage is ALSO indeterminate, but the
//     indeterminate warning still gets printed alongside the thread listing
//     rather than silently dropped.
{
	const p = page({
		headRefOid: "fa8a8fb",
		reviewCommits: [],
		nullCommitReviews: 1,
		unresolvedThreads: 1,
		totalThreads: 1,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 1, "unresolved threads + indeterminate coverage → exit 1 exactly (threads dominate)", `got ${code}, output:\n${out}`);
	check(/\b1 unresolved conversation\(s\)/.test(out), "unresolved + indeterminate → still reports thread count", out);
	check(
		/could not|indeterminate/i.test(out),
		"unresolved + indeterminate → still surfaces the coverage warning",
		out,
	);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.unresolvedCount === 1, "unresolved + indeterminate --json → unresolvedCount: 1", JSON.stringify(doc));
	check(
		doc?.nullCommitReviewCount === 1,
		"unresolved + indeterminate --json → nullCommitReviewCount still reported",
		JSON.stringify(doc),
	);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-threads review coverage: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);

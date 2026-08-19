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
	/**
	 * Login of the PR's own author (#269). Defaults to a login that is NOT the
	 * default reviewer below, so every fixture written before #269 keeps
	 * describing an independently-reviewed PR and keeps its original verdict.
	 * `null` models a deleted/ghost account — GitHub really does return a null
	 * `author` for one, and self-authorship then cannot be decided at all.
	 */
	prAuthor?: string | null;
	/**
	 * Review authors, positionally parallel to `reviewCommits` (#269). A short
	 * list is padded with the default reviewer, so a case only has to name the
	 * authors it actually cares about. `null` at a position models a review by
	 * a deleted account.
	 */
	reviewAuthors?: (string | null)[];
}

/** The default reviewer — a third party, distinct from DEFAULT_PR_AUTHOR. */
const DEFAULT_REVIEWER = "macroscopeapp";
/** The default PR author — matches the bot that actually raises PRs here. */
const DEFAULT_PR_AUTHOR = "princess-pi-bot";

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
		// The PR's own author (#269). `null` is a real API shape (deleted
		// account), and is spelled as an explicit null node rather than an
		// omitted key because that is what GitHub returns.
		const prAuthor = opts.prAuthor === undefined ? DEFAULT_PR_AUTHOR : opts.prAuthor;
		pullRequest.author = prAuthor === null ? null : { login: prAuthor };
		const reviewAuthor = (i: number): { login: string } | null => {
			const a = opts.reviewAuthors?.[i];
			if (a === null) return null;
			return { login: a ?? DEFAULT_REVIEWER };
		};
		pullRequest.reviews = {
			nodes: [
				...(opts.reviewCommits ?? []).map((oid, i) => ({
					commit: { oid },
					submittedAt: `2026-08-1${i}T00:00:00Z`,
					author: reviewAuthor(i),
				})),
				...(opts.pendingReviewCommits ?? []).map((oid) => ({
					commit: { oid },
					submittedAt: null,
					author: { login: DEFAULT_REVIEWER },
				})),
				...Array.from({ length: opts.nullCommitReviews ?? 0 }, (_, i) => ({
					commit: null,
					submittedAt: `2026-08-2${i}T00:00:00Z`,
					author: { login: DEFAULT_REVIEWER },
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
//     false "headIsReviewed: true".
console.log("\nPENDING draft review at head, nothing submitted (advisory, not covered):");
{
	const p = page({ headRefOid: "fa8a8fb", pendingReviewCommits: ["fa8a8fb"], unresolvedThreads: 0 });
	const { code, out } = runPrThreads([p]);
	check(code === 0, "pending draft only → exit 0 (advisory, not blocking)", `got ${code}, output:\n${out}`);
	check(!out.includes("✅"), "pending draft only → withholds the authorizing ✅", out);
	check(/no review/i.test(out), "pending draft only → treated as 'no reviews recorded'", out);

	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.headIsReviewed === false, "pending draft only --json → headIsReviewed: false", JSON.stringify(doc));
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
	check(doc?.headIsReviewed === false, "draft + stale submitted → headIsReviewed: false", JSON.stringify(doc));
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

// 5. --json: headIsReviewed correct in all three head-coverage states, and the
//    existing document shape (schema, totalCount, unresolvedCount, threads)
//    stays intact — the #232 contract this is additive to.
console.log("\n--json: headIsReviewed and the existing contract:");
{
	const stale = page({ headRefOid: "aaa1111", reviewCommits: ["bbb2222"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([stale], ["1", "--json"]).out);
	check(doc?.schema === "pr-threads/list@2", "stale → schema unchanged", JSON.stringify(doc));
	check(doc?.head === "aaa1111", "stale → head is the current head sha", JSON.stringify(doc));
	check(doc?.headIsReviewed === false, "stale → headIsReviewed: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "bbb2222", "stale → latestReviewCommit is the stale review's sha", JSON.stringify(doc));
	check(typeof doc?.totalCount === "number", "stale → totalCount still present", JSON.stringify(doc));
	check(typeof doc?.unresolvedCount === "number", "stale → unresolvedCount still present", JSON.stringify(doc));
	check(Array.isArray(doc?.threads), "stale → threads[] still present", JSON.stringify(doc));
}
{
	const clean = page({ headRefOid: "aaa1111", reviewCommits: ["aaa1111"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([clean], ["1", "--json"]).out);
	check(doc?.headIsReviewed === true, "review at head → headIsReviewed: true", JSON.stringify(doc));
	check(doc?.latestReviewCommit === "aaa1111", "review at head → latestReviewCommit == head", JSON.stringify(doc));
}
{
	const none = page({ headRefOid: "aaa1111", reviewCommits: [], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([none], ["1", "--json"]).out);
	check(doc?.headIsReviewed === false, "no reviews → headIsReviewed: false", JSON.stringify(doc));
	check(doc?.latestReviewCommit === null, "no reviews → latestReviewCommit: null", JSON.stringify(doc));
}
{
	// multiple reviews: latestReviewCommit is the LAST one (submission order), not just any match.
	const multi = page({ headRefOid: "ccc3333", reviewCommits: ["aaa1111", "bbb2222"], unresolvedThreads: 0 });
	const doc = parse(runPrThreads([multi], ["1", "--json"]).out);
	check(doc?.headIsReviewed === false, "multiple stale reviews → still headIsReviewed: false", JSON.stringify(doc));
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
	check(doc?.headIsReviewed === false, "legacy shape --json → headIsReviewed: false (not true, not unknown)", JSON.stringify(doc));
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
	check(doc?.headIsReviewed === false, "no headRefOid --json → headIsReviewed: false", JSON.stringify(doc));
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
			doc?.headIsReviewed === false,
			">100 reviews, first:100 shape → headIsReviewed: false (the bug: a covering review exists but wasn't in the fetched page)",
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
		check(doc?.headIsReviewed === true, ">100 reviews, last:100 shape → headIsReviewed: true", JSON.stringify(doc));
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
	check(doc?.headIsReviewed === true, "proven-despite-a-null --json → headIsReviewed: true", JSON.stringify(doc));
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
	check(doc?.headIsReviewed === false, "indeterminate --json → headIsReviewed: false", JSON.stringify(doc));
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
// 9. #269 — the PR author's own thread REPLY is recorded by GitHub as a
//    submitted `PullRequestReview` (state COMMENTED) against the current head.
//    So the act of answering a review marked the PR reviewed-at-head, by the
//    very agent that pushed the commit under review. That is the original #254
//    defect with a second route in, and it fails OPEN against the #258 merge
//    gate.
//
//    The rule under test: a review proves coverage only if it is submitted, its
//    commit is head, AND its author is not the PR's own author. Self-authorship
//    is decided by exact login match — the same element-wise comparison the
//    `trusted` field already uses, not a substring test.
//
//    The trap this section exists to pin (named in the #268 handoff): rejecting
//    author-authored reviews WITHOUT covering the mixed case trades a fail-open
//    for a fail-closed that blocks every real merge, because the author always
//    replies. Case 9b is that mixed case and it must stay exit 0.
// ---

// 9a. The recorded PR #267 shape: a real review at an OLD commit, then two
//     self-authored replies at head. Coverage must NOT be claimed.
console.log("\n#269 — author's own thread replies do not cover head:");
{
	const p = page({
		headRefOid: "64ac251",
		reviewCommits: ["cc3bc30", "64ac251", "64ac251"],
		reviewAuthors: ["macroscopeapp", "princess-pi-bot", "princess-pi-bot"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
		totalThreads: 4,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 1, "author's replies at head → blocking, not clean (exit 1)", `got ${code}, output:\n${out}`);
	check(!/✅/.test(out), "author's replies at head → no ✅ authorizing a merge", out);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.headIsReviewed === false, "author's replies at head → --json headIsReviewed: false", JSON.stringify(doc));
	check(
		doc?.unresolvedCount === 0,
		"author's replies at head → unresolvedCount still 0 (threads and coverage stay independent)",
		JSON.stringify(doc),
	);
}

// 9b. THE MIXED CASE — the fail-closed trap. Same as 9a plus a genuine review
//     by a third party at head (what actually happened on #268). The author's
//     replies are still present and still ignored; the independent review
//     alone decides. This must stay exit 0 or every real merge is blocked.
console.log("\n#269 — an independent review at head still counts (mixed case):");
{
	const p = page({
		headRefOid: "64ac251",
		reviewCommits: ["cc3bc30", "64ac251", "64ac251", "64ac251"],
		reviewAuthors: ["macroscopeapp", "princess-pi-bot", "princess-pi-bot", "macroscopeapp"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
		totalThreads: 4,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 0, "independent review at head alongside author replies → exit 0", `got ${code}, output:\n${out}`);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.headIsReviewed === true, "mixed case → --json headIsReviewed: true", JSON.stringify(doc));
	check(
		doc?.latestReviewCommit === "64ac251",
		"mixed case → latestReviewCommit is the independent review's commit",
		JSON.stringify(doc),
	);
}

// 9c. A COMMENTED review by a third party is still coverage. Requiring
//     APPROVED/CHANGES_REQUESTED was the other direction in #269 and is
//     deliberately NOT taken: macroscopeapp's genuine first pass is COMMENTED,
//     so a verdict-state filter would report every real review as no coverage.
console.log("\n#269 — a third party's COMMENTED review is still coverage:");
{
	const p = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000"],
		reviewAuthors: ["macroscopeapp"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
	});
	const { code } = runPrThreads([p]);
	check(code === 0, "third-party COMMENTED review at head → exit 0 (no verdict-state requirement)", `got ${code}`);
}

// 9d. Only the author has ever reviewed. After exclusion there is no
//     third-party review at all, which is the SAME state as an unreviewed PR:
//     advisory, exit 0. Blocking here would resurrect the "repo with no review
//     bot has every PR stuck non-zero forever" alarm #254 ruled out — and the
//     author cannot make it green by reviewing harder.
console.log("\n#269 — only the author has ever reviewed → advisory, not blocking:");
{
	const p = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000", "head0000"],
		reviewAuthors: ["princess-pi-bot", "princess-pi-bot"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 0, "only self-reviews → advisory exit 0, no permanent false alarm", `got ${code}, output:\n${out}`);
	const doc = parse(runPrThreads([p], ["1", "--json"]).out);
	check(doc?.headIsReviewed === false, "only self-reviews → --json headIsReviewed: false (not claimed as covered)", JSON.stringify(doc));
}

// 9e. Self-authorship undecidable — the PR's `author` is null (deleted
//     account). A review at head cannot be shown independent, so coverage is
//     INDETERMINATE (exit 5), never the exit-0 clean path. #210's rule: an
//     undetermined state is not a pass.
console.log("\n#269 — undecidable authorship is indeterminate, not clean:");
{
	const p = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000"],
		reviewAuthors: ["macroscopeapp"],
		prAuthor: null,
		unresolvedThreads: 0,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 5, "null PR author + review at head → exit 5 indeterminate", `got ${code}, output:\n${out}`);
	check(code !== 0, "null PR author → never the clean exit-0 path", `got ${code}`);
}

// 9f. Same rule from the other side: the REVIEW's author is null. It cannot be
//     shown to be someone other than the PR author, so on its own it is
//     indeterminate — but a second, usable review by a known third party
//     proves coverage outright and wins, exactly as a usable review already
//     beats a null-COMMIT review (#267 partition).
console.log("\n#269 — a null-author review is indeterminate alone, moot when another review proves coverage:");
{
	const alone = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000"],
		reviewAuthors: [null],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
	});
	check(runPrThreads([alone]).code === 5, "null-author review at head, alone → exit 5 indeterminate", `got ${runPrThreads([alone]).code}`);

	const withProof = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000", "head0000"],
		reviewAuthors: [null, "macroscopeapp"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
	});
	check(runPrThreads([withProof]).code === 0, "null-author review + independent review at head → exit 0", `got ${runPrThreads([withProof]).code}`);
}

// 9g. Exact-match authorship, not substring. A login that merely CONTAINS the
//     author's login is a different account and its review is independent —
//     the same element-wise rule the `trusted` field uses. A naive
//     `case $author in *$pr_author*)` would wrongly discard this review and
//     block a legitimately reviewed PR.
console.log("\n#269 — self-authorship is an exact login match, not a substring:");
{
	const p = page({
		headRefOid: "head0000",
		reviewCommits: ["head0000"],
		reviewAuthors: ["princess-pi-bot-2"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 0,
	});
	const { code } = runPrThreads([p]);
	check(code === 0, "'princess-pi-bot-2' reviewing a 'princess-pi-bot' PR → independent, exit 0", `got ${code}`);
}

// 9h. Precedence unchanged: unresolved threads dominate the exit code, and an
//     uncovered head does not make an unresolved conversation any less
//     unresolved.
console.log("\n#269 — unresolved threads still dominate:");
{
	const p = page({
		headRefOid: "64ac251",
		reviewCommits: ["64ac251"],
		reviewAuthors: ["princess-pi-bot"],
		prAuthor: "princess-pi-bot",
		unresolvedThreads: 2,
		totalThreads: 3,
	});
	const { code, out } = runPrThreads([p]);
	check(code === 1, "unresolved threads + self-only coverage → exit 1", `got ${code}, output:\n${out}`);
	check(/\b2 unresolved conversation\(s\)/.test(out), "unresolved count still reported", out);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-threads review coverage: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);

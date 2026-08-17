// --- pr-threads --resolve: closing the review loop (#232) ---
//
// Drives the REAL bin/pr-threads with a stub `gh` first on PATH, same harness
// as pr-threads-json.test.ts and pr-threads-count.test.ts: real binary, faked
// GraphQL responses, stdout/stderr and exit code are the subject.
//
// Why this suite exists: the read side of #232 (thread ids, comment bodies,
// `trusted`) shipped in #251. Without a write side, an agent that has
// addressed a comment still has to send the human to the web UI to mark the
// thread resolved. `--resolve <thread-id>` closes that loop — it accepts the
// exact id form `--json` already emits, so the two halves compose without
// translation. `--reply <text>` posts a reply BEFORE resolving, because
// resolving silently is worse than resolving with a one-line reason.
//
// Exit-code discipline (bin/pr-threads header, #224 table): `--resolve` NEVER
// exits a bare `1` — that code is reserved for "checked, and the PR is not
// clean" (pr-merge depends on it). `--resolve` distinguishes "could not
// determine" (5 — gh/API failure) from "determined, and it says no" (6 — the
// mutation ran but the thread came back unresolved) and "not found" (4 — the
// thread id does not exist). Usage errors stay `2`.
//
// Run with: bun run test pr-threads-resolve

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
// Stub gh: each graphql invocation is served from an ordered queue of
// {status, out} responses. Every invocation's exact argv is also logged as one
// compact JSON array per line (via `jq -nc --args`), so tests can assert on
// the mutation text and the thread id / reply body actually passed — not just
// on the canned response.
// ---

interface GhCall {
	status: number;
	out: string;
}

function stubGh(dir: string, calls: GhCall[]): { binDir: string; log: string } {
	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir, { recursive: true });
	calls.forEach((c, i) => {
		fs.writeFileSync(path.join(dir, `out${i}.txt`), c.out);
		fs.writeFileSync(path.join(dir, `status${i}.txt`), String(c.status));
	});
	const counter = path.join(dir, "callcount");
	fs.writeFileSync(counter, "0");
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(log, "");
	const gh = `#!/usr/bin/env bash
jq -nc --args '$ARGS.positional' -- "$@" >> ${JSON.stringify(log)}
for a in "$@"; do
  if [ "$a" = "graphql" ]; then
    n=$(cat ${JSON.stringify(counter)})
    echo $((n + 1)) > ${JSON.stringify(counter)}
    status=$(cat ${JSON.stringify(dir)}/status$n.txt)
    if [ "$status" = "0" ]; then
      cat ${JSON.stringify(dir)}/out$n.txt
      exit 0
    else
      cat ${JSON.stringify(dir)}/out$n.txt >&2
      exit "$status"
    fi
  fi
done
echo "duppypro/princess-pi-packages"
`;
	const p = path.join(binDir, "gh");
	fs.writeFileSync(p, gh);
	fs.chmodSync(p, 0o755);
	return { binDir, log };
}

function run(calls: GhCall[], args: string[]): { code: number; out: string; err: string; calls: any[][] } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-threads-resolve-"));
	const { binDir, log } = stubGh(dir, calls);
	let code: number;
	let out = "";
	let err = "";
	try {
		out = execFileSync("bash", [PR_THREADS, ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		code = 0;
	} catch (e: any) {
		code = e?.status ?? -1;
		out = e?.stdout || "";
		err = e?.stderr || "";
	}
	const logged = fs
		.readFileSync(log, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l));
	return { code, out, err, calls: logged };
}

function resolveMutationCalls(calls: any[][]): any[][] {
	return calls.filter((argv) => argv.includes("graphql"));
}

function parse(out: string): any {
	try {
		return JSON.parse(out);
	} catch {
		return null;
	}
}

function resolvedResponse(threadId: string, isResolved: boolean): string {
	return JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved } } } });
}

function replyResponse(id: string, url: string): string {
	return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id, url } } } });
}

// ---
// Cases
// ---

console.log("pr-threads --resolve: closing the review loop (#232)");

// 1. Bare success: one graphql call, the resolveReviewThread mutation, exit 0.
{
	const { code, out, calls } = run([{ status: 0, out: resolvedResponse("PRRT_kwDOS37--c6ZrzUR", true) }], [
		"1",
		"--resolve",
		"PRRT_kwDOS37--c6ZrzUR",
	]);
	check(code === 0, "--resolve success → exit 0", `got ${code}\n${out}`);
	const mutCalls = resolveMutationCalls(calls);
	check(mutCalls.length === 1, "--resolve without --reply → exactly one graphql call", JSON.stringify(mutCalls));
	const argv = mutCalls[0] ?? [];
	check(
		argv.some((a: string) => a.includes("resolveReviewThread")),
		"the one call is the resolveReviewThread mutation",
		JSON.stringify(argv),
	);
	check(
		argv.includes("threadId=PRRT_kwDOS37--c6ZrzUR"),
		"the exact --json-emitted thread id composes straight into -F threadId=",
		JSON.stringify(argv),
	);
}

// 2. --json --resolve emits one document, not prose.
{
	const { code, out } = run([{ status: 0, out: resolvedResponse("PRRT_x", true) }], [
		"1",
		"--resolve",
		"PRRT_x",
		"--json",
	]);
	const doc = parse(out);
	check(code === 0, "--resolve --json success → exit 0", `got ${code}`);
	check(doc !== null, "--resolve --json → stdout is one parseable JSON document", out);
	check(doc?.schema === "pr-threads/resolve@1", "--resolve --json → carries a versioned schema", out);
	check(doc?.threadId === "PRRT_x", "--resolve --json → echoes the thread id", out);
	check(doc?.resolved === true, "--resolve --json → resolved: true", out);
	check(doc?.replyId === null, "--resolve --json without --reply → replyId is null, not omitted", out);
	check(!/[✅❌💬]/.test(out), "--resolve --json → no emoji or human prose on stdout", out);
}

// 3. --reply posts BEFORE resolving: two calls, reply first, resolve second,
//    and the reply body composes verbatim into the mutation argv.
{
	const replyBody = 'Fixed in a1b2c3 — see "the guard clause" above.\nThanks!';
	const { code, calls } = run(
		[
			{ status: 0, out: replyResponse("RC_1", "https://github.com/o/r/pull/1#discussion_r1") },
			{ status: 0, out: resolvedResponse("PRRT_x", true) },
		],
		["1", "--resolve", "PRRT_x", "--reply", replyBody],
	);
	check(code === 0, "--resolve --reply success → exit 0", `got ${code}`);
	const mutCalls = resolveMutationCalls(calls);
	check(mutCalls.length === 2, "--reply --resolve → exactly two graphql calls", JSON.stringify(mutCalls));
	check(
		mutCalls[0]?.some((a: string) => a.includes("addPullRequestReviewThreadReply")),
		"first call is the reply mutation (reply BEFORE resolve)",
		JSON.stringify(mutCalls[0]),
	);
	check(
		mutCalls[1]?.some((a: string) => a.includes("resolveReviewThread")),
		"second call is the resolve mutation",
		JSON.stringify(mutCalls[1]),
	);
	check(
		mutCalls[0]?.includes(`body=${replyBody}`),
		"reply body composes verbatim into the mutation argv — quotes/newlines untouched, never reformatted",
		JSON.stringify(mutCalls[0]),
	);
}

// 4. --json with --reply carries replyId/replyUrl.
{
	const { out } = run(
		[
			{ status: 0, out: replyResponse("RC_9", "https://github.com/o/r/pull/1#discussion_r9") },
			{ status: 0, out: resolvedResponse("PRRT_x", true) },
		],
		["1", "--resolve", "PRRT_x", "--reply", "done", "--json"],
	);
	const doc = parse(out);
	check(doc?.replyId === "RC_9", "--resolve --reply --json → replyId carried through", out);
	check(doc?.replyUrl === "https://github.com/o/r/pull/1#discussion_r9", "--resolve --reply --json → replyUrl carried through", out);
}

// 5. Usage errors — reserved exit 2, never a bare 1.
{
	check(run([], ["1", "--resolve"]).code === 2, "--resolve with no value → exit 2");
	check(run([], ["1", "--reply", "hi"]).code === 2, "--reply without --resolve → exit 2");
	check(run([], ["1", "--resolve", "PRRT_x", "--reply"]).code === 2, "--reply with no value → exit 2");
}

// 6. Not found — the API determines the thread id does not exist: exit 4.
{
	const { code, err, calls } = run(
		[{ status: 1, out: "GraphQL: Could not resolve to a node with the global id of 'PRRT_bad' (resolveReviewThread)" }],
		["1", "--resolve", "PRRT_bad"],
	);
	check(code === 4, "unresolvable thread id → exit 4 (not found)", `got ${code}\n${err}`);
	check(resolveMutationCalls(calls).length === 1, "not-found → still exactly one graphql attempt", JSON.stringify(calls));
}

// 7. Could not determine — a genuine API/network failure: exit 5, never 1.
{
	const { code, err } = run([{ status: 1, out: "gh: connection reset by peer" }], ["1", "--resolve", "PRRT_x"]);
	check(code === 5, "gh api graphql transport failure → exit 5, not 1", `got ${code}\n${err}`);
}

// 8. Determined, and it says no — the mutation succeeds but the thread comes
//    back unresolved (e.g. no write permission): exit 6, never 1.
{
	const { code, out } = run([{ status: 0, out: resolvedResponse("PRRT_x", false) }], ["1", "--resolve", "PRRT_x"]);
	check(code === 6, "mutation succeeded but isResolved: false → exit 6 (determined, says no)", `got ${code}\n${out}`);
}

// 9. Determined-no also surfaces cleanly in --json mode.
{
	const { code, out } = run([{ status: 0, out: resolvedResponse("PRRT_x", false) }], ["1", "--resolve", "PRRT_x", "--json"]);
	const doc = parse(out);
	check(code === 6, "--json determined-no → exit 6", `got ${code}`);
	check(doc?.resolved === false, "--json determined-no → resolved: false in the document", out);
}

// 10. A failing reply must not silently proceed to resolve anyway — if the
//     reply couldn't be posted, resolving without it would be exactly the
//     "resolving silently" the issue calls worse than not resolving at all.
{
	const { code, calls } = run([{ status: 1, out: "gh: connection reset by peer" }], [
		"1",
		"--resolve",
		"PRRT_x",
		"--reply",
		"done",
	]);
	check(code === 5, "reply transport failure → exit 5", `got ${code}`);
	check(resolveMutationCalls(calls).length === 1, "reply failure → resolve mutation is never attempted", JSON.stringify(calls));
}

// 11. macroscopeapp PR #314 finding (High, bin/pr-threads:133-145): --resolve
//     and --reply consume the FOLLOWING token unconditionally, so a flag
//     typo'd after them (or omitted entirely with another flag trailing) gets
//     swallowed as the value instead of reported as missing. `--resolve
//     --json` must never attempt to resolve a thread literally named
//     "--json" — it must be a usage error, and it must never reach gh at all.
{
	const { code, err, calls } = run([], ["1", "--resolve", "--json"]);
	check(code === 2, "--resolve --json → exit 2 (never treats --json as the thread id)", `got ${code}\n${err}`);
	check(resolveMutationCalls(calls).length === 0, "--resolve --json → no graphql call attempted", JSON.stringify(calls));
}

// 12. Same defect, --reply half: `--reply --json` must not post the literal
//     text "--json" as the reply.
{
	const { code, err, calls } = run([], ["1", "--resolve", "PRRT_x", "--reply", "--json"]);
	check(code === 2, "--reply --json → exit 2 (never posts --json as reply text)", `got ${code}\n${err}`);
	check(resolveMutationCalls(calls).length === 0, "--reply --json → no graphql call attempted", JSON.stringify(calls));
}

// 13. Ergonomics choice for the fix (see bin/pr-threads comment above the flag
//     loop): a bare leading-dash rejection would also reject a LEGITIMATE
//     reply that happens to start with "-" (e.g. "-1, disagree"). Thread ids
//     (case 11) never start with "-" — GitHub's PRRT_/PRRT_... node id format
//     never does — so --resolve rejects a leading dash outright. --reply text
//     is free-form human prose, so it gets a `--` terminator instead: text
//     after an explicit `--` is taken verbatim, dash and all.
{
	const { code, calls } = run(
		[
			{ status: 0, out: replyResponse("RC_1", "https://github.com/o/r/pull/1#discussion_r1") },
			{ status: 0, out: resolvedResponse("PRRT_x", true) },
		],
		["1", "--resolve", "PRRT_x", "--reply", "--", "-1, disagree with this approach"],
	);
	check(code === 0, "--reply -- '-1, ...' → the -- terminator lets dash-led text through", `got ${code}`);
	const mutCalls = resolveMutationCalls(calls);
	check(
		mutCalls[0]?.includes("body=-1, disagree with this approach"),
		"the dash-led text composes verbatim into the reply mutation, -- itself stripped",
		JSON.stringify(mutCalls[0]),
	);
}

// 14. Without the -- escape, dash-led reply text is rejected rather than
//     silently risking a swallowed flag — same usage-error shape as case 12.
{
	const { code, err } = run([], ["1", "--resolve", "PRRT_x", "--reply", "-1, disagree"]);
	check(code === 2, "--reply '-1, ...' without -- → exit 2, not silently accepted", `got ${code}\n${err}`);
}

// 15. macroscopeapp PR #314 finding (Medium, bin/pr-threads:231): a missing or
//     null `.data.resolveReviewThread.thread.isResolved` must report "could
//     not determine" (exit 5), never "the API refused" (exit 6) — the #224
//     5-vs-6 discipline this script's own header documents. The old `// false`
//     jq fallback turned an absent field into a determined `false`.
{
	const { code, out, err } = run(
		[{ status: 0, out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_x" } } } }) }],
		["1", "--resolve", "PRRT_x"],
	);
	check(code === 5, "missing isResolved → exit 5 (could not determine), never 6", `got ${code}\n${out}\n${err}`);
}
{
	const { code, out, err } = run(
		[{ status: 0, out: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_x", isResolved: null } } } }) }],
		["1", "--resolve", "PRRT_x"],
	);
	check(code === 5, "null isResolved → exit 5 (could not determine), never 6", `got ${code}\n${out}\n${err}`);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-threads --resolve: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

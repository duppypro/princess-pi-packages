// --- pr-threads: unresolved-conversation count (#211) ---
//
// Drives the REAL bin/pr-threads with a stub `gh` first on PATH, so the GraphQL
// pages are fixtures rather than live API calls. Same shape as the other
// script suites here: real binary, faked edges, exit code and stdout are the
// subject.
//
// Why the count is worth a suite of its own: `pr-threads` exists to be a merge
// gate, so the number it prints is the number a human or a script acts on. The
// display list looked correct the whole time the count was wrong — one jq record
// spans two lines, and the collector appended one array element per LINE, so
// every count came out doubled. A test that only asserted "lists the threads"
// would have stayed green.
//
// Run with: bun run test pr-threads-count

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
// Fixtures
// ---

interface Thread {
	isResolved: boolean;
	author: string;
	path: string;
}

function thread(isResolved: boolean, author: string, p: string): Thread {
	return { isResolved, author, path: p };
}

/** One GraphQL page as bin/pr-threads expects to receive it. */
function page(threads: Thread[], totalCount: number, endCursor: string | null): string {
	return JSON.stringify({
		data: {
			repository: {
				pullRequest: {
					reviewThreads: {
						totalCount,
						pageInfo: { hasNextPage: endCursor !== null, endCursor },
						nodes: threads.map((t) => ({
							isResolved: t.isResolved,
							comments: {
								nodes: [
									{
										path: t.path,
										url: `https://github.com/o/r/pull/1#discussion_r${t.path.length}`,
										author: { login: t.author },
									},
								],
							},
						})),
					},
				},
			},
		},
	});
}

/**
 * Write a stub `gh` that answers `repo view` and serves the given GraphQL pages
 * in order. Page N is returned on the Nth `gh api graphql` call, tracked through
 * a counter file so it survives the separate process per invocation.
 */
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
# gh repo view --json nameWithOwner --jq .nameWithOwner
echo "duppypro/princess-pi-packages"
`;
	const p = path.join(binDir, "gh");
	fs.writeFileSync(p, gh);
	fs.chmodSync(p, 0o755);
	return binDir;
}

function runPrThreads(
	pages: string[],
	args: string[] = ["1"],
	shell = "bash",
): { code: number; out: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-threads-"));
	const binDir = stubGh(dir, pages);
	try {
		const out = execFileSync(shell, [PR_THREADS, ...args], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, out };
	} catch (err: any) {
		return { code: err?.status ?? -1, out: `${err?.stdout || ""}${err?.stderr || ""}` };
	}
}

// ---
// Cases
// ---

console.log("pr-threads: unresolved-conversation count (#211)");

// 1. The headline defect: 3 unresolved threads must report 3, not 6.
{
	const p = page(
		[
			thread(false, "macroscopeapp", "bin/pr-cleanup"),
			thread(false, "macroscopeapp", "bin/pr-merge"),
			thread(false, "macroscopeapp", "bin/pr-reject"),
			thread(true, "macroscopeapp", "bin/pr-open"),
		],
		4,
		null,
	);
	const { code, out } = runPrThreads([p]);
	check(code === 1, "3 unresolved → exit 1", `got ${code}`);
	check(
		/\b3 unresolved conversation\(s\)/.test(out),
		"3 unresolved → reports 3",
		`output was:\n${out}`,
	);
	check(!/\b6 unresolved/.test(out), "3 unresolved → does NOT report 6 (the 2x bug)", out);
	check(out.includes("bin/pr-cleanup"), "still lists each thread's path", out);
	check(out.includes("#discussion_r"), "still lists each thread's URL", out);
}

// 2. All resolved: the success path must not crash and must exit 0.
{
	const p = page([thread(true, "macroscopeapp", "bin/pr-open")], 1, null);
	const { code, out } = runPrThreads([p]);
	check(code === 0, "0 unresolved → exit 0", `got ${code}, output:\n${out}`);
	check(/0 unresolved conversations/.test(out), "0 unresolved → ✅ line", out);
	check(!/unbound variable/.test(out), "0 unresolved → no unbound-variable crash under set -u", out);
}

// 3. A PR with no review threads at all — the empty-array edge, same path.
{
	const p = page([], 0, null);
	const { code, out } = runPrThreads([p]);
	check(code === 0, "no threads at all → exit 0", `got ${code}, output:\n${out}`);
	check(!/unbound variable/.test(out), "no threads at all → no unbound-variable crash", out);
}

// 4. Pagination: counts must sum across pages, not reset or double.
{
	const p1 = page(
		[thread(false, "macroscopeapp", "a.ts"), thread(true, "macroscopeapp", "b.ts")],
		4,
		"CURSOR1",
	);
	const p2 = page(
		[thread(false, "macroscopeapp", "c.ts"), thread(false, "macroscopeapp", "d.ts")],
		4,
		null,
	);
	const { code, out } = runPrThreads([p1, p2]);
	check(code === 1, "paginated → exit 1", `got ${code}`);
	check(/\b3 unresolved conversation\(s\)/.test(out), "paginated → sums to 3 across 2 pages", out);
	check(out.includes("a.ts") && out.includes("c.ts") && out.includes("d.ts"),
		"paginated → lists threads from both pages", out);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} pr-threads count: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

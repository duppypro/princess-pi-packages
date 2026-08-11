// --- pr-merge / pr-reject: branch selection and PR lookup (#209) ---
//
// Drives the REAL bin/pr-merge and bin/pr-reject inside throwaway git repos,
// with a stub `gh` first on PATH that records its argv and answers `pr list`
// from a fixture. The recorded argv IS the assertion: these scripts exist to
// pick the right PR, so "which PR number did it act on" is the whole contract.
//
// Why a stub and not a mock of the scripts: every defect here is about argument
// handling in bash — `$1` being silently consumed as the wrong variable cannot
// be reproduced by anything that does not actually run bash.
//
// Run with: bun run test pr-scripts-args

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PR_MERGE = path.join(REPO_ROOT, "bin", "pr-merge");
const PR_REJECT = path.join(REPO_ROOT, "bin", "pr-reject");

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

interface PrRow {
	number: number;
	headRefName: string;
	/** owner of the repo the head branch lives in — differs for fork PRs */
	headOwner: string;
}

/** A repo on `branch`, plus a stub gh whose `pr list` returns `rows`. */
function sandbox(branch: string, rows: PrRow[], ownerLogin = "duppypro") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-args-"));
	execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir });
	execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: dir,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});

	const binDir = path.join(dir, "stubbin");
	fs.mkdirSync(binDir);
	const argvLog = path.join(dir, "argv.log");
	fs.writeFileSync(argvLog, "");
	fs.writeFileSync(
		path.join(dir, "prlist.json"),
		JSON.stringify(
			rows.map((r) => ({
				number: r.number,
				headRefName: r.headRefName,
				headRepositoryOwner: { login: r.headOwner },
			})),
		),
	);

	// The stub must behave like real gh in the two ways the scripts depend on:
	// filter by --head, and APPLY --jq to the result. Honouring --jq is not
	// optional — a stub that dumps raw JSON makes `--jq '.[0].number'` return a
	// whole array, and assertions like "acted on PR 7" then pass on a substring
	// of unrelated JSON rather than on the script's selection logic.
	const gh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}
head=""
jqexpr=""
prev=""
for a in "$@"; do
  case "$prev" in
    --head) head="$a" ;;
    --jq|-q) jqexpr="$a" ;;
  esac
  prev="$a"
done
case "$1 $2" in
  "repo view")
    out='{"owner":{"login":"${ownerLogin}"},"nameWithOwner":"${ownerLogin}/princess-pi-packages"}'
    if [ -n "$jqexpr" ]; then printf '%s' "$out" | jq -r "$jqexpr"; else printf '%s\\n' "$out"; fi
    exit 0 ;;
  "pr list")
    filtered=$(jq -c --arg h "$head" '[.[] | select($h == "" or .headRefName == $h)]' ${JSON.stringify(path.join(dir, "prlist.json"))})
    if [ -n "$jqexpr" ]; then printf '%s' "$filtered" | jq -r "$jqexpr"; else printf '%s\\n' "$filtered"; fi
    exit 0 ;;
esac
exit 0
`;
	fs.writeFileSync(path.join(binDir, "gh"), gh);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);
	return { dir, binDir, argvLog };
}

function run(
	script: string,
	branch: string,
	rows: PrRow[],
	args: string[],
	ownerLogin = "duppypro",
): { code: number; out: string; argv: string[] } {
	const { dir, binDir, argvLog } = sandbox(branch, rows, ownerLogin);
	let code = 0;
	let out = "";
	try {
		out = execFileSync("bash", [script, ...args], {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	const argv = fs.readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean);
	return { code, out, argv };
}

/** The `gh pr merge <N> …` / `gh pr close <N> …` line the script actually issued. */
function actedOn(argv: string[], verb: string): string | undefined {
	return argv.find((l) => l.startsWith(`pr ${verb} `));
}

const OURS = (n: number, b: string): PrRow => ({ number: n, headRefName: b, headOwner: "duppypro" });
const FORK = (n: number, b: string): PrRow => ({ number: n, headRefName: b, headOwner: "someone-else" });

// ---
// pr-merge
// ---

console.log("pr-merge / pr-reject: branch selection and PR lookup (#209)");
console.log("\npr-merge:");

// 1. The advertised `pr-merge <branch>` form, run from main.
{
	const { code, out, argv } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], ["42-some-feature"]);
	check(code === 0, "pr-merge <branch> from main → exits 0", `got ${code}, output:\n${out}`);
	check(
		actedOn(argv, "merge")?.includes("42") === true,
		"pr-merge <branch> from main → merges that branch's PR",
		`gh calls:\n${argv.join("\n")}`,
	);
}

// 2. No argument on a feature branch still uses the current branch.
{
	const { code, argv } = run(PR_MERGE, "42-some-feature", [OURS(42, "42-some-feature")], []);
	check(code === 0, "pr-merge (no args) on a feature branch → exits 0", `got ${code}`);
	check(
		actedOn(argv, "merge")?.includes("42") === true,
		"pr-merge (no args) → merges the current branch's PR",
		argv.join("\n"),
	);
}

// 3. Bare `pr-merge` on main is still an error — there is nothing to infer.
{
	const { code, out } = run(PR_MERGE, "main", [OURS(42, "42-some-feature")], []);
	check(code !== 0, "pr-merge (no args) on main → non-zero", `got ${code}`);
	check(/pr-merge <branch>/.test(out), "pr-merge on main → hint names the form that now works", out);
}

// 4. A fork PR sharing the branch name must never be picked.
{
	const { code, out, argv } = run(
		PR_MERGE,
		"fix",
		[FORK(99, "fix"), OURS(7, "fix")],
		[],
	);
	check(code === 0, "same branch name on a fork → still exits 0", `got ${code}, out:\n${out}`);
	check(
		actedOn(argv, "merge")?.includes("7") === true,
		"same branch name on a fork → merges OUR PR (#7), not the fork's (#99)",
		argv.join("\n"),
	);
}

// 5. Only a fork PR matches → refuse rather than merge a stranger's branch.
{
	const { code, out, argv } = run(PR_MERGE, "fix", [FORK(99, "fix")], []);
	check(code !== 0, "only a fork PR matches → non-zero", `got ${code}`);
	check(actedOn(argv, "merge") === undefined, "only a fork PR matches → merges nothing", argv.join("\n"));
	check(/no open PR/i.test(out), "only a fork PR matches → says no PR found", out);
}

// 6. Two of OUR OWN open PRs on one branch name → ambiguous, refuse and name both.
{
	const { code, out, argv } = run(PR_MERGE, "fix", [OURS(7, "fix"), OURS(8, "fix")], []);
	check(code !== 0, "ambiguous match → non-zero", `got ${code}`);
	check(actedOn(argv, "merge") === undefined, "ambiguous match → merges nothing", argv.join("\n"));
	check(/\b7\b/.test(out) && /\b8\b/.test(out), "ambiguous match → names both candidates", out);
}

// ---
// pr-reject
// ---

console.log("\npr-reject:");

// 7. The headline defect: the branch argument was silently eaten as the reason.
{
	const { code, out, argv } = run(
		PR_REJECT,
		"main",
		[OURS(42, "42-some-feature")],
		["-b", "42-some-feature", "wrong approach"],
	);
	check(code === 0, "pr-reject -b <branch> <reason> → exits 0", `got ${code}, out:\n${out}`);
	const line = actedOn(argv, "close");
	check(line?.includes("42") === true, "pr-reject -b <branch> → closes THAT branch's PR", argv.join("\n"));
	check(
		line?.includes("wrong approach") === true,
		"pr-reject -b <branch> <reason> → comment is the reason, not the branch name",
		argv.join("\n"),
	);
	check(
		line?.includes("42-some-feature --comment") !== true,
		"pr-reject → branch name never becomes the comment",
		argv.join("\n"),
	);
}

// 8. Back-compat: a bare reason on a feature branch still works.
{
	const { code, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], ["not now"]);
	check(code === 0, "pr-reject <reason> on a feature branch → exits 0", `got ${code}`);
	const line = actedOn(argv, "close");
	check(line?.includes("42") === true, "pr-reject <reason> → closes the current branch's PR", argv.join("\n"));
	check(line?.includes("not now") === true, "pr-reject <reason> → reason is the comment", argv.join("\n"));
}

// 9. No reason at all — closes without a comment.
{
	const { code, argv } = run(PR_REJECT, "42-some-feature", [OURS(42, "42-some-feature")], []);
	check(code === 0, "pr-reject (no args) on a feature branch → exits 0", `got ${code}`);
	check(
		actedOn(argv, "close")?.includes("--comment") !== true,
		"pr-reject (no args) → closes with no comment",
		argv.join("\n"),
	);
}

// 10. pr-reject inherits the same fork guard.
{
	const { code, out, argv } = run(PR_REJECT, "fix", [FORK(99, "fix"), OURS(7, "fix")], ["nope"]);
	check(code === 0, "pr-reject with a fork twin → exits 0", `got ${code}, out:\n${out}`);
	check(
		actedOn(argv, "close")?.includes("7") === true,
		"pr-reject with a fork twin → closes OUR PR (#7), not the fork's (#99)",
		argv.join("\n"),
	);
}

// ---

console.log(
	`\n${failures === 0 ? "✅" : "❌"} pr-merge / pr-reject args: ${checks - failures} of ${checks} checks passed.`,
);
process.exit(failures > 0 ? 1 : 0);

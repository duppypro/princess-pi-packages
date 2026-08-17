// herdr-reap: close herdr tabs whose panes all point at a directory that no
// longer exists (#277).
//
// Two things are under test, and they need different instruments:
//
//   1. THE DECISION. Driven against a stub `herdr` on PATH, built from the
//      payload shape pinned in tests/fixtures/herdr-0.8.0/. A stub is right
//      here precisely because the live host has exactly one herdr session:
//      "spare the tab a live agent is sitting in" and "a refused tab close is
//      exit 6" cannot be staged against it without closing Duppy's real tabs.
//   2. THE PINNED CONTRACT. Asserted against the verbatim capture, so a herdr
//      upgrade that stops suffixing a deleted cwd — or starts emitting
//      `agent: null` where the key used to be absent — fails HERE, loudly,
//      instead of silently changing which tabs get closed. See that
//      directory's README for the three facts and why each one matters.
//
// The DIRECTORIES are always real: every "stale" cwd in these scenarios is a
// temp dir that was created and then removed, so the `! -d` predicate is
// exercised against the filesystem rather than against a mocked stat. That is
// the one thing a fixture must not stand in for — it is the whole predicate.
//
// NO `sleep` ANYWHERE, and a source-level check below enforces it. An earlier
// draft of the spec asserted herdr's cwd "lags ~1s" and put a sleep in these
// tests on that basis; the claim was never measured (every probe had the sleep
// baked in). Measured afterwards: filesystem consistent when `rm -rf` returned
// 24/24, deleted cwd visible on the FIRST poll 24/24. A fixed delay would cost
// real time on every run, guarantee nothing, and mask a genuine regression if
// propagation ever did become async.
//
// Run with: bun run test herdr-reap

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const HERDR_REAP = path.join(REPO_ROOT, "bin", "herdr-reap");
const HERDR_TAB = path.join(REPO_ROOT, "bin", "herdr-tab");
const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "herdr-0.8.0");

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
// A stub `herdr` on PATH, driven entirely by files in its own directory so a
// scenario is a data change, never a code change. It answers the three
// subcommands herdr-reap uses and refuses everything else loudly — a herdr-reap
// that grows a fourth call must come back here and say so.
// ---
interface Pane {
	pane_id: string;
	tab_id: string;
	cwd?: string | null;
	agent?: string;
}

interface Stub {
	dir: string;
	/** tab ids passed to `herdr tab close`, in order. */
	closed(): string[];
	/** notification bodies, in order. */
	notified(): string[];
}

function makeStub(opts: {
	panes: Pane[];
	/** Simulate a `pane list` that fails outright. */
	paneListFails?: boolean;
	/** Simulate a `pane list` that succeeds but is not the shape we expect. */
	paneListGarbage?: string;
	/** Tab ids whose close is refused by herdr. */
	refuseClose?: string[];
	/** Workspace ids before, and after the first close (0.8.0 last-tab behaviour). */
	workspacesBefore?: string[];
	workspacesAfter?: string[];
}): Stub {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-stub-"));
	const bin = path.join(dir, "bin");
	fs.mkdirSync(bin);

	const paneList =
		opts.paneListGarbage ?? JSON.stringify({ id: "cli:pane:list", result: { panes: opts.panes } });
	fs.writeFileSync(path.join(dir, "panes.json"), paneList);
	fs.writeFileSync(path.join(dir, "refuse.txt"), (opts.refuseClose ?? []).join("\n"));

	const wsDoc = (ids: string[]) =>
		JSON.stringify({
			id: "cli:workspace:list",
			result: { type: "workspace_list", workspaces: ids.map((workspace_id) => ({ workspace_id })) },
		});
	fs.writeFileSync(path.join(dir, "ws-before.json"), wsDoc(opts.workspacesBefore ?? ["wS"]));
	fs.writeFileSync(path.join(dir, "ws-after.json"), wsDoc(opts.workspacesAfter ?? opts.workspacesBefore ?? ["wS"]));

	// `ws-after` is served only once a close has happened, so the before/after
	// diff in herdr-reap is measured the same way it is in production: two
	// separate reads of a mutating world, not one canned answer.
	const script = `#!/usr/bin/env bash
set -uo pipefail
D="${dir}"
case "$1 \${2:-}" in
  "pane list")
    ${opts.paneListFails ? "exit 1" : 'cat "$D/panes.json"'}
    ;;
  "workspace list")
    if [ -s "$D/closed.log" ]; then cat "$D/ws-after.json"; else cat "$D/ws-before.json"; fi
    ;;
  "tab close")
    if grep -qxF "$3" "$D/refuse.txt" 2>/dev/null; then exit 1; fi
    echo "$3" >> "$D/closed.log"
    echo '{"id":"cli:tab:close","result":{"type":"ok"}}'
    ;;
  "notification show")
    shift 2
    printf '%s\\n' "$*" >> "$D/notify.log"
    ;;
  *)
    echo "stub herdr: unexpected call: $*" >&2
    exit 97
    ;;
esac
`;
	fs.writeFileSync(path.join(bin, "herdr"), script, { mode: 0o755 });

	const readLines = (f: string): string[] => {
		const p = path.join(dir, f);
		if (!fs.existsSync(p)) return [];
		return fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
	};
	return { dir, closed: () => readLines("closed.log"), notified: () => readLines("notify.log") };
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
	json: any;
}

function runReap(stub: Stub, args: string[], env: Record<string, string | undefined> = {}): RunResult {
	const r = spawnSync(HERDR_REAP, args, {
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${path.join(stub.dir, "bin")}:${process.env.PATH}`,
			HERDR_PANE_ID: "wS:p1",
			HERDR_WORKSPACE_ID: "wS",
			HERDR_TAB_ID: "wS:tSELF",
			...env,
		},
	});
	let json: any = null;
	if (args.includes("--json")) {
		try {
			json = JSON.parse(r.stdout.trim());
		} catch {
			json = null;
		}
	}
	return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json };
}

/** A directory that exists. */
function liveDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "herdr-live-"));
}

/** A directory that existed and no longer does — and the string herdr reports for it. */
function deadCwd(suffix = true): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-dead-"));
	fs.rmSync(d, { recursive: true, force: true }); // synchronous; no delay needed or wanted
	return suffix ? `${d} (deleted)` : d;
}

console.log("herdr-reap (#277)\n");

// ---
// V4 — a tab whose only pane points at a removed directory is closed, and
// V5 — a tab at a live cwd, in the same run, is untouched.
// Together in one scenario on purpose: "closed the right one" and "left the
// other alone" are the same assertion seen from two sides, and splitting them
// would let a script that closes EVERYTHING pass the first half.
// ---
{
	const live = liveDir();
	const stub = makeStub({
		panes: [
			{ pane_id: "wS:p1", tab_id: "wS:tSELF", cwd: live },
			{ pane_id: "wS:p2", tab_id: "wS:tSTALE", cwd: deadCwd() },
			{ pane_id: "wS:p3", tab_id: "wS:tLIVE", cwd: live },
		],
	});
	const r = runReap(stub, ["--json"]);
	check(r.status === 0, "V4/V5 exit 0", `status=${r.status} stderr=${r.stderr}`);
	check(
		JSON.stringify(stub.closed()) === JSON.stringify(["wS:tSTALE"]),
		"V4 closed exactly the stale tab; V5 left the live one alone",
		`closed=${JSON.stringify(stub.closed())}`,
	);
	check(r.json?.tabs_closed === 1, "V4 reports tabs_closed=1", JSON.stringify(r.json));
	check(stub.notified().length === 1, "V4 notified once", JSON.stringify(stub.notified()));
	check(
		(stub.notified()[0] ?? "").includes("closed 1 stale tab"),
		"V4 notification body names the count",
		JSON.stringify(stub.notified()),
	);
}

// ---
// A tab is stale only when EVERY pane in it is. The mixed tab is the case that
// separates a correct grouping from an any()-instead-of-all() bug, and it is
// the one that was seen live: a real session's tab with one stale pane and one
// live pane, correctly spared.
// ---
{
	const live = liveDir();
	const stub = makeStub({
		panes: [
			{ pane_id: "wS:p1", tab_id: "wS:tMIXED", cwd: deadCwd() },
			{ pane_id: "wS:p2", tab_id: "wS:tMIXED", cwd: live },
			{ pane_id: "wS:p3", tab_id: "wS:tALLGONE", cwd: deadCwd() },
			{ pane_id: "wS:p4", tab_id: "wS:tALLGONE", cwd: deadCwd() },
		],
	});
	runReap(stub, []);
	check(
		JSON.stringify(stub.closed()) === JSON.stringify(["wS:tALLGONE"]),
		"a tab with one live pane is spared; a tab with two dead panes is closed",
		`closed=${JSON.stringify(stub.closed())}`,
	);
}

// ---
// V6 — the reaper never closes its own tab. Without this, an agent that cd'd
// its own pane into a worktree that was later removed kills itself mid-turn.
// ---
{
	const stub = makeStub({ panes: [{ pane_id: "wS:p1", tab_id: "wS:tSELF", cwd: deadCwd() }] });
	const r = runReap(stub, ["--json"]);
	check(r.status === 0 && stub.closed().length === 0, "V6 self tab never closed", `closed=${JSON.stringify(stub.closed())}`);
	check(
		r.json?.spared?.[0]?.reason === "self",
		"V6 reports WHY it was spared, rather than silently doing nothing",
		JSON.stringify(r.json),
	);
}

// ---
// The live-agent guard. `~/git-projects/CLAUDE.md` already requires a session
// to ExitWorktree before the worktree is removed, so this only fires when that
// was violated — but what reaping would change is the severity, from "an agent
// is working in a deleted directory" (survivable) to "an agent was killed
// mid-turn" (not). Fails toward a lingering tab, the harmless direction.
// ---
{
	const stub = makeStub({
		panes: [{ pane_id: "wS:p2", tab_id: "wS:tAGENT", cwd: deadCwd(), agent: "claude" }],
	});
	const r = runReap(stub, ["--json"]);
	check(stub.closed().length === 0, "a stale tab with a live agent is spared", `closed=${JSON.stringify(stub.closed())}`);
	check(r.json?.spared?.[0]?.reason === "live_agent", "spared reason is live_agent", JSON.stringify(r.json));
}

// ---
// An unknown cwd is not evidence of anything. Acting on a blank is how a
// decoration tool closes something real.
// ---
{
	const stub = makeStub({
		panes: [
			{ pane_id: "wS:p2", tab_id: "wS:tBLANK", cwd: deadCwd() },
			{ pane_id: "wS:p3", tab_id: "wS:tBLANK", cwd: null },
		],
	});
	const r = runReap(stub, ["--json"]);
	check(stub.closed().length === 0, "a tab with an unreadable cwd is spared", `closed=${JSON.stringify(stub.closed())}`);
	check(r.json?.spared?.[0]?.reason === "cwd_unknown", "spared reason is cwd_unknown", JSON.stringify(r.json));
}

// ---
// V7 — nothing stale: exit 0, nothing closed, no notification, no output.
// The "no output" half matters: this runs at the tail of every pr-cleanup, and
// a tool that always says something trains the reader to stop looking.
// ---
{
	const live = liveDir();
	const stub = makeStub({ panes: [{ pane_id: "wS:p1", tab_id: "wS:tLIVE", cwd: live }] });
	const r = runReap(stub, []);
	check(r.status === 0, "V7 exit 0", `status=${r.status}`);
	check(r.stdout === "" && r.stderr === "", "V7 silent when nothing is stale", `stdout=${r.stdout} stderr=${r.stderr}`);
	check(stub.notified().length === 0, "V7 no notification", JSON.stringify(stub.notified()));
}

// ---
// V8 — closing the last tab in a workspace closes the workspace (new in 0.8.0,
// upstream #1760/#1899). Strictly larger blast radius than "close a tab", so
// the summary must REPORT it: "closed 1 tab" while a workspace vanished is the
// prose/reality gap #224 exists about. Counted by diffing workspace list before
// and after — observed, never predicted.
// ---
{
	const stub = makeStub({
		panes: [{ pane_id: "wS:p2", tab_id: "wS:tONLY", cwd: deadCwd() }],
		workspacesBefore: ["wS", "wDOOMED"],
		workspacesAfter: ["wS"],
	});
	const r = runReap(stub, ["--json"]);
	check(r.json?.tabs_closed === 1, "V8 tab closed", JSON.stringify(r.json));
	check(r.json?.workspaces_closed === 1, "V8 workspace closure is reported, not swallowed", JSON.stringify(r.json));
	check(
		(stub.notified()[0] ?? "").includes("1 workspace"),
		"V8 notification names the workspace too",
		JSON.stringify(stub.notified()),
	);
}

// ---
// --dry-run closes nothing and notifies nobody, but still reports what it would
// have done. A preview that mutates is not a preview.
// ---
{
	const stub = makeStub({ panes: [{ pane_id: "wS:p2", tab_id: "wS:tSTALE", cwd: deadCwd() }] });
	const r = runReap(stub, ["--dry-run", "--json"]);
	check(stub.closed().length === 0, "--dry-run closes nothing", `closed=${JSON.stringify(stub.closed())}`);
	check(stub.notified().length === 0, "--dry-run notifies nobody", JSON.stringify(stub.notified()));
	check(r.json?.dry_run === true && r.json?.tabs_closed === 1, "--dry-run still reports the candidate", JSON.stringify(r.json));
}

// ---
// Exit-code contract (#224). The load-bearing distinction is 5 vs 6: "I could
// not check" against "I checked, and the close was refused". Collapsing them
// into a bare exit 1 is the fail-open shape the pr-* scripts exist to remove.
// ---
{
	const stub = makeStub({ panes: [], paneListFails: true });
	const r = runReap(stub, ["--json"]);
	check(r.status === 5, "pane list failure is exit 5 (undetermined)", `status=${r.status}`);
	check(r.json?.status === "undetermined", "…and says so in --json", JSON.stringify(r.json));
}
{
	const stub = makeStub({ panes: [], paneListGarbage: '{"result":{"panes":"not-an-array"}}' });
	const r = runReap(stub, []);
	check(r.status === 5, "unparseable pane list is exit 5, never a silent 'nothing stale'", `status=${r.status}`);
	check(stub.closed().length === 0, "…and closes nothing", `closed=${JSON.stringify(stub.closed())}`);
}
{
	const stub = makeStub({
		panes: [{ pane_id: "wS:p2", tab_id: "wS:tSTUCK", cwd: deadCwd() }],
		refuseClose: ["wS:tSTUCK"],
	});
	const r = runReap(stub, []);
	check(r.status === 6, "a refused close is exit 6 (determined, and it says no)", `status=${r.status}`);
}
{
	// Not inside a herdr pane: the normal case for cron, CI, or a plain shell.
	// Exit 0 and silence, because a caller like pr-cleanup must never be made
	// to handle a failure that isn't one — the distinction lives in --json.
	const stub = makeStub({ panes: [{ pane_id: "wS:p2", tab_id: "wS:tSTALE", cwd: deadCwd() }] });
	const r = runReap(stub, ["--json"], { HERDR_PANE_ID: undefined });
	check(r.status === 0 && r.json?.status === "no_herdr", "no pane id → exit 0, status no_herdr", JSON.stringify(r.json));
	check(stub.closed().length === 0, "…and nothing is touched", `closed=${JSON.stringify(stub.closed())}`);
}
{
	const stub = makeStub({ panes: [] });
	const r = runReap(stub, ["--nope"]);
	check(r.status === 2, "unknown flag is exit 2 (usage)", `status=${r.status}`);
}

// ---
// A path is every byte except NUL and '/'. The parse hands bash NUL-delimited
// records for exactly this reason, and the JSON emitter has to survive the
// same values — a quote in a directory name must not produce a document no one
// can parse.
// ---
{
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-odd-"));
	const nasty = path.join(base, 'we ird"quote\\back');
	fs.mkdirSync(nasty);
	fs.rmSync(nasty, { recursive: true, force: true });
	const stub = makeStub({ panes: [{ pane_id: "wS:p2", tab_id: "wS:tODD", cwd: `${nasty} (deleted)` }] });
	const r = runReap(stub, ["--json"]);
	check(r.json !== null, "a path with spaces, a quote and a backslash still yields parseable JSON", r.stdout);
	check(r.json?.reaped?.[0]?.cwd?.includes('we ird"quote'), "…and round-trips the path", JSON.stringify(r.json));
	check(JSON.stringify(stub.closed()) === JSON.stringify(["wS:tODD"]), "…and closes it", JSON.stringify(stub.closed()));
}

// ---
// A directory GENUINELY named "foo (deleted)" exists, and must be spared. This
// is the case that forbids matching the suffix instead of stat'ing the path —
// the suffix is kernel prose leaking through a JSON field, corroboration only.
// ---
{
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-real-"));
	const real = path.join(base, "foo (deleted)");
	fs.mkdirSync(real);
	const stub = makeStub({ panes: [{ pane_id: "wS:p2", tab_id: "wS:tREAL", cwd: real }] });
	runReap(stub, []);
	check(
		stub.closed().length === 0,
		'a real directory named "foo (deleted)" is spared — the predicate is a stat, not a suffix match',
		`closed=${JSON.stringify(stub.closed())}`,
	);
}

// ---
// The pinned 0.8.0 contract. See tests/fixtures/herdr-0.8.0/README.md.
// ---
{
	const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "pane-list.json"), "utf8"));
	const panes: any[] = raw?.result?.panes ?? [];
	check(panes.length > 0 && panes.every((p) => typeof p.tab_id === "string"), "fixture: every pane carries tab_id");
	const deleted = panes.filter((p) => typeof p.cwd === "string" && p.cwd.endsWith(" (deleted)"));
	check(deleted.length > 0, "fixture: a removed directory is still reported as a SUCCESS payload with a ' (deleted)' cwd");
	check(
		deleted.every((p) => p.foreground_cwd === p.cwd),
		"fixture: 0.8.0 keeps foreground_cwd (0.7.5 dropped the key entirely)",
	);
	check(
		panes.some((p) => !Object.prototype.hasOwnProperty.call(p, "agent")),
		"fixture: a bare-shell pane OMITS the agent key — the guard must read absent and null alike",
	);
	check(
		panes.some((p) => p.agent === "claude"),
		"fixture: an agent pane carries agent + agent_session, so the guard has something to see",
	);
}

// ---
// Source-level guards. Both encode a rule that is easy to reintroduce by
// accident and impossible to see in a passing test run.
// ---
{
	const src = fs.readFileSync(HERDR_REAP, "utf8");
	const self = fs.readFileSync(import.meta.filename, "utf8");
	const codeLines = src.split("\n").filter((l) => !l.trim().startsWith("#"));
	check(
		!codeLines.some((l) => /\bsleep\b/.test(l)),
		"herdr-reap contains no sleep — delays are not encoded without a measurement that falsifies their absence",
	);
	// Matched as a CALL (`(` required), not as a bare word: this very file
	// names both functions in the guard above, and a check that trips on its
	// own source teaches nothing except to delete the check.
	check(
		!self.split("\n").some((l) => !l.trim().startsWith("//") && /(^|[^\w.])(sleep|setTimeout)\s*\(/.test(l)),
		"…and neither do its tests",
	);
	check(
		!codeLines.some((l) => /api\s+snapshot/.test(l)),
		"herdr-reap never reads `herdr api snapshot` — it is 248 KB and this runs inside an agent's turn",
	);
	check(fs.existsSync(HERDR_TAB), "herdr-tab ships beside it (the guard lives in exactly one file)");
	const installer = fs.readFileSync(path.join(REPO_ROOT, "bin", "install-workflow-tools"), "utf8");
	check(
		/^\s+herdr-tab\s*$/m.test(installer) && /^\s+herdr-reap\s*$/m.test(installer),
		"both are in the installer's SCRIPTS manifest — a host with one but not the other fails silently",
	);
	const cleanup = fs.readFileSync(path.join(REPO_ROOT, "bin", "pr-cleanup"), "utf8");
	check(/herdr-reap/.test(cleanup), "pr-cleanup calls herdr-reap after removing the worktree (#277)");
}

// ---
// herdr-tab's own contract: sourcing it must define the helpers WITHOUT
// dragging `set -euo pipefail` into the caller's shell, and the guard must be
// the pane id rather than `command -v herdr` — because an installed herdr
// answers exit 0 from any shell on this host, cron included.
// ---
{
	const probe = spawnSync(
		"bash",
		[
			"-c",
			`. "${HERDR_TAB}"; case "$-" in *e*) echo "ERRESET";; esac; ` +
				`type herdr_tab >/dev/null 2>&1 && echo HAVE_TAB; ` +
				`type herdr_available >/dev/null 2>&1 && echo HAVE_AVAIL; ` +
				`HERDR_PANE_ID= herdr_available && echo AVAIL_WITHOUT_PANE_ID; ` +
				`HERDR_PANE_ID= herdr_tab /tmp x; echo "RC=$? RESULT=$HERDR_TAB_RESULT"`,
		],
		{ encoding: "utf8", env: { ...process.env, HERDR_PANE_ID: "", HERDR_WORKSPACE_ID: "wS" } },
	);
	const out = probe.stdout;
	check(out.includes("HAVE_TAB") && out.includes("HAVE_AVAIL"), "sourcing herdr-tab defines both helpers", out);
	check(!out.includes("ERRESET"), "sourcing herdr-tab does not turn on `set -e` in the caller's shell", out);
	check(!out.includes("AVAIL_WITHOUT_PANE_ID"), "the guard is HERDR_PANE_ID, not `command -v herdr`", out);
	check(out.includes("RC=0 RESULT=skipped"), "herdr_tab returns 0 and reports 'skipped' out of band", out);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);

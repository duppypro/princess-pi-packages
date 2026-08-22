/**
 * Tests for the skip contract (#256, item 3).
 *
 * The failure this guards against is green-because-empty: a suite that reads
 * host state, finds none, prints a friendly note, and exits 0. Twelve suites in
 * this repo touch `os.homedir()` or `$HOME`; on a machine without the state they
 * want — every CI runner, by construction — they report PASS having checked
 * nothing. #228 wants to gate merges on this test run, so the run has to be able
 * to say what it did NOT do.
 *
 * Two things are asserted here. The parse/render contract, on literals. And
 * COMPLETENESS: every host-touching suite either speaks the contract or carries
 * a waiver naming why it does not need to — with each waiver asserted still
 * necessary, so the list drains itself instead of rotting.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { SKIP_MARKER, skip, collectSkips, renderSkipSummary } from "./lib/skips.ts";

const TESTS_DIR = import.meta.dirname;

// ---
// The parse contract
// ---

describe("collectSkips", () => {
	it("extracts the reason after the token", () => {
		assert.deepStrictEqual(
			collectSkips(`ok\n${SKIP_MARKER} no ~/.claude/settings.json on this machine\ndone`),
			["no ~/.claude/settings.json on this machine"],
		);
	});

	it("tolerates indentation and ANSI colour, because suites print how they like", () => {
		assert.deepStrictEqual(
			collectSkips(`    \x1b[2m${SKIP_MARKER}\x1b[0m  \x1b[33mno dotfiles-doctor clone\x1b[0m  `),
			["no dotfiles-doctor clone"],
		);
	});

	it("returns every marker, in order — a suite may skip more than one check", () => {
		assert.deepStrictEqual(
			collectSkips(`${SKIP_MARKER} first\nnoise\n${SKIP_MARKER} second`),
			["first", "second"],
		);
	});

	it("ignores the token mid-line — a failing suite echoing it is not a skip", () => {
		assert.deepStrictEqual(
			collectSkips(`assert.deepStrictEqual(collectSkips("${SKIP_MARKER} first"), ["first"])`),
			[],
		);
	});

	it("returns nothing for output that never skipped", () => {
		assert.deepStrictEqual(collectSkips("✅ All tests passed.\n"), []);
		assert.deepStrictEqual(collectSkips(""), []);
	});

	it("ignores a bare token with no reason — an unexplained skip is not a report", () => {
		assert.deepStrictEqual(collectSkips(`${SKIP_MARKER}\n${SKIP_MARKER}   `), []);
	});

	it("round-trips what skip() writes", () => {
		const captured: string[] = [];
		const real = console.log;
		console.log = (...a: any[]) => { captured.push(a.join(" ")); };
		try { skip("no status-line logs on this machine"); } finally { console.log = real; }
		assert.deepStrictEqual(collectSkips(captured.join("\n")), ["no status-line logs on this machine"]);
	});
});

// ---
// The render contract
// ---

describe("renderSkipSummary", () => {
	it("is empty when nothing was skipped, so the runner can print it unconditionally", () => {
		assert.strictEqual(renderSkipSummary([]), "");
		assert.strictEqual(renderSkipSummary([{ suite: "a", reasons: [] }]), "");
	});

	it("names every suite and every reason, and totals the checks not the suites", () => {
		const out = renderSkipSummary([
			{ suite: "hooks-deploy-drift", reasons: ["no ~/.claude/settings.json"] },
			{ suite: "quiet", reasons: [] },
			{ suite: "wtft-issue-149", reasons: ["no logs", "nothing auditable"] },
		]);
		assert.match(out, /3 checks skipped/);
		assert.match(out, /in 2 suites/);
		assert.match(out, /hooks-deploy-drift:/);
		assert.match(out, /no ~\/\.claude\/settings\.json/);
		assert.match(out, /no logs/);
		assert.match(out, /nothing auditable/);
		assert.doesNotMatch(out, /quiet/);
	});

	it("says 'not verified' — the point is that a skip is absence of evidence", () => {
		const out = renderSkipSummary([{ suite: "s", reasons: ["r"] }]);
		assert.match(out, /not verified/);
		assert.match(out, /1 check skipped\b/);
		assert.doesNotMatch(out, /1 checks/);
	});
});

// ---
// Completeness — the part that actually stops the rot
// ---

/**
 * Suites that touch `homedir()`/`$HOME` but need no skip contract. Each entry is
 * asserted STILL NECESSARY below: if the file grows a marker, its waiver is
 * stale and this suite fails until it is removed.
 */
const WAIVED: Record<string, string> = {
	"config-persistence.test.ts":
		"fails closed instead of skipping — it prints FAIL and increments the failure count when the write path is not isolated (#158)",
	"pack-and-smoke.test.ts":
		"passes $HOME through to a subprocess to build a stock-npm environment; reads nothing from it",
	"wtft-daemon-lifecycle.test.ts":
		"writes ~/.local/state/wtft/reap.log via the daemon it starts itself — the path is an output, not a precondition",
	"install-workflow-tools-no-delete.test.ts":
		"$HOME appears only inside fixture text; the suite installs into a temp root",
	"install-workflow-tools-self-deploy.test.ts":
		"$HOME appears only inside fixture text; the suite installs into a temp root",
	"skills-deploy.test.ts":
		"$HOME appears only in prose comments describing the temp-root technique; the suite installs into a temp root only, never the real host",
	"serve-117-list.test.ts":
		"uses homedir() to BUILD fixture paths for a pure function (the behaviour under test is 'shorten $HOME to ~'); reads nothing from disk",
	"doc-references-resolve.test.ts":
		"$HOME appears only in the comment explaining why deployed-copy parity is NOT checked there (#230); the suite reads the repo only",
	"pr-review-gate.test.ts":
		"UNSETS the host's HOME rather than reading it — the round-7 case runs pr-review through `env -u HOME` to prove the gate survives cron/systemd/container environments (#379). $HOME appears only in the comment naming the expansion that used to abort. PATH is replaced and every run is sandboxed, so there is no host precondition to skip on",
	"git-checkpoint-guard.test.ts":
		"builds a hermetic git sandbox and pins GIT_CONFIG_GLOBAL=/dev/null; $HOME appears only in a comment explaining why",
};

describe("every host-gated suite speaks the skip contract", () => {
	const suites = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith(".test.ts") && f !== "skip-reporting.test.ts");
	const hostTouching = suites.filter(f =>
		/os\.homedir\(\)|homedir\(\)|process\.env\.HOME|\$HOME/.test(fs.readFileSync(path.join(TESTS_DIR, f), "utf8")));

	it("finds the host-touching suites at all (guards against a scan that matches nothing)", () => {
		assert.ok(hostTouching.length >= 8, `expected the scan to find the known host-touching suites, found ${hostTouching.length}`);
	});

	for (const f of suites.filter(s => hostTouching.includes(s))) {
		const src = fs.readFileSync(path.join(TESTS_DIR, f), "utf8");
		const speaks = src.includes(SKIP_MARKER) || /from "\.\/lib\/skips/.test(src);
		const waiver = WAIVED[f];

		it(`${f} — emits ${SKIP_MARKER} or is waived`, () => {
			assert.ok(speaks || waiver,
				`${f} reads host state but can never say it skipped. Emit \`${SKIP_MARKER} <what was missing>\` on the ` +
				`gate, or add it to WAIVED with the reason it needs no gate.`);
		});

		if (waiver) {
			it(`${f} — its waiver is still needed`, () => {
				assert.ok(!speaks,
					`${f} now speaks the skip contract, so its WAIVED entry is stale — delete it.\n  waiver said: ${waiver}`);
			});
		}
	}
});

// ---
// The runner is wired to it
// ---

describe("tests/run.ts reports skips", () => {
	const runner = fs.readFileSync(path.join(TESTS_DIR, "run.ts"), "utf8");

	it("imports the contract rather than re-implementing the token", () => {
		assert.match(runner, /from "\.\/lib\/skips/);
		assert.match(runner, /collectSkips/);
		assert.match(runner, /renderSkipSummary/);
	});

	it("does not re-implement the marker literal in code (documenting it is fine)", () => {
		const literals = runner.split("\n")
			.filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
			.filter(l => l.includes(SKIP_MARKER));
		assert.deepStrictEqual(literals, [], `run.ts should import SKIP_MARKER, not spell it:\n${literals.join("\n")}`);
	});
});

console.log("✅ All skip-contract tests passed.");

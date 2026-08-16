/**
 * The fleet policy claims things; this asserts them (#288).
 *
 * `docs/repo-policy.json` is the declared branch-protection baseline for 29 repos.
 * It is the same shape of promise `tests/ruleset-claims.test.ts` guards for one
 * repo, scaled out — and it has the same failure mode: a claim written in a file
 * about settings stored on GitHub has no checker unless someone writes one.
 *
 * Two halves, deliberately unequal:
 *
 *   - **Structure** (offline, always runs). The policy is internally coherent, the
 *     tiers cannot silently diverge, and `bin/repo-gate` still honours the contract
 *     the policy assumes of it. Catches the edits most likely to happen — someone
 *     adds a repo, retires a tier, or reworks the script.
 *
 *   - **Live** (needs `gh`, skips honestly via `##SKIP##`). Runs repo-gate against
 *     the real account and checks the *coverage* properties: no repo in scope by
 *     the policy's own rule is missing from it, and no declared repo has vanished.
 *
 * What the live half deliberately does NOT assert: that drift is zero. Sixteen
 * repos are knowingly mid-migration from the retired `update` rule (#288), and a
 * suite that fails on a known-open task teaches people to ignore it. The drift
 * count is surveyed and printed instead — the #256 lesson, that an assertion over
 * a set you have not actually established is worse than a number you can read.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { skip } from "./lib/skips.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POLICY_PATH = path.join(REPO_ROOT, "docs", "repo-policy.json");
const GATE_PATH = path.join(REPO_ROOT, "bin", "repo-gate");

const policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
const gateSrc = fs.readFileSync(GATE_PATH, "utf8");

const KNOWN_STATUSES = new Set(["ok", "drift", "n/a", "unlisted", "gone", "error"]);

// ---
// Structure — offline
// ---

describe("docs/repo-policy.json is internally coherent", () => {
	it("declares its schema", () => {
		assert.strictEqual(policy.schema, "repo-policy@1");
	});

	it("every repo maps to a tier that exists", () => {
		for (const [repo, tier] of Object.entries(policy.repos)) {
			assert.ok(policy.tiers[tier as string],
				`repo '${repo}' is assigned tier '${tier}', which no tier defines`);
		}
	});

	it("no repo is both governed and excluded", () => {
		// A repo in both maps reads as governed in one place and deliberately
		// out of scope in another, and repo-gate would report it while the file
		// says not to care. Cheap to write, impossible to notice by eye at 29 rows.
		const both = Object.keys(policy.repos).filter(r => r in policy.scope.excluded);
		assert.deepStrictEqual(both, [], `these repos appear in both repos and scope.excluded: ${both.join(", ")}`);
	});

	it("the protected baseline is a strict subset of gated", () => {
		// The whole point of collapsing to one baseline (#288) was that the tiers
		// stop differing in more than one dimension. This is the assertion that
		// keeps that true: gated must be protected PLUS required_status_checks, not
		// protected-with-edits. Without it, the two drift apart the next time
		// someone tunes one of them.
		const protectedRules = policy.tiers.protected.rules;
		const gatedRules = policy.tiers.gated.rules;
		for (const [type, params] of Object.entries(protectedRules)) {
			assert.deepStrictEqual(gatedRules[type], params,
				`gated.${type} differs from protected.${type} — the tiers may differ only by required_status_checks`);
		}
		const extra = Object.keys(gatedRules).filter(k => !(k in protectedRules));
		assert.deepStrictEqual(extra, ["required_status_checks"],
			"gated must add exactly required_status_checks and nothing else");
	});

	it("the retired `update` rule appears in no tier", () => {
		// tier_history records that `update` was dropped fleet-wide because
		// `pull_request` subsumes it. If it reappears in a tier, the history is
		// lying and the fleet is back to two incompatible shapes.
		for (const [name, tier] of Object.entries<any>(policy.tiers)) {
			assert.ok(!(tier.rules && "update" in tier.rules),
				`tier '${name}' reintroduces the retired \`update\` rule (see policy.tier_history)`);
		}
		assert.ok(policy.tier_history?.update_rule_dropped,
			"tier_history.update_rule_dropped must survive as the record of why");
	});

	it("the plan-blocked waiver names the condition that expires it", () => {
		// A waiver that cannot expire is a blind spot with better manners. This
		// field is what repo-gate re-probes every run.
		const t = policy.tiers["plan-blocked"];
		assert.strictEqual(t.expect_no_ruleset, true);
		assert.ok(t.waiver_expires_when, "plan-blocked must state what would end the waiver");
	});

	it("the enforcement disclosure carries every field repo-gate prints", () => {
		const d = policy.enforcement_disclosure;
		assert.ok(d.summary, "summary is missing");
		assert.ok(d.what_is_actually_enforced, "what_is_actually_enforced is missing");
		assert.ok(Array.isArray(d.why) && d.why.length > 0, "why must be a non-empty array");
		assert.ok(Array.isArray(d.bypass_actors) && d.bypass_actors.length > 0,
			"bypass_actors is the claim that makes every other claim interpretable");
	});

	it("the disclosure admits the rules bind nobody who is an admin", () => {
		// The one sentence this whole design exists to keep honest. If someone
		// softens it into "the default branch is protected", the report starts
		// implying enforcement it does not have, and an agent will act on that.
		const blob = JSON.stringify(policy.enforcement_disclosure).toLowerCase();
		assert.ok(blob.includes("signal"), "the disclosure must still say these rules are a signal");
		assert.ok(blob.includes("bypass"), "the disclosure must still name the bypass");
	});
});

describe("bin/repo-gate honours the contract the policy assumes", () => {
	it("is executable", () => {
		assert.doesNotThrow(() => fs.accessSync(GATE_PATH, fs.constants.X_OK));
	});

	it("prints the disclosure from the policy rather than a copy of it", () => {
		// Citation check, same idiom as ruleset-claims: the script must READ
		// .enforcement_disclosure out of the policy file. A hardcoded paraphrase in
		// the script would keep printing the old wording after the policy is
		// corrected, which is exactly the drift this file exists to prevent.
		assert.ok(gateSrc.includes(".enforcement_disclosure"),
			"repo-gate must render the disclosure from the policy file");
	});

	it("documents the shared pr-* exit codes", () => {
		for (const code of ["0", "2", "3", "4", "5", "6"]) {
			assert.ok(new RegExp(`^#\\s+${code}\\s`, "m").test(gateSrc),
				`bin/repo-gate's header does not document exit ${code}`);
		}
		assert.ok(gateSrc.includes("could not check"),
			"the 5-vs-6 distinction must survive in the header — it is the whole point of the table");
	});

	it("--help mentions --why", () => {
		const r = spawnSync(GATE_PATH, ["--help"], { encoding: "utf8", timeout: 15_000 });
		assert.strictEqual(r.status, 0);
		assert.ok(r.stdout.includes("--why"), "every tool's --help must mention --why (tool-conventions.md)");
	});

	it("--why states the anti-use-case", () => {
		const r = spawnSync(GATE_PATH, ["--why"], { encoding: "utf8", timeout: 15_000 });
		assert.strictEqual(r.status, 0);
		assert.ok(/NOT FOR/.test(r.stdout), "--why must include at least one anti-use-case");
		assert.ok(r.stdout.includes("Run repo-gate --help"), "--why must close with the --help pointer");
	});

	it("an unknown flag is a usage error, not a run", () => {
		const r = spawnSync(GATE_PATH, ["--nope"], { encoding: "utf8", timeout: 15_000 });
		assert.strictEqual(r.status, 2, "bad flags exit 2 per the shared table");
	});

	it("a missing policy file is exit 4, and says where it looked", () => {
		const r = spawnSync(GATE_PATH, ["--policy", "/nonexistent/repo-policy.json"], {
			encoding: "utf8", timeout: 15_000,
		});
		assert.strictEqual(r.status, 4, "not found is exit 4 per the shared table");
		assert.ok(/Searched:/.test(r.stderr), "the refusal must name the search order it used");
	});

	// The failure this guards is the only one that points the WRONG way: a policy
	// that parses but is missing a structure the script reads unguarded used to
	// produce an empty fleet, three bash "integer expression expected" errors, and
	// **exit 0** — a caller reading only the exit code would conclude every repo is
	// compliant. Hermetic: validation runs before any `gh` call, so there is no network.
	for (const key of [
		"repos",
		"tiers",
		"scope.target",
		"scope.excluded",
		"enforcement_disclosure.bypass_actors",
	]) {
		it(`a policy missing .${key} is exit 3, never a quiet 0`, () => {
			const broken = structuredClone(policy);
			const parts = key.split(".");
			let node: Record<string, unknown> = broken;
			for (const p of parts.slice(0, -1)) node = node[p] as Record<string, unknown>;
			delete node[parts.at(-1)!];

			const tmp = path.join(os.tmpdir(), `repo-gate-nokey-${parts.join("_")}-${process.pid}.json`);
			fs.writeFileSync(tmp, JSON.stringify(broken));
			try {
				const r = spawnSync(GATE_PATH, ["--policy", tmp], { encoding: "utf8", timeout: 15_000 });
				assert.strictEqual(r.status, 3, `missing .${key} must refuse with exit 3, got ${r.status}`);
				assert.ok(
					r.stderr.includes(`.${key}`),
					`the refusal must name the missing key rather than leaving the reader to bisect the policy. stderr: ${r.stderr}`,
				);
			} finally {
				fs.rmSync(tmp, { force: true });
			}
		});
	}

	it("a policy that exists but is unreadable is exit 3, not 4", () => {
		// 4 means "not there". A file sitting right in front of you with the wrong mode
		// is a different problem, and reporting it as missing sends the reader hunting
		// for a path that already exists. Skipped as root, where 000 is still readable.
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		const tmp = path.join(os.tmpdir(), `repo-gate-unreadable-${process.pid}.json`);
		fs.copyFileSync(POLICY_PATH, tmp);
		fs.chmodSync(tmp, 0o000);
		try {
			const r = spawnSync(GATE_PATH, ["--policy", tmp], { encoding: "utf8", timeout: 15_000 });
			assert.strictEqual(r.status, 3, "present-but-unreadable is exit 3");
			assert.ok(
				/not a missing-file problem|unreadable/i.test(r.stderr),
				`the refusal must not read as "not found". stderr: ${r.stderr}`,
			);
		} finally {
			fs.chmodSync(tmp, 0o644);
			fs.rmSync(tmp, { force: true });
		}
	});

	it("an invalid policy file is exit 3, distinct from missing", () => {
		// 3 vs 4 is the same "could not proceed" vs "not there" split the rest of
		// the family draws. A malformed policy that reported "not found" would send
		// the reader looking for a file that is sitting right in front of them.
		const tmp = path.join(os.tmpdir(), `repo-gate-invalid-${process.pid}.json`);
		fs.writeFileSync(tmp, "{ not json");
		try {
			const r = spawnSync(GATE_PATH, ["--policy", tmp], { encoding: "utf8", timeout: 15_000 });
			assert.strictEqual(r.status, 3, "unreadable-but-present is exit 3");
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	});

	it("refuses a repo the policy does not govern", () => {
		const r = spawnSync(GATE_PATH, ["--remedy", "not-a-real-repo"], {
			encoding: "utf8", timeout: 15_000, cwd: REPO_ROOT,
		});
		assert.strictEqual(r.status, 2, "naming an ungoverned repo is a usage error, not an empty report");
	});
});

// ---
// Live — needs gh, skips honestly
// ---

function runGate(): { report?: any; skipReason?: string } {
	const env = Object.fromEntries(
		// Same stale-token problem as ruleset-claims: a set-but-invalid GH_TOKEN is
		// exclusive-use and gh never falls back to the keyring.
		Object.entries(process.env).filter(([k]) => k !== "GH_TOKEN" && k !== "GITHUB_TOKEN"),
	) as NodeJS.ProcessEnv;
	env.GH_CONFIG_DIR = process.env.GH_CONFIG_DIR ?? path.join(os.homedir(), ".config", "gh");

	const r = spawnSync(GATE_PATH, ["--json", "--policy", POLICY_PATH], {
		encoding: "utf8", env, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
	});

	if (r.error && (r.error as any).code === "ENOENT") return { skipReason: "bin/repo-gate did not execute" };
	// 0 and 6 both mean the run completed and produced a report; 6 just means it
	// found drift, which is a legitimate answer and not a reason to skip.
	if (r.status !== 0 && r.status !== 6) {
		const why = `${r.stderr ?? ""}`.trim().split("\n")[0] || `repo-gate exited ${r.status}`;
		return { skipReason: `repo-gate could not survey the account (${why})` };
	}
	try {
		return { report: JSON.parse(r.stdout) };
	} catch {
		return { skipReason: "repo-gate --json did not emit parseable JSON" };
	}
}

describe("the live account still matches the policy's coverage claims", () => {
	const { report, skipReason } = runGate();

	it("the account is reachable", () => {
		if (skipReason) {
			skip(`no live fleet survey — ${skipReason}; ` +
				`${Object.keys(policy.repos).length} declared repos went unverified`);
			return;
		}
		assert.ok(report, "expected a repo-gate/report@1 document");
	});

	it("emits the declared document schema", () => {
		if (!report) return;
		assert.strictEqual(report.schema, "repo-gate/report@1");
	});

	it("no repo is waived as plan-blocked while the plan offers rulesets", () => {
		// The bug this file did not catch for the tool's whole life (#299). Twelve
		// private repos sat unprotected under a waiver that was FALSE the entire time:
		// the account is `pro`, but the token could not read `.plan`, so the probe said
		// `indeterminate` on every run and nobody noticed the waiver had never once been
		// verified. Now that the probe resolves, the contradiction is assertable.
		if (!report) return;
		if (report.plan?.status !== "expired") return; // free plan or unverifiable — nothing to assert
		const waived = Object.entries(policy.repos)
			.filter(([, tier]) => tier === "plan-blocked")
			.map(([repo]) => repo);
		assert.deepStrictEqual(
			waived, [],
			`the plan probe says '${report.plan.detail}', so these repos are excused by a condition ` +
			`that is false: ${waived.join(", ")}`,
		);
	});

	it("an indeterminate plan probe is surfaced, never treated as a passing check", () => {
		// The second half of the same lesson: `indeterminate` was reported honestly and
		// still went unread. If the probe ever stops resolving, this states plainly that
		// every plan-blocked waiver is unverified rather than satisfied.
		if (!report) return;
		if (report.plan?.status !== "indeterminate") return;
		const waived = Object.entries(policy.repos).filter(([, t]) => t === "plan-blocked").length;
		assert.strictEqual(
			waived, 0,
			`the plan could not be verified (${report.plan.detail}), so ${waived} plan-blocked ` +
			`waiver(s) are assumptions, not facts. Grant the gh token read:user scope.`,
		);
	});

	it("reports one record per declared repo", () => {
		if (!report) return;
		const declared = Object.keys(policy.repos).sort();
		const reported = report.repos
			.filter((r: any) => r.status !== "unlisted")
			.map((r: any) => r.repo)
			.sort();
		assert.deepStrictEqual(reported, declared,
			"every declared repo must appear exactly once — a repo silently dropped from the report is a repo nobody is checking");
	});

	it("every record carries a known status", () => {
		if (!report) return;
		for (const r of report.repos) {
			assert.ok(KNOWN_STATUSES.has(r.status), `repo ${r.repo} has unknown status '${r.status}'`);
		}
	});

	it("no repo is in scope by the policy's own rule yet missing from it", () => {
		if (!report) return;
		const unlisted = report.repos.filter((r: any) => r.status === "unlisted").map((r: any) => r.repo);
		assert.deepStrictEqual(unlisted, [],
			`these repos match the scope rule but are absent from docs/repo-policy.json: ${unlisted.join(", ")}.\n` +
			`  Add each to repos with a tier, or to scope.excluded with a reason. Leaving them out is how coverage shrinks silently.`);
	});

	it("no declared repo has vanished from the account", () => {
		if (!report) return;
		const gone = report.repos.filter((r: any) => r.status === "gone").map((r: any) => r.repo);
		assert.deepStrictEqual(gone, [], `declared but not present on the account: ${gone.join(", ")}`);
	});

	it("every drift record carries a remedy an agent can run", () => {
		if (!report) return;
		for (const r of report.repos.filter((d: any) => d.status === "drift")) {
			assert.ok(typeof r.remedy === "string" && r.remedy.length > 0,
				`drift on ${r.repo} has no remedy — a report that names a problem without naming the fix makes the reader do the derivation every time`);
		}
	});

	// Survey, not assertion (#256): drift is knowingly non-zero until the apply
	// pass runs, and a red suite for a known-open task is a suite people learn to
	// skip. The number is printed so it can be watched going down.
	it("surveys the fleet", () => {
		if (!report) return;
		const c = report.counts;
		console.log(`  #288-fleet  total=${c.total}  ok=${c.ok}  drift=${c.drift}  na=${c.na}  ` +
			`unlisted=${c.unlisted}  gone=${c.gone}  error=${c.error}  plan=${report.plan.status}`);
		assert.strictEqual(c.ok + c.drift + c.na + c.unlisted + c.gone + c.error, c.total,
			"every repo must land in exactly one bucket — the accounting IS the test");
	});
});

console.log("✅ All repo-policy tests passed.");

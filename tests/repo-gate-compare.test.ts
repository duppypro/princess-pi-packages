/**
 * Fixture-driven coverage for repo-gate's comparison block (#288, #289 review).
 *
 * WHY THIS FILE EXISTS. `tests/repo-policy.test.ts` guards the policy *document*
 * and repo-gate's *refusals* — both cheap, both offline. Neither touches the part
 * that actually decides whether a repo is compliant: the jq block that diffs a live
 * ruleset against its declared tier. Every finding in the #289 review landed there
 * or in the lookups feeding it, and each was caught by a reviewer reading the source
 * rather than by anything that would catch it again. Seven rounds of that is the
 * signal to stop reviewing and start asserting.
 *
 * HOW IT WORKS. repo-gate reaches GitHub only through `gh`, so a stub `gh` earlier
 * on PATH turns the whole script into a pure function of its fixtures. Tests then
 * drive the real binary end to end and assert on `--json` — the documented
 * `repo-gate/report@1` contract — rather than on internals. That is deliberate:
 * these must survive the comparison being rewritten, or they are testing the wrong
 * thing.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. Exact prose of `detail`. The structured fields
 * (`status`, `problems`, `counts`) are the contract; the sentences are not, and
 * pinning them would make every wording improvement a test failure.
 */

import * as assert from "node:assert";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GATE_PATH = path.join(REPO_ROOT, "bin", "repo-gate");
const REAL_POLICY = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "docs", "repo-policy.json"), "utf8"),
);

const OWNER = "testowner";
const RULESET = "protect-default-branch-owner-only";

/**
 * The stub. Dispatches on the argv repo-gate actually sends, and fails loudly on
 * anything unrecognised — a silent `[]` here would let a test pass by accident,
 * which is the same class of bug as the one that started this file.
 */
const GH_STUB = `#!/usr/bin/env bash
set -u
F="\$RG_FIXTURES"
args="\$*"
case "\$args" in
  *" user"|"api user") cat "\$F/user.json"; exit 0 ;;
esac
for a in "\$@"; do
  case "\$a" in
    user/repos*) cat "\$F/repos.json"; exit 0 ;;
    repos/*/rulesets\\?per_page=100)
      name="\${a#repos/${OWNER}/}"; name="\${name%/rulesets?per_page=100}"
      [ -f "\$F/listfail-\$name" ] && exit 1
      cat "\$F/list-\$name.json"; exit 0 ;;
    repos/*/rulesets/*)
      id="\${a##*/}"
      [ -f "\$F/getfail-\$id" ] && exit 1
      cat "\$F/rs-\$id.json"; exit 0 ;;
  esac
done
echo "gh stub: unhandled: \$args" >&2
exit 99
`;

type Ruleset = Record<string, unknown>;

/** A ruleset that matches the `protected` tier exactly — the baseline each case perturbs. */
function compliant(id: number): Ruleset {
	return {
		id,
		name: RULESET,
		target: "branch",
		enforcement: "active",
		conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
		bypass_actors: REAL_POLICY.enforcement_disclosure.bypass_actors,
		rules: [
			{ type: "deletion" },
			{ type: "non_fast_forward" },
			{
				type: "pull_request",
				parameters: {
					required_approving_review_count: 0,
					required_review_thread_resolution: true,
				},
			},
		],
	};
}

interface Scenario {
	/** repo name -> tier */
	repos?: Record<string, string>;
	/** repo name -> the ruleset list endpoint's response (pages, as --slurp returns) */
	lists?: Record<string, Ruleset[][]>;
	/** ruleset id -> the individual GET response */
	rulesets?: Record<number, Ruleset>;
	/** repos present on the account (defaults to the keys of `repos`) */
	account?: { name: string; private?: boolean; fork?: boolean; created?: string }[];
	plan?: string | null;
	listFail?: string[];
	getFail?: number[];
	args?: string[];
}

function run(s: Scenario) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-gate-fx-"));
	try {
		const repos = s.repos ?? { alpha: "protected" };
		const account =
			s.account ??
			Object.keys(repos).map((name) => ({ name, private: false, fork: false, created: "2020-01-01T00:00:00Z" }));

		fs.writeFileSync(
			path.join(dir, "user.json"),
			JSON.stringify(s.plan === null ? {} : { plan: { name: s.plan ?? "free" } }),
		);
		// `user/repos` is read with `gh api --paginate` (no --slurp) and parsed by
		// `jq -s ... add`, so the wire format is CONCATENATED page arrays with no outer
		// wrapper. The ruleset lists below use --slurp and therefore *are* an array of
		// pages. Getting these two backwards produces "could not parse the repository
		// list", which is how this comment came to exist.
		fs.writeFileSync(
			path.join(dir, "repos.json"),
			JSON.stringify(
				account.map((r) => ({
					name: r.name,
					owner: { login: OWNER },
					private: r.private ?? false,
					fork: r.fork ?? false,
					created_at: r.created ?? "2020-01-01T00:00:00Z",
				})),
			),
		);
		for (const [name, pages] of Object.entries(s.lists ?? {})) {
			fs.writeFileSync(path.join(dir, `list-${name}.json`), JSON.stringify(pages));
		}
		for (const [id, rs] of Object.entries(s.rulesets ?? {})) {
			fs.writeFileSync(path.join(dir, `rs-${id}.json`), JSON.stringify(rs));
		}
		for (const n of s.listFail ?? []) fs.writeFileSync(path.join(dir, `listfail-${n}`), "");
		for (const id of s.getFail ?? []) fs.writeFileSync(path.join(dir, `getfail-${id}`), "");

		const policy = {
			...REAL_POLICY,
			owner: OWNER,
			ruleset_name: RULESET,
			repos,
			scope: { ...REAL_POLICY.scope, excluded: {} },
		};
		const policyPath = path.join(dir, "policy.json");
		fs.writeFileSync(policyPath, JSON.stringify(policy));

		const binDir = path.join(dir, "bin");
		fs.mkdirSync(binDir);
		fs.writeFileSync(path.join(binDir, "gh"), GH_STUB, { mode: 0o755 });

		const r = spawnSync(GATE_PATH, ["--policy", policyPath, "--json", ...(s.args ?? [])], {
			encoding: "utf8",
			timeout: 20_000,
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RG_FIXTURES: dir },
		});
		assert.ok(
			!r.stderr.includes("gh stub: unhandled"),
			`the stub saw a request it does not model — the test is lying, not passing:\n${r.stderr}`,
		);
		const json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
		return { status: r.status, stderr: r.stderr, json, byRepo: (n: string) => json?.repos?.find((x: { repo: string }) => x.repo === n) };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("repo-gate comparison — the compliant baseline", () => {
	it("an exactly-matching ruleset is ok, and the run exits 0", () => {
		const r = run({ lists: { alpha: [[compliant(1)]] }, rulesets: { 1: compliant(1) } });
		assert.strictEqual(r.byRepo("alpha").status, "ok");
		assert.strictEqual(r.json.counts.drift, 0);
		assert.strictEqual(r.status, 0, "a clean fleet must exit 0");
	});
});

describe("repo-gate comparison — each way a ruleset can be wrong", () => {
	/**
	 * One perturbation per case. Named for the property lost, not the field changed,
	 * because the field is an implementation detail of the API and the property is
	 * what the policy actually promises.
	 */
	const cases: { name: string; mutate: (rs: Ruleset) => void; expect: RegExp }[] = [
		{
			name: "a rule the tier requires is absent",
			mutate: (rs) => { (rs.rules as unknown[]).splice(2, 1); },
			expect: /missing rule: pull_request/,
		},
		{
			name: "a rule the tier does not declare is present",
			mutate: (rs) => { (rs.rules as unknown[]).push({ type: "update" }); },
			expect: /unexpected rule: update/,
		},
		{
			name: "a pinned rule parameter differs",
			mutate: (rs) => {
				const pr = (rs.rules as Record<string, unknown>[]).find((x) => x.type === "pull_request")!;
				(pr.parameters as Record<string, unknown>).required_review_thread_resolution = false;
			},
			expect: /pull_request\.required_review_thread_resolution/,
		},
		{
			name: "enforcement is not active",
			mutate: (rs) => { rs.enforcement = "evaluate"; },
			expect: /enforcement/,
		},
		{
			name: "the ruleset targets a different ref",
			mutate: (rs) => {
				(rs.conditions as { ref_name: { include: string[] } }).ref_name.include = ["refs/heads/legacy"];
			},
			expect: /target/,
		},
		{
			// The #289 review found this one. It is the nastiest shape here: `include`
			// matches, so every other check passes, and the exclude quietly removes the
			// branch the rule exists to protect.
			name: "the default branch is included and then excluded again",
			mutate: (rs) => {
				(rs.conditions as { ref_name: { exclude: string[] } }).ref_name.exclude = ["~DEFAULT_BRANCH"];
			},
			expect: /target/,
		},
		{
			// The disclosure printed on every run is derived from this. If bypass drifts
			// and the report stays green, every other line it prints becomes misleading.
			name: "bypass actors differ from the disclosed set",
			mutate: (rs) => { rs.bypass_actors = []; },
			expect: /bypass_actors/,
		},
	];

	for (const c of cases) {
		it(`${c.name} -> drift`, () => {
			const rs = compliant(1);
			c.mutate(rs);
			const r = run({ lists: { alpha: [[rs]] }, rulesets: { 1: rs } });
			const rec = r.byRepo("alpha");
			assert.strictEqual(rec.status, "drift", `expected drift, got ${rec.status}: ${rec.detail}`);
			assert.ok(
				rec.problems.some((p: string) => c.expect.test(p)),
				`no problem matched ${c.expect}; got ${JSON.stringify(rec.problems)}`,
			);
			assert.strictEqual(r.status, 6, "any drift must exit 6");
		});
	}
});

describe("repo-gate comparison — lookup hazards the #289 review found", () => {
	it("a ruleset on page 2 is found, not reported missing", () => {
		// The list endpoint pages at 30. Before --paginate, a ruleset here read as
		// absent and the remedy became a duplicate-creating POST.
		const filler = Array.from({ length: 30 }, (_, i) => ({ id: 900 + i, name: `unrelated-${i}` }));
		const r = run({
			lists: { alpha: [filler, [compliant(1)]] },
			rulesets: { 1: compliant(1) },
		});
		assert.strictEqual(r.byRepo("alpha").status, "ok", "the second page must be read");
	});

	it("two rulesets sharing the name is drift, and no single-ruleset PUT is offered", () => {
		const r = run({
			lists: { alpha: [[compliant(1), compliant(2)]] },
			rulesets: { 1: compliant(1), 2: compliant(2) },
		});
		const rec = r.byRepo("alpha");
		assert.strictEqual(rec.status, "drift", "an ambiguous name cannot be reported ok");
		assert.ok(
			!/-X PUT/.test(rec.remedy),
			"a PUT would fix one and leave the other in force, so none may be offered",
		);
		assert.match(rec.remedy, /DELETE/, "the remedy must be to remove the extras");
	});

	it("no ruleset at all is drift with a create remedy", () => {
		const r = run({ lists: { alpha: [[]] } });
		const rec = r.byRepo("alpha");
		assert.strictEqual(rec.status, "drift");
		assert.match(rec.remedy, /-X POST/, "nothing there means create");
	});
});

describe("repo-gate — unreadable is never reported as clean", () => {
	it("a failed ruleset list is error and exits 5, not ok and 0", () => {
		const r = run({ lists: { alpha: [[compliant(1)]] }, listFail: ["alpha"] });
		assert.strictEqual(r.byRepo("alpha").status, "error");
		assert.strictEqual(r.status, 5, "a fleet that could not be read must not exit 0 or 6");
		assert.strictEqual(r.json.counts.ok, 0);
	});

	it("a ruleset that lists but cannot be read individually is error, not drift", () => {
		// Distinct from drift on purpose: "I could not look" and "I looked and it is
		// wrong" are different facts and only one is safe to ignore.
		const r = run({ lists: { alpha: [[compliant(1)]] }, rulesets: { 1: compliant(1) }, getFail: [1] });
		assert.strictEqual(r.byRepo("alpha").status, "error");
		assert.strictEqual(r.status, 5);
	});
});

describe("repo-gate — coverage properties, not just per-repo verdicts", () => {
	it("a declared repo absent from the account is gone", () => {
		const r = run({
			repos: { alpha: "protected", vanished: "protected" },
			account: [{ name: "alpha" }],
			lists: { alpha: [[compliant(1)]] },
			rulesets: { 1: compliant(1) },
		});
		assert.strictEqual(r.byRepo("vanished").status, "gone");
		assert.strictEqual(r.status, 6);
	});

	it("an in-scope repo the policy never mentions is unlisted", () => {
		// Without this, creating a repo silently leaves it ungoverned while the report
		// stays green — coverage shrinking with no signal is the failure mode.
		const r = run({
			repos: { alpha: "protected" },
			account: [{ name: "alpha" }, { name: "newcomer" }],
			lists: { alpha: [[compliant(1)]] },
			rulesets: { 1: compliant(1) },
		});
		assert.ok(r.json.repos.some((x: { repo: string; status: string }) => x.repo === "newcomer" && x.status === "unlisted"));
		assert.strictEqual(r.status, 6, "shrinking coverage is not a clean run");
	});
});

describe("repo-gate — the plan-blocked waiver expires on its own", () => {
	it("a free plan holds the waiver: no ruleset expected, status n/a", () => {
		const r = run({ repos: { alpha: "plan-blocked" }, lists: { alpha: [[]] }, plan: "free" });
		assert.strictEqual(r.byRepo("alpha").status, "n/a");
	});

	it("a paid plan expires the waiver: the same repo becomes drift", () => {
		// The waiver is the one claim that could quietly outlive its reason, so it is
		// re-probed every run rather than trusted from the file.
		const r = run({ repos: { alpha: "plan-blocked" }, lists: { alpha: [[]] }, plan: "pro" });
		assert.strictEqual(r.byRepo("alpha").status, "drift");
		assert.match(r.byRepo("alpha").remedy, /-X POST/, "an expired waiver must offer the protected remedy");
	});

	it("a plan-blocked repo that unexpectedly HAS a ruleset is drift, not n/a", () => {
		const r = run({ repos: { alpha: "plan-blocked" }, lists: { alpha: [[compliant(1)]] }, plan: "free" });
		assert.strictEqual(r.byRepo("alpha").status, "drift", "the tier's own assumption is wrong for this repo");
	});
});

describe("repo-gate — findings that arrived while the earlier ones were being fixed", () => {
	it("an expired waiver on a repo that ALREADY has the ruleset offers PUT, not POST", () => {
		// Passing an empty id here made remedy_for synthesize a create, which on a repo
		// that already has the ruleset produces a second one — the same duplicate this
		// PR fixed elsewhere, reached by a different road.
		const r = run({
			repos: { alpha: "plan-blocked" },
			lists: { alpha: [[compliant(7)]] },
			rulesets: { 7: compliant(7) },
			plan: "pro",
		});
		const rec = r.byRepo("alpha");
		assert.strictEqual(rec.status, "drift");
		assert.match(rec.remedy, /-X PUT/, "an existing ruleset must be updated, never duplicated");
		assert.ok(!/-X POST/.test(rec.remedy), "a POST here creates a second ruleset");
	});

	it("an unverifiable plan makes a plan-blocked-only run exit 5, not 0", () => {
		// The waiver is the only thing excusing these repos from having a ruleset. If it
		// could not be checked, their state is unknown — and n/a + exit 0 claims an audit
		// that did not happen.
		const r = run({ repos: { alpha: "plan-blocked" }, lists: { alpha: [[]] }, plan: null });
		assert.strictEqual(r.byRepo("alpha").status, "n/a");
		assert.strictEqual(r.json.plan.status, "indeterminate");
		assert.strictEqual(r.status, 5, "an unchecked waiver is 'could not look', not 'looked and it was fine'");
	});

	it("a verified free plan keeps the same run at exit 0", () => {
		// The control for the case above: when the probe SUCCEEDS, n/a is a real answer
		// and the run is clean. Without this, the fix above could have been "always 5".
		const r = run({ repos: { alpha: "plan-blocked" }, lists: { alpha: [[]] }, plan: "free" });
		assert.strictEqual(r.byRepo("alpha").status, "n/a");
		assert.strictEqual(r.status, 0);
	});

	it("a repo assigned to an undefined tier is exit 3, not a ruleset with no rules", () => {
		const r = run({ repos: { alpha: "no-such-tier" }, lists: { alpha: [[]] }, plan: "free" });
		assert.strictEqual(r.status, 3, "a policy that cannot describe its own repos is unusable");
		assert.match(r.stderr, /no-such-tier|does not define/, "the refusal must name the offending assignment");
	});
});

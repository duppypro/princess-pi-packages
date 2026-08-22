/**
 * #412 — the mechanical half. `bin/pr-review` runs under `set -euo pipefail`, so
 * a bare command that fails exits 1 and never reaches the script's own gate.
 * `bin/pr-open` maps every code but 7 and 8 to "proceed", which is how a raise
 * inside a python3 heredoc silently converts a BLOCKED pr into an OPENED one.
 *
 * Round 3 of #396's history fixed exactly one of nine such sites and commented
 * it thoroughly. The invariant it established is not checkable by a person
 * reading 1700 lines, which is why this file exists: every python3 invocation
 * in bin/pr-review must be inside a guarded shape.
 *
 * NOT vacuous (#408): `scan()` is exercised against a deliberately broken sample
 * at the bottom of this file, so the scanner is proven able to report a
 * violation. Deleting a guard from bin/pr-review turns the first test red.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "bin", "pr-review");

/**
 * Lines that INVOKE python3, with the guard state around each.
 *
 * Heredoc bodies are skipped: `import json` inside PYEOF is python, not a shell
 * command. A group opened as `if ! {` / `if {` counts as guarded for everything
 * inside it — that is the shape H1 uses, where the redirection of the whole
 * group is what can fail.
 */
function scan(source: string): { line: number; text: string; guarded: boolean }[] {
	const out: { line: number; text: string; guarded: boolean }[] = [];
	const lines = source.split("\n");
	let heredocTag: string | null = null;
	let groupDepth = 0;
	// A multi-line `if` condition: everything up to the `then` is a condition,
	// whose exit status the `if` consumes rather than `set -e`.
	let inCondition = false;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const text = raw.trim();
		if (heredocTag !== null) {
			if (text === heredocTag) heredocTag = null;
			continue;
		}
		if (text.startsWith("#")) continue;
		// An `if`/`if !` that opens a brace group guards every command inside it.
		if (/^if\s+!?\s*\{\s*$/.test(text)) groupDepth++;
		else if (groupDepth > 0 && /^\}/.test(text)) groupDepth--;
		if (/^if\s/.test(text) && !/(^|;\s*)then\b/.test(text)) inCondition = true;

		if (/(^|[\s(=])python3(\s|$)/.test(text) && !/command -v python3/.test(text)) {
			// No assignment-form clause. `VAR=$(python3 …)` with no `||` DOES trip
			// errexit (`set -e; x=$(false); echo unreached` never echoes), so
			// treating the assignment shape as self-guarding would have passed the
			// exact regression this file exists to catch — dropping the trailing
			// `|| DEDUP="?"` from bin/pr-review's one such line (pr-review round 1,
			// reasoning lens, High). `||` is the only thing that absorbs it, and
			// the `/\|\|/` test already sees it.
			const guarded =
				groupDepth > 0 || inCondition || /^if\s/.test(text) || /\|\|/.test(text);
			out.push({ line: i + 1, text, guarded });
		}
		if (inCondition && /(^|;\s*)then\b/.test(text)) inCondition = false;
		const hd = raw.match(/<<'([A-Z0-9_]+)'/);
		if (hd) heredocTag = hd[1];
	}
	return out;
}

describe("#412 every python3 invocation in bin/pr-review is guarded", () => {
	const source = readFileSync(SCRIPT, "utf8");

	test("no bare python3 invocation survives set -e", () => {
		const unguarded = scan(source).filter((h) => !h.guarded);
		expect(
			unguarded.map((h) => `bin/pr-review:${h.line}  ${h.text.slice(0, 80)}`),
		).toEqual([]);
	});

	test("the scan finds every invocation, so an empty result cannot mean 'nothing looked'", () => {
		// Nine today (#412 H1-H8 plus PYSAFE and the two `python3 -c` sites). A
		// floor, not an equality: adding a guarded invocation must not fail here,
		// but a scan that silently matched nothing must.
		expect(scan(source).length).toBeGreaterThanOrEqual(9);
	});

	test("the scanner reports a bare invocation — proof it can fail", () => {
		const broken = [
			"set -euo pipefail",
			"python3 - \"$LOG\" <<'PYBARE'",
			"import json",
			"PYBARE",
			"exit 7",
		].join("\n");
		const found = scan(broken);
		expect(found.length).toBe(1);
		expect(found[0].guarded).toBe(false);
	});

	// SOURCE-TEXT checks (#408: say so). H5-H7 are not python3, so the scan above
	// cannot see them; each pins the guard shape the fix introduced, matching a
	// spelling only the guarded version produces.
	test("H5 — the work directory's mktemp carries its own exit-3 handler", () => {
		expect(source).toMatch(/WORK=\$\(mktemp -d "\$TMP_PARENT\/pr-review\.X+"\) \|\| \{/);
	});

	test("H6 — the collector's summary is read inside a guard, not bare", () => {
		expect(source).toMatch(/if ! read -r RAWCOUNT NFAILED NRAN < "\$WORK\/summary"; then/);
		expect(source).not.toMatch(/^read -r RAWCOUNT/m);
	});

	test("H7 — the --json path cannot exit 1 with empty stdout", () => {
		expect(source).toMatch(/if ! cat "\$LOG"; then/);
		expect(source).not.toMatch(/^ {2}cat "\$LOG"$/m);
	});

	test("an assignment with no || fallback is NOT guarded", () => {
		// `x=$(false)` under set -e kills the script, so this shape is a hazard,
		// not a guard. The scanner said otherwise until pr-review round 1.
		const found = scan("DEDUP=$(python3 -c 'print(1)')");
		expect(found.length).toBe(1);
		expect(found[0].guarded).toBe(false);
	});

	test("the scanner accepts each guarded shape this file uses", () => {
		const shapes = [
			"if python3 - \"$W\" <<'PYA'\nx = 1\nPYA\nthen :; else echo no; fi",
			"python3 - \"$LOG\" <<'PYB' || true\nx = 1\nPYB",
			"if ! {\n  python3 - \"$LOG\" <<'PYC'\nx = 1\nPYC\n} > \"$W/out\"; then :; fi",
			"DEDUP=$(python3 -c 'print(1)') || DEDUP=\"?\"",
			"if ! command -v python3 ||\n   ! python3 -c 'print(1)'; then\n  echo no\nfi",
		];
		for (const s of shapes) {
			const found = scan(s);
			expect(found.length, s).toBe(1);
			expect(found[0].guarded, s).toBe(true);
		}
	});
});

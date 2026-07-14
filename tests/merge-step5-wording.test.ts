// --- Step 5 commit-message word-rule tests (#100) ---
//
// Spec (Duppy, 2026-07-14): the merge tool accepts a target commit as Step 5
// when its SUBJECT LINE (first line, case-insensitive, whole-word matches) has
// some occurrence of "approved" such that:
//   - "code" appears before it
//   - one of "spec|specs|specification|specifications" appears before it
//   - "not" does NOT appear anywhere before it
// No fixed phrases ("Step 5", "Code and Spec Approved") are required.
//
// Runner: self-contained script, imports TS source directly (repo convention —
// see tests/config-loader.test.ts). Run with: bun tests/merge-step5-wording.test.ts

import { isStep5ApprovedMessage } from "../extensions/lib/merge/core.js";

const PASS: [string, string][] = [
	["house style", "docs(wtft): Code and Spec Approved — daemon lifecycle reconciled (#95) 👑π🐱"],
	["leading-phrase style", "docs: Code and Spec Approved — spec + CLAUDE.md reconciled (#97) 👑π🐱"],
	["the #97 rejection that motivated this issue", "docs: reconcile spec + CLAUDE.md + inline comments to tested code (#97, Code and Spec Approved) 👑π🐱"],
	["free word order, spec before code", "Specs and code approved, ship it"],
	["case-insensitive + singular specification", "CODE and SPECIFICATION APPROVED"],
	["second approved occurrence qualifies", "Code approved and spec approved"],
	["'not' after approved is allowed", "code and spec approved — but not yet published"],
	["'notably' is not the word 'not'", "notably, code and spec approved"],
];

const FAIL: [string, string][] = [
	["Step 4 style — no spec word", "test: bun build + TS7 migration verified (#97, Code Approved)"],
	["spec only — no code word", "docs: Spec Approved — daemon lifecycle (#95)"],
	["'not' immediately before", "Code and Spec not approved"],
	["'not' anywhere before", "not ready: code and spec approved"],
	["approved precedes the required words", "approved: code and spec"],
	["no 'approved' at all", "feat: bun build.ts (#97, Code Draft, ready for test)"],
	["'approval' is not 'approved'", "Code and Spec Approval"],
	["'encode'/'decode' are not the word 'code'", "decode the specs — approved"],
	["body text must not rescue the subject", "test: verified (#97, Code Approved)\n\nspec reconciled and approved in body"],
	["empty message", ""],
];

let failures = 0;
for (const [name, msg] of PASS) {
	if (!isStep5ApprovedMessage(msg)) {
		console.error(`❌ should PASS but failed: ${name}\n   "${msg.split("\n")[0]}"`);
		failures++;
	}
}
for (const [name, msg] of FAIL) {
	if (isStep5ApprovedMessage(msg)) {
		console.error(`❌ should FAIL but passed: ${name}\n   "${msg.split("\n")[0]}"`);
		failures++;
	}
}

if (failures > 0) {
	console.error(`\n${failures} case(s) wrong.`);
	process.exit(1);
}
console.log(`✅ merge Step 5 wording: all ${PASS.length + FAIL.length} cases correct.`);

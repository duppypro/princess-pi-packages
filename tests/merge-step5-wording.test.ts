// --- DEPRECATED: isStep5ApprovedMessage (#188) ---
//
// The commit-message regex gate has been removed from the merge flow. This
// function now always returns true — kept for backward-compatibility with
// any code that imports it, but it performs no validation.
//
// The test verifies the deprecation contract: the export still exists and
// returns true for any input.

import { isStep5ApprovedMessage } from "../extensions/lib/merge/core.js";

const SAMPLES = [
	"docs: Code and Spec Approved — original house style",
	"feat: add widget (Code Draft)",
	"hotfix: fix typo",
	"",
];

let failures = 0;
for (const msg of SAMPLES) {
	if (!isStep5ApprovedMessage(msg)) {
		console.error(`FAIL: isStep5ApprovedMessage returned false for "${msg}" (should always be true)`);
		failures++;
	}
}

if (failures > 0) {
	process.exit(1);
}
console.log(`✅ isStep5ApprovedMessage deprecated (#188): returns true for all ${SAMPLES.length} samples.`);

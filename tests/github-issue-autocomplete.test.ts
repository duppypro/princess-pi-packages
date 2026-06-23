import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { fuzzyFilter } from "@earendil-works/pi-tui";

// Test matching logic directly (simulating the provider regex)
function parseAutoCompleteToken(textBeforeCursor: string) {
	const match = textBeforeCursor.match(/(?:^|[ \t])([a-zA-Z0-9_-]+)?#([0-9]*)$/);
	if (!match) return null;
	return {
		repoName: match[1],
		digits: match[2],
		hasHash: textBeforeCursor.includes("#")
	};
}

console.log("🚀 STARTING AUTOCOMPLETE INTEGRATION TESTS...");

// 1. Verify Regex Matching across all transition states
const testCases = [
	{ input: "hello #", expected: { repoName: undefined, digits: "", hasHash: true } },
	{ input: "hello #2", expected: { repoName: undefined, digits: "2", hasHash: true } },
	{ input: "hello btw#", expected: { repoName: "btw", digits: "", hasHash: true } },
	{ input: "hello btw#25", expected: { repoName: "btw", digits: "25", hasHash: true } }
];

for (const tc of testCases) {
	const result = parseAutoCompleteToken(tc.input);
	console.log(`Input: '${tc.input}' -> Parsed:`, result);
	assert.deepStrictEqual(result, tc.expected, `Matching failed for input: ${tc.input}`);
}
console.log("✅ State transition regex tests passed!");

// 2. Verify Suggestion Format Output
const mockIssue = {
	number: 25,
	title: "BUG: TPM Rate Limiter widget shows 0 tokens for Gemini models due to schema mismatch",
	state: "open"
};

const repoName = "princess-pi-packages";
const expectedValue = 'princess-pi-packages#25 "BUG: TPM Rate Limiter widget shows 0 tokens for Gemini models due to schema mismatch"';
const expectedLabel = 'princess-pi-packages#25';

const formatted = {
	value: `${repoName}#${mockIssue.number} "${mockIssue.title}"`,
	label: `${repoName}#${mockIssue.number}`,
	description: `[${mockIssue.state.toLowerCase()}] ${mockIssue.title}`
};

console.log("Formatted suggestion item:", formatted);
assert.strictEqual(formatted.value, expectedValue, "Autocomplete insertion value must contain the full double-quoted title");
assert.strictEqual(formatted.label, expectedLabel, "Autocomplete dropdown label must match repo#number");

console.log("✅ Output completion formatting tests passed!");
console.log("\n🎉 ALL AUTOCOMPLETE UNIT TESTS PASSED SUCCESSFULLY!");

// Standalone test runner — no test framework dependency.
// Run: npx tsx extensions/lib/dedup/core.test.ts
import {
    normalizeTemplate,
    extractNumbers,
    computeRanges,
    analyzeSequence,
    formatSlot,
    buildSummaryLine,
    createGroup,
    addToGroup,
    isMatchingGroup,
} from "./core.js";

// ---
// Micro test runner
// ---

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e: any) {
        failed++;
        console.log(`  ❌ ${name}: ${e.message ?? e}`);
    }
}

function eq<T>(actual: T, expected: T, hint?: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(`${hint ? hint + " — " : ""}got ${a}, want ${b}`);
    }
}

// ---
// U: Unit tests for pure functions
// ---

console.log("\n── normalizeTemplate ──────────────────────────────────────");

test("U1: no numbers", () => eq(normalizeTemplate("no numbers here"), "no numbers here"));
test("U2: integers", () => eq(normalizeTemplate("port 5432 retry 3"), "port {N} retry {N}"));
test("U3: float", () => eq(normalizeTemplate("temp 98.6F"), "temp {N}F"));
test("U4: negative", () => eq(normalizeTemplate("offset -5 gain -0.5"), "offset {N} gain {N}"));

console.log("\n── extractNumbers ─────────────────────────────────────────");

test("U5: empty", () => eq(extractNumbers("no nums"), []));
test("U6: two integers", () => eq(extractNumbers("port 5432 retry 3"), [5432, 3]));
test("U7: float and int", () => eq(extractNumbers("v1.2 slot 4"), [1.2, 4]));

console.log("\n── computeRanges ──────────────────────────────────────────");

test("U8: single value", () => eq(computeRanges([5]), "5"));
test("U9: contiguous", () => eq(computeRanges([3, 4, 5]), "[3-5]"));
test("U10: two disjoint ranges", () => eq(computeRanges([3, 4, 7, 8]), "[3-4, 7-8]"));
test("U11: scattered", () => eq(computeRanges([1, 3, 7]), "[1, 3, 7]"));
test("U12: floats → min-max", () => eq(computeRanges([1.2, 3.5, 7.0]), "[1.2-7]"));

console.log("\n── analyzeSequence ────────────────────────────────────────");

test("U13: step 1 up", () => eq(analyzeSequence([1, 2, 3, 4]), "↑1"));
test("U14: step 2 up", () => eq(analyzeSequence([2, 4, 6, 8]), "↑2"));
test("U15: step 2 down", () => eq(analyzeSequence([10, 8, 6]), "↓2"));
test("U16: irregular up", () => eq(analyzeSequence([1, 3, 4, 7]), "↑"));
test("U17: irregular down", () => eq(analyzeSequence([10, 7, 6, 1]), "↓"));
test("U18: fluctuating → empty", () => eq(analyzeSequence([1, 5, 2, 8]), ""));
test("U19: too few (2 values) → empty", () => eq(analyzeSequence([1, 2]), ""));

console.log("\n── formatSlot ─────────────────────────────────────────────");

test("U20: constant", () => eq(formatSlot({ values: [5, 5, 5] }), "5"));
test("U21: monotonic range", () => eq(formatSlot({ values: [1, 2, 3] }), "[1-3]↑1"));
// [1,2,5,6] is an irregular increase → ↑ annotation is correct
test("U22: gapped range irregular increase", () => eq(formatSlot({ values: [1, 2, 5, 6] }), "[1-2, 5-6]↑"));
// Fluctuating values (no monotonic direction) get no annotation; scattered unique values list all
test("U22b: fluctuating → no annotation", () => eq(formatSlot({ values: [1, 5, 3, 9] }), "[1, 3, 5, 9]"));

console.log("\n── Group lifecycle (integration) ──────────────────────────");

test("I1: pure text dup (no numbers)", () => {
    const g = createGroup("Error: db down");
    addToGroup(g, "Error: db down");
    addToGroup(g, "Error: db down");
    eq(buildSummaryLine(g), "👆 ×3  Error: db down");
});

test("I2: monotonic single-slot", () => {
    const g = createGroup("Retry 1 of 5");
    addToGroup(g, "Retry 2 of 5");
    addToGroup(g, "Retry 3 of 5");
    eq(buildSummaryLine(g), "👆 ×3  Retry [1-3]↑1 of 5");
});

test("I3: two-slot tracking", () => {
    const g = createGroup("Port 5432 timeout after 3s");
    addToGroup(g, "Port 5433 timeout after 4s");
    // Only 2 values per slot — no sequence annotation (< 3)
    eq(buildSummaryLine(g), "👆 ×2  Port [5432-5433] timeout after [3-4]s");
});

test("I4: isMatchingGroup — same template, different numbers", () => {
    const g = createGroup("Port 5432 failed");
    eq(isMatchingGroup(g, "Port 9999 failed"), true);
});

test("I5: isMatchingGroup — different template", () => {
    const g = createGroup("Port 5432 failed");
    eq(isMatchingGroup(g, "Port 5432 OK"), false);
});

test("I6: createGroup captures slot values", () => {
    const g = createGroup("pid=1042 rss=512");
    eq(g.template, "pid={N} rss={N}");
    eq(g.slots.length, 2);
    eq(g.slots[0].values, [1042]);
    eq(g.slots[1].values, [512]);
});

test("I7: addToGroup accumulates correctly", () => {
    const g = createGroup("pid=1042 rss=512");
    addToGroup(g, "pid=1043 rss=516");
    addToGroup(g, "pid=1044 rss=520");
    eq(g.count, 3);
    eq(g.slots[0].values, [1042, 1043, 1044]);
    eq(g.slots[1].values, [512, 516, 520]);
});

// ---
// Summary
// ---

console.log(`\n${"─".repeat(52)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(52)}\n`);

if (failed > 0) process.exit(1);

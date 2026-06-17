// Pure dedup logic — no I/O, fully testable in isolation.
// Why split from dedup.ts: keeps Pi extension scaffolding separate from the algorithm,
// making unit tests runnable without importing the Pi agent type system.

// ---
// Number extraction and template normalization
// ---

// Matches integers, floats, and negative numbers.
// Floats must have digits on both sides of the decimal point.
const NUM_RE = /-?\d+(\.\d+)?/g;

export function normalizeTemplate(line: string): string {
    return line.replace(new RegExp(NUM_RE.source, "g"), "{N}");
}

export function extractNumbers(line: string): number[] {
    return (line.match(new RegExp(NUM_RE.source, "g")) ?? []).map(Number);
}

// ---
// Group state
// ---

export interface SlotValues {
    values: number[];
}

export interface DupGroup {
    template: string;
    count: number;
    slots: SlotValues[];   // one slot per {N} in template, in order
    firstLine: string;
}

export function createGroup(line: string): DupGroup {
    const nums = extractNumbers(line);
    return {
        template: normalizeTemplate(line),
        count: 1,
        slots: nums.map((v) => ({ values: [v] })),
        firstLine: line,
    };
}

export function addToGroup(group: DupGroup, line: string): void {
    const nums = extractNumbers(line);
    group.count++;
    // Accumulate each number into its corresponding slot.
    // If the new line has fewer numbers than the template (shouldn't happen
    // if isMatchingGroup passed, but guard anyway), extras are skipped.
    nums.forEach((n, i) => {
        if (group.slots[i]) group.slots[i].values.push(n);
    });
}

export function isMatchingGroup(group: DupGroup, line: string): boolean {
    return normalizeTemplate(line) === group.template;
}

// ---
// Range and sequence analysis
// ---

// Build contiguous integer ranges from a sorted unique list.
// e.g. [3,4,5,8,9] → "[3-5, 8-9]"
export function computeRanges(values: number[]): string {
    const allInts = values.every((v) => Number.isInteger(v));
    const unique = [...new Set(values)].sort((a, b) => a - b);

    if (unique.length === 0) return "";
    if (unique.length === 1) return String(unique[0]);

    if (!allInts) {
        // For floats, just show min–max
        return `[${unique[0]}-${unique[unique.length - 1]}]`;
    }

    // Build contiguous integer ranges
    const ranges: [number, number][] = [];
    let start = unique[0];
    let prev = unique[0];

    for (let i = 1; i < unique.length; i++) {
        if (unique[i] === prev + 1) {
            prev = unique[i];
        } else {
            ranges.push([start, prev]);
            start = prev = unique[i];
        }
    }
    ranges.push([start, prev]);

    if (ranges.length === 1 && ranges[0][0] === ranges[0][1]) {
        return String(ranges[0][0]);
    }

    return "[" + ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ") + "]";
}

// Detect direction and step of the sequence of observed values (in arrival order).
// Returns an annotation string like "↑1", "↓2", "↑", "↓", or "" for fluctuating.
// Requires ≥ 3 values; fewer is not enough to establish a pattern.
export function analyzeSequence(values: number[]): string {
    if (values.length < 3) return "";

    const diffs = values.slice(1).map((v, i) => v - values[i]);
    const allPos = diffs.every((d) => d > 0);
    const allNeg = diffs.every((d) => d < 0);
    if (!allPos && !allNeg) return ""; // fluctuating

    const step = diffs[0];
    const uniform = diffs.every((d) => d === step);

    if (allPos) return uniform ? `↑${step}` : "↑";
    return uniform ? `↓${Math.abs(step)}` : "↓";
}

// Format a single number slot into a human-readable summary.
export function formatSlot(slot: SlotValues): string {
    const { values } = slot;
    const unique = [...new Set(values)];
    if (unique.length === 1) return String(unique[0]); // constant across all dups

    const ranges = computeRanges(values);
    const seq = analyzeSequence(values);
    return seq ? `${ranges}${seq}` : ranges;
}

// ---
// Summary line construction
// ---

// Reconstructs the line template, substituting each {N} with a formatted slot summary,
// then prepends the count badge.
export function buildSummaryLine(group: DupGroup): string {
    let slotIdx = 0;
    const reconstructed = group.template.replace(/\{N\}/g, () => {
        const slot = group.slots[slotIdx++];
        return slot ? formatSlot(slot) : "{N}";
    });
    return `👆 ×${group.count}  ${reconstructed}`;
}

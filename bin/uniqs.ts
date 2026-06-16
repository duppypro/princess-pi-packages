#!/usr/bin/env -S node --experimental-strip-types
/**
 * @package princess-pi-packages
 * @command uniqs
 * @description Dynamic streaming log deduplicator with fuzzy matching and periodicity detection.
 */

import * as readline from "readline";

// --- CLI Option Parsing ---
interface CLIOptions {
  similarity: number;
  format: string;
  wordMatch: boolean;
  periodicity: boolean;
  noCollapse: boolean;
}

const options: CLIOptions = {
  similarity: 0.85,
  format: "☝️ +{count}",
  wordMatch: true,
  periodicity: true,
  noCollapse: false,
};

function printHelp() {
  console.log(`
Usage: uniqs [options]

Options:
  -s, --similarity <num>  Similarity threshold between 0.0 and 1.0 (default: 0.85)
  -f, --format <string>   Custom collapse badge format (default: "☝️ +{count}")
  -w, --word-match <bool> Match general word changes, not just numbers (default: true)
  -p, --no-periodicity    Disable advanced periodicity detection
  --no-collapse           Disable in-place terminal rewriting (behaves like streaming uniq -c)
  -h, --help              Display this help menu
`);
}

// Simple manual argument parser
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  } else if (arg === "-s" || arg === "--similarity") {
    const val = parseFloat(process.argv[++i]);
    if (!isNaN(val) && val >= 0 && val <= 1) {
      options.similarity = val;
    }
  } else if (arg === "-f" || arg === "--format") {
    options.format = process.argv[++i];
  } else if (arg === "-w" || arg === "--word-match") {
    const val = process.argv[++i];
    options.wordMatch = val !== "false";
  } else if (arg === "-p" || arg === "--no-periodicity") {
    options.periodicity = false;
  } else if (arg === "--no-collapse") {
    options.noCollapse = true;
  }
}

// --- Log Timestamp Parser ---
interface ParsedLog {
  timestamp: number | null;
  timestampPrefix: string;
  payload: string;
}

function parseLogTimestamp(line: string): ParsedLog {
  // ISO 8601 / RFC 3339
  const isoRegex = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b\s*)/;
  let match = line.match(isoRegex);
  if (match) {
    const rawTime = match[1].trim();
    const t = Date.parse(rawTime.replace(',', '.'));
    if (!isNaN(t)) {
      return { timestamp: t, timestampPrefix: match[1], payload: line.slice(match[1].length) };
    }
  }

  // Apache/Common log format (e.g. [10/Oct/2000:13:55:36 -0700])
  const apacheRegex = /^(\[(\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4})\]\s*)/;
  match = line.match(apacheRegex);
  if (match) {
    const rawTime = match[2];
    const parts = rawTime.split(':');
    const datePart = parts[0].replace(/\//g, ' '); // "10 Oct 2000"
    const timePart = parts.slice(1).join(':'); // "13:55:36 -0700"
    const t = Date.parse(`${datePart} ${timePart}`);
    if (!isNaN(t)) {
      return { timestamp: t, timestampPrefix: match[1], payload: line.slice(match[1].length) };
    }
  }

  // Epoch ms (13 digits) at start of line
  const epochMsRegex = /^(\[(\d{13})\]\s*|^\b(\d{13})\b\s*)/;
  match = line.match(epochMsRegex);
  if (match) {
    const val = match[2] || match[3];
    const t = parseInt(val, 10);
    return { timestamp: t, timestampPrefix: match[1], payload: line.slice(match[1].length) };
  }

  // Epoch seconds (10 digits) at start of line
  const epochSecRegex = /^(\[(\d{10})\]\s*|^\b(\d{10})\b\s*)/;
  match = line.match(epochSecRegex);
  if (match) {
    const val = match[2] || match[3];
    const t = parseInt(val, 10) * 1000;
    return { timestamp: t, timestampPrefix: match[1], payload: line.slice(match[1].length) };
  }

  // Time-only at start of line (e.g. 12:00:01)
  const timeOnlyRegex = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*)/;
  match = line.match(timeOnlyRegex);
  if (match) {
    const todayStr = new Date().toISOString().split('T')[0];
    const t = Date.parse(`${todayStr}T${match[1].trim()}Z`);
    if (!isNaN(t)) {
      return { timestamp: t, timestampPrefix: match[1], payload: line.slice(match[1].length) };
    }
  }

  return { timestamp: null, timestampPrefix: "", payload: line };
}

// --- Structural Template Matcher ---
interface TemplateMatch {
  isMatch: boolean;
  template: string;
  slots: { index: number; value: string; prevValue: string }[];
}

function getTemplateMatch(prev: string, curr: string, threshold: number, allowWordMatch: boolean): TemplateMatch {
  if (prev === curr) {
    return { isMatch: true, template: prev, slots: [] };
  }

  // Tokenize preserving spaces and common delimiters
  const regex = /(\s+|,|;|:|=|\[|\]|\(|\))/;
  const tokensPrev = prev.split(regex);
  const tokensCurr = curr.split(regex);

  if (tokensPrev.length !== tokensCurr.length) {
    return { isMatch: false, template: '', slots: [] };
  }

  let matchingCount = 0;
  const slots: { index: number; value: string; prevValue: string }[] = [];
  const templateParts: string[] = [];

  for (let i = 0; i < tokensPrev.length; i++) {
    const tP = tokensPrev[i];
    const tC = tokensCurr[i];

    if (tP === tC) {
      if (tP.trim().length > 0 && !regex.test(tP)) {
        matchingCount++;
      }
      templateParts.push(tP);
    } else {
      const isNum = /^\d+(\.\d+)?$/.test(tP) && /^\d+(\.\d+)?$/.test(tC);
      const isWord = /^[A-Za-z0-9_-]+$/.test(tP) && /^[A-Za-z0-9_-]+$/.test(tC);

      if (isNum || (allowWordMatch && isWord)) {
        slots.push({ index: i, value: tC, prevValue: tP });
        templateParts.push(`{slot_${slots.length - 1}}`);
      } else {
        return { isMatch: false, template: '', slots: [] };
      }
    }
  }

  const totalWords = tokensPrev.filter(t => t.trim().length > 0 && !regex.test(t)).length;
  const score = totalWords > 0 ? matchingCount / totalWords : 0;

  // Check if all slots represent numeric changes
  const allSlotsNumeric = slots.length > 0 && slots.every(s => 
    /^\d+(\.\d+)?$/.test(s.value) && /^\d+(\.\d+)?$/.test(s.prevValue)
  );

  // Match if:
  // 1. All differing slots are numeric (e.g., port or thread ID differences in short lines)
  // 2. Or the similarity score meets the threshold (for non-numeric word changes)
  const isMatch = (slots.length > 0 && allSlotsNumeric) || score >= threshold;

  if (isMatch) {
    return {
      isMatch: true,
      template: templateParts.join(''),
      slots
    };
  }

  return { isMatch: false, template: '', slots: [] };
}

// --- Sequence Range Formatter ---
function formatRange(values: string[]): string {
  const uniqueVals = Array.from(new Set(values));
  if (uniqueVals.length === 1) return uniqueVals[0];

  const numVals = uniqueVals.map(v => Number(v));
  const allNumbers = numVals.every(n => !isNaN(n));

  if (!allNumbers) {
    if (uniqueVals.length <= 4) {
      return uniqueVals.join(', ');
    } else {
      return `${uniqueVals.slice(0, 3).join(', ')}, ...`;
    }
  }

  numVals.sort((a, b) => a - b);

  const groups: { start: number; end: number }[] = [];
  let start = numVals[0];
  let prev = numVals[0];

  for (let i = 1; i < numVals.length; i++) {
    const curr = numVals[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      groups.push({ start, end: prev });
      start = curr;
      prev = curr;
    }
  }
  groups.push({ start, end: prev });

  const formattedGroups = groups.map(g => {
    if (g.start === g.end) {
      return `${g.start}`;
    } else {
      return `${g.start}-${g.end}`;
    }
  });

  return formattedGroups.join(', ');
}

// --- Periodicity Analysis ---
function analyzePeriodicity(times: number[]): string | null {
  if (times.length < 3) return null;
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) {
    deltas.push(times[i] - times[i - 1]);
  }

  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variance = deltas.reduce((sum, d) => sum + Math.pow(d - mean, 2), 0) / deltas.length;
  const stdDev = Math.sqrt(variance);

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const secs = ms / 1000;
    if (secs < 60) return `${secs.toFixed(1).replace(/\.0$/, "")}s`;
    const mins = secs / 60;
    return `${mins.toFixed(1).replace(/\.0$/, "")}m`;
  };

  if (stdDev < Math.max(100, mean * 0.15)) {
    return `every ~${formatDuration(mean)}`;
  }

  const clusters: { mean: number; count: number }[] = [];
  const threshold = 0.2;

  for (const delta of deltas) {
    let placed = false;
    for (const cluster of clusters) {
      if (Math.abs(delta - cluster.mean) / cluster.mean < threshold) {
        cluster.mean = (cluster.mean * cluster.count + delta) / (cluster.count + 1);
        cluster.count++;
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ mean: delta, count: 1 });
    }
  }

  clusters.sort((a, b) => b.count - a.count);

  if (clusters.length === 1) {
    return `every ~${formatDuration(clusters[0].mean)}`;
  } else if (clusters.length > 1) {
    const totalDeltas = deltas.length;
    const prominent = clusters.filter(c => c.count >= Math.max(2, totalDeltas * 0.2));
    if (prominent.length > 1) {
      return `every ~${formatDuration(prominent[0].mean)} and ~${formatDuration(prominent[1].mean)}`;
    } else {
      return `every ~${formatDuration(clusters[0].mean)}`;
    }
  }

  return null;
}

// --- Active Block State Management ---
interface BlockState {
  rawFirstLine: string;
  rawFirstPayload: string;
  timestampPrefix: string;
  template: string;
  count: number;
  slots: { [key: number]: string[] };
  timestamps: number[];
}

let activeBlock: BlockState | null = null;
const isTTY = process.stdout.isTTY && !options.noCollapse;

function formatBadge(count: number, periodicity: string | null): string {
  const base = options.format.replace("{count}", count.toString());
  return periodicity ? `${base} (${periodicity})` : base;
}

function renderBlock(state: BlockState, finalizing = false) {
  // Reconstruct line with ranges inserted in template
  let formattedPayload = state.template;
  const numSlots = Object.keys(state.slots).length;

  for (let i = 0; i < numSlots; i++) {
    const slotVals = state.slots[i];
    const rangeStr = formatRange(slotVals);
    const displayVal = (slotVals.length > 1 && rangeStr.includes(",")) ? `[${rangeStr}]` : rangeStr;
    formattedPayload = formattedPayload.replace(`{slot_${i}}`, displayVal);
  }

  const reconstructedLine = state.timestampPrefix + formattedPayload;

  if (isTTY) {
    if (state.count === 0) {
      // First line in interactive mode: just print it
      process.stdout.write(reconstructedLine + "\n");
    } else {
      // Subsequent duplicates: move cursor up, clear line, and reprint updated line with count badge
      const periodicityStr = options.periodicity ? analyzePeriodicity(state.timestamps) : null;
      const badge = formatBadge(state.count, periodicityStr);
      process.stdout.write(`\x1b[1A\x1b[2K${reconstructedLine} ${badge}\n`);
    }
  } else {
    // Non-interactive/redirected mode: only print when finalized or on initial line
    if (finalizing) {
      if (state.count === 0) {
        process.stdout.write(reconstructedLine + "\n");
      } else {
        const periodicityStr = options.periodicity ? analyzePeriodicity(state.timestamps) : null;
        const badge = formatBadge(state.count, periodicityStr);
        process.stdout.write(`${reconstructedLine} ${badge}\n`);
      }
    }
  }
}

function finalizeActiveBlock() {
  if (activeBlock) {
    if (!isTTY) {
      renderBlock(activeBlock, true);
    }
    activeBlock = null;
  }
}

// --- Main Processing Loop ---
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  const parsed = parseLogTimestamp(line);
  const currentTime = parsed.timestamp ?? Date.now();

  if (!activeBlock) {
    // Start first block
    activeBlock = {
      rawFirstLine: line,
      rawFirstPayload: parsed.payload,
      timestampPrefix: parsed.timestampPrefix,
      template: parsed.payload,
      count: 0,
      slots: {},
      timestamps: [currentTime],
    };
    renderBlock(activeBlock);
    return;
  }

  // Attempt to match with the block's first line payload
  const match = getTemplateMatch(activeBlock.rawFirstPayload, parsed.payload, options.similarity, options.wordMatch);

  if (match.isMatch) {
    // Update active block
    activeBlock.count++;
    activeBlock.timestamps.push(currentTime);

    // If template has slots, initialize/update slot values
    if (match.slots.length > 0) {
      // On first matched duplicate, extract variables from the first line too
      if (Object.keys(activeBlock.slots).length === 0) {
        match.slots.forEach((s, idx) => {
          activeBlock!.slots[idx] = [s.prevValue];
        });
      }

      // Append new slot values
      match.slots.forEach((s, idx) => {
        if (!activeBlock!.slots[idx]) activeBlock!.slots[idx] = [];
        activeBlock!.slots[idx].push(s.value);
      });
    }

    // Update template to the new match's template
    activeBlock.template = match.template;

    renderBlock(activeBlock);
  } else {
    // Finalize previous block and start a new one
    finalizeActiveBlock();

    activeBlock = {
      rawFirstLine: line,
      rawFirstPayload: parsed.payload,
      timestampPrefix: parsed.timestampPrefix,
      template: parsed.payload,
      count: 0,
      slots: {},
      timestamps: [currentTime],
    };
    renderBlock(activeBlock);
  }
});

rl.on("close", () => {
  finalizeActiveBlock();
});

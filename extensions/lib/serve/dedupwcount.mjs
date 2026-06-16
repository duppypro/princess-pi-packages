const VARIABLE_TOKEN_RE = /(-?\d+(?:\.\d+)?|\b[A-Za-z]\b)/g;

function toToken(raw) {
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    return { kind: "num", value: Number(raw), raw };
  }
  if (/^[A-Za-z]$/.test(raw)) {
    return { kind: "alpha", value: raw.toUpperCase().charCodeAt(0), raw: raw.toUpperCase() };
  }
  return null;
}

export function parsePattern(line) {
  const vars = [];
  const signature = line.replace(VARIABLE_TOKEN_RE, (raw) => {
    const token = toToken(raw);
    if (!token) return raw;
    vars.push(token);
    return token.kind === "num" ? "{#}" : "{@}";
  });
  return { line, signature, vars };
}

function buildRanges(values, kind) {
  if (values.length === 0) return "";
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    ranges.push([start, prev]);
    start = v;
    prev = v;
  }
  ranges.push([start, prev]);
  return ranges
    .map(([a, b]) => {
      if (kind === "alpha") {
        const sa = String.fromCharCode(a);
        const sb = String.fromCharCode(b);
        return a === b ? sa : `${sa}-${sb}`;
      }
      return a === b ? String(a) : `${a}-${b}`;
    })
    .join(", ");
}

function getTrend(diffs) {
  if (diffs.length === 0) return "flat";
  const hasPos = diffs.some((d) => d > 0);
  const hasNeg = diffs.some((d) => d < 0);
  if (hasPos && hasNeg) return "mixed";
  if (hasPos) return "up";
  if (hasNeg) return "down";
  return "flat";
}

function getSmoothness(diffs) {
  if (diffs.length === 0) return "";
  const magnitudes = diffs.map((d) => Math.abs(d)).filter(Boolean);
  if (magnitudes.length === 0) return "";
  const smooth = magnitudes.every((m) => m === 1);
  return smooth ? "smooth" : "gappy";
}

function initStats(parsed) {
  return parsed.vars.map((v) => ({
    kind: v.kind,
    values: [v.value],
    last: v.value,
    diffs: [],
  }));
}

function updateStats(stats, parsed) {
  for (let i = 0; i < stats.length; i++) {
    const nextVal = parsed.vars[i].value;
    const s = stats[i];
    s.values.push(nextVal);
    s.diffs.push(nextVal - s.last);
    s.last = nextVal;
  }
}

function formatSummary(state) {
  if (state.stats.length === 0) return "";
  const parts = state.stats.map((s, i) => {
    const ranges = buildRanges(s.values, s.kind);
    const trend = getTrend(s.diffs);
    const smoothness = getSmoothness(s.diffs);
    return `${s.kind === "num" ? "#" : "@"}${i + 1}=[${ranges}] ${trend}${smoothness ? `, ${smoothness}` : ""}`;
  });
  return ` (${parts.join("; ")})`;
}

export function createDedupState() {
  return {
    current: null,
  };
}

function canCollapse(current, nextParsed) {
  if (!current) return false;
  if (current.parsed.signature !== nextParsed.signature) return false;
  if (current.parsed.vars.length !== nextParsed.vars.length) return false;
  for (let i = 0; i < current.parsed.vars.length; i++) {
    if (current.parsed.vars[i].kind !== nextParsed.vars[i].kind) return false;
  }
  return true;
}

export function ingestLine(state, line) {
  const parsed = parsePattern(line);

  if (!state.current) {
    state.current = {
      parsed,
      count: 1,
      stats: initStats(parsed),
    };
    return { kind: "base", text: line };
  }

  if (!canCollapse(state.current, parsed)) {
    state.current = {
      parsed,
      count: 1,
      stats: initStats(parsed),
    };
    return { kind: "base", text: line };
  }

  state.current.count += 1;
  updateStats(state.current.stats, parsed);
  return {
    kind: "update",
    text: `☝️ +${state.current.count - 1}${formatSummary(state.current)}`,
  };
}

export function compressLines(lines) {
  const state = createDedupState();
  return lines.map((line) => ingestLine(state, line).text);
}

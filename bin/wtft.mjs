#!/usr/bin/env node
/**
 * @package princess-pi-packages
 * @command wtft
 * @description Standalone CLI port of extensions/wtft.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- INLINED FROM extensions/lib/wtft-shared.ts ---
import * as path from "node:path";
function parseInterval(val) {
  const match = /^(\d+)([mhdw])$/.exec(val);
  if (match) {
    const size = parseInt(match[1], 10);
    const unit = match[2];
    if (size > 0) return { size, unit };
  }
  return { size: 1, unit: "h" };
}
function classifyInteraction(interaction) {
  const specPaths = /* @__PURE__ */ new Set();
  const codePaths = /* @__PURE__ */ new Set();
  const testsPaths = /* @__PURE__ */ new Set();
  const researchPaths = /* @__PURE__ */ new Set();
  for (const f of interaction.files) {
    const norm = f.path.replace(/\\/g, "/");
    let category = null;
    if (norm.startsWith("docs/") || norm.includes("/docs/") || norm.endsWith("AGENTS.md") || norm.endsWith("ARCHITECTURE.md") || norm.endsWith("README.md") || path.extname(norm).toLowerCase() === ".md") {
      category = "spec";
    } else if (norm.startsWith("tests/") || norm.includes("/tests/")) {
      category = "tests";
    } else if (norm.startsWith("research/") || norm.includes("/research/")) {
      category = "research";
    } else if (norm.startsWith(".pi/extensions/") || norm.includes("/.pi/extensions/") || norm.startsWith("extensions/") || norm.includes("/extensions/") || norm.startsWith("src/") || norm.includes("/src/") || norm.startsWith("public/") || norm.includes("/public/") || norm.startsWith("bin/") || norm.includes("/bin/")) {
      category = "code";
    } else {
      const ext = path.extname(norm).toLowerCase();
      if ([".ts", ".js", ".mjs", ".json", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml"].includes(ext)) {
        category = "code";
      }
    }
    if (category === "spec") specPaths.add(f.action);
    else if (category === "code") codePaths.add(f.action);
    else if (category === "tests") testsPaths.add(f.action);
    else if (category === "research") researchPaths.add(f.action);
  }
  const specWrites = specPaths.has("write");
  const codeWrites = codePaths.has("write");
  const testsWrites = testsPaths.has("write");
  const researchWrites = researchPaths.has("write");
  const writeCount = (specWrites ? 1 : 0) + (codeWrites ? 1 : 0) + (testsWrites ? 1 : 0) + (researchWrites ? 1 : 0);
  if (writeCount > 1) return "mixed";
  if (writeCount === 1) {
    if (specWrites) return "spec";
    if (codeWrites) return "code";
    if (testsWrites) return "tests";
    if (researchWrites) return "research";
  }
  const hasSpec = specPaths.has("read");
  const hasCode = codePaths.has("read");
  const hasTests = testsPaths.has("read");
  const hasResearch = researchPaths.has("read");
  const readCount = (hasSpec ? 1 : 0) + (hasCode ? 1 : 0) + (hasTests ? 1 : 0) + (hasResearch ? 1 : 0);
  if (readCount > 1) return "mixed";
  if (hasSpec) return "spec";
  if (hasCode) return "code";
  if (hasTests) return "tests";
  if (hasResearch) return "research";
  if (interaction.commands.length > 0) {
    let isGit = false;
    let isGrep = false;
    for (const cmd of interaction.commands) {
      const lower = cmd.toLowerCase().trim();
      if (lower === "git" || lower.startsWith("git ")) {
        isGit = true;
      } else if (lower === "grep" || lower.startsWith("grep ") || lower === "rg" || lower.startsWith("rg ") || lower === "ripgrep" || lower.startsWith("ripgrep ") || lower === "find" || lower.startsWith("find ")) {
        isGrep = true;
      }
    }
    if (isGit) return "git";
    if (isGrep) return "grep";
    return "other";
  }
  if (interaction.texts.length > 0) return "prompt";
  return "other";
}
function getZonedParts(timestamp, tz) {
  const d = new Date(timestamp);
  if (!tz) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds()
    };
  }
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    const partMap = {};
    for (const p of parts) partMap[p.type] = p.value;
    let hour = parseInt(partMap.hour, 10);
    if (hour === 24) hour = 0;
    return {
      year: parseInt(partMap.year, 10),
      month: parseInt(partMap.month, 10),
      day: parseInt(partMap.day, 10),
      hour,
      minute: parseInt(partMap.minute, 10),
      second: parseInt(partMap.second, 10)
    };
  } catch {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds()
    };
  }
}
function getIsoWeekAndMonday(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const mondayDate = new Date(date.getTime() - diffToMonday * 24 * 60 * 60 * 1e3);
  const thursdayDate = new Date(mondayDate.getTime() + 3 * 24 * 60 * 60 * 1e3);
  const targetYear = thursdayDate.getUTCFullYear();
  const jan1 = new Date(Date.UTC(targetYear, 0, 1));
  const jan1Day = jan1.getUTCDay();
  const firstThursday = new Date(jan1.getTime() + (4 - jan1Day + 7) % 7 * 24 * 60 * 60 * 1e3);
  const weekNum = 1 + Math.round((thursdayDate.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1e3));
  return {
    weekNum,
    mondayYear: mondayDate.getUTCFullYear(),
    mondayMonth: mondayDate.getUTCMonth() + 1,
    mondayDay: mondayDate.getUTCDate()
  };
}
function getBinInfo(timestamp, config, tz) {
  const parts = getZonedParts(timestamp, tz);
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
  const { size, unit } = config;
  if (unit === "m") {
    const totalMins = parts.hour * 60 + parts.minute;
    const binnedMins = Math.floor(totalMins / size) * size;
    return {
      key: `${dateStr}T${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}:00`,
      label: `${pad(Math.floor(binnedMins / 60))}:${pad(binnedMins % 60)}`,
      dateStr
    };
  } else if (unit === "h") {
    const startHours = Math.floor(parts.hour / size) * size;
    return {
      key: `${dateStr}T${pad(startHours)}:00:00`,
      label: `${pad(startHours)}:00`,
      dateStr
    };
  } else if (unit === "d") {
    const binnedDays = Math.floor((parts.day - 1) / size) * size;
    const label = `${parts.year}-${pad(parts.month)}-${pad(binnedDays + 1)}`;
    return { key: `${label}T00:00:00`, label, dateStr: label };
  } else {
    const info = getIsoWeekAndMonday(parts);
    const label = `W${pad(info.weekNum)} ${pad(info.mondayMonth)}-${pad(info.mondayDay)}`;
    return {
      key: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}T00:00:00`,
      label,
      dateStr: `${info.mondayYear}-${pad(info.mondayMonth)}-${pad(info.mondayDay)}`
    };
  }
}
function distributeChars(costs, barWidth) {
  const total = Object.values(costs).reduce((sum, val) => sum + val, 0);
  const result = {};
  const remainders = {};
  const categories = Object.keys(costs);
  if (total <= 0 || barWidth <= 0) {
    for (const cat of categories) result[cat] = 0;
    return result;
  }
  let allocated = 0;
  for (const cat of categories) {
    const raw = costs[cat] / total * barWidth;
    result[cat] = Math.floor(raw);
    remainders[cat] = raw - result[cat];
    allocated += result[cat];
  }
  while (allocated < barWidth) {
    let maxCat = null;
    let maxRemainder = -1;
    for (const cat of categories) {
      if (remainders[cat] > maxRemainder) {
        maxRemainder = remainders[cat];
        maxCat = cat;
      }
    }
    if (maxCat) {
      result[maxCat]++;
      remainders[maxCat] = -1;
      allocated++;
    } else {
      break;
    }
  }
  return result;
}
function calculateScaleMax(total) {
  if (total <= 0) return 1;
  if (total > 20) {
    return Math.ceil(total / 5) * 5;
  } else {
    return Math.ceil(total);
  }
}
function buildTickLine(maxCost, barWidth) {
  if (maxCost <= 0 || barWidth < 15) return null;
  const outArr = Array(barWidth).fill("\u2500");
  const midIdx = Math.floor(barWidth / 2);
  const q1Idx = Math.floor(barWidth / 4);
  const q3Idx = Math.floor(barWidth * 3 / 4);
  outArr[0] = "\u253F";
  outArr[barWidth - 1] = "\u253F";
  outArr[midIdx] = "\u253F";
  outArr[q1Idx] = "\u253F";
  outArr[q3Idx] = "\u253F";
  const labels = [];
  const tryPlaceLabel = (text, startIdx) => {
    const displayStr = ` ${text} `;
    const len = displayStr.length;
    if (startIdx + len > barWidth) startIdx = barWidth - len;
    if (startIdx < 0) return false;
    for (const l of labels) {
      if (startIdx < l.start + l.text.length && startIdx + len > l.start) {
        return false;
      }
    }
    labels.push({ text: displayStr, start: startIdx });
    return true;
  };
  tryPlaceLabel("$0.00", 0);
  tryPlaceLabel(`$${maxCost.toFixed(2)}`, barWidth - 1);
  tryPlaceLabel(`$${(maxCost / 2).toFixed(2)}`, midIdx);
  tryPlaceLabel(`$${(maxCost / 4).toFixed(2)}`, q1Idx);
  tryPlaceLabel(`$${(maxCost * 3 / 4).toFixed(2)}`, q3Idx);
  labels.sort((a, b) => a.start - b.start);
  let result = "";
  let currentIndex = 0;
  for (const l of labels) {
    if (l.start > currentIndex) {
      result += outArr.slice(currentIndex, l.start).join("");
    }
    result += `\x1B[7m${l.text}\x1B[27m`;
    currentIndex = l.start + l.text.length;
  }
  if (currentIndex < barWidth) {
    result += outArr.slice(currentIndex).join("");
  }
  return result;
}
function padString(str, len) {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
function formatCost(cost) {
  return `$${cost.toFixed(2)}`;
}
function formatMmmDdStr(dateStr) {
  const parts = dateStr.split("-");
  if (parts.length === 3) {
    const monthIdx = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = (n) => String(n).padStart(2, "0");
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]}-${pad(day)}`;
    }
  }
  return dateStr;
}
function getVisualLength(str) {
  const clean = str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  let len = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < clean.length) {
      len += 2;
      i++;
    } else if (code >= 12288 && code <= 40959) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}
function buildWtftLines(interactions, defaultSettings, opts) {
  const intervalStr = opts?.interval !== void 0 ? opts.interval : defaultSettings.interval;
  const limit = opts?.limit !== void 0 ? opts.limit : defaultSettings.limit;
  const width = opts?.width !== void 0 ? opts.width : defaultSettings.width;
  const showTicks = opts?.showTicks !== void 0 ? opts.showTicks : defaultSettings.showTicks;
  const mode = opts?.mode !== void 0 ? opts.mode : defaultSettings.mode;
  const tz = opts?.timezone !== void 0 ? opts.timezone : defaultSettings.timezone;
  const intervalConfig = parseInterval(intervalStr);
  const binMap = /* @__PURE__ */ new Map();
  let totalSessionCost = 0;
  for (const interaction of interactions) {
    const classification = classifyInteraction(interaction);
    const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, tz);
    totalSessionCost += interaction.cost;
    let bin = binMap.get(key);
    if (!bin) {
      const costs = {};
      for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "prompt", "other"]) {
        costs[cat] = 0;
      }
      bin = { label, dateStr, costs, total_cost: 0 };
      binMap.set(key, bin);
    }
    bin.costs[classification] += interaction.cost;
    bin.total_cost += interaction.cost;
  }
  const sortedBins = Array.from(binMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]);
  if (mode === "cumulative") {
    const runningCosts = {};
    for (const cat of ["spec", "code", "mixed", "tests", "research", "git", "grep", "prompt", "other"]) {
      runningCosts[cat] = 0;
    }
    let running_total = 0;
    for (const bin of sortedBins) {
      bin.incremental_cost = bin.total_cost;
      running_total += bin.total_cost;
      for (const cat of Object.keys(bin.costs)) {
        runningCosts[cat] += bin.costs[cat];
        bin.costs[cat] = runningCosts[cat];
      }
      bin.total_cost = running_total;
    }
  }
  const reversedBins = sortedBins.reverse();
  const displayedBins = reversedBins.slice(0, limit);
  if (displayedBins.length === 0) {
    return null;
  }
  const scaleMax = calculateScaleMax(totalSessionCost);
  const labelWidth = Math.max(...displayedBins.map((b) => b.label.length), 5);
  const prefixWidth = mode === "cumulative" ? labelWidth + 18 : labelWidth + 10;
  const finalWidth = Math.max(width, 40);
  const maxBarWidth = finalWidth - prefixWidth;
  const newestBin = displayedBins[0];
  let titleDateStr = "";
  if (newestBin) {
    titleDateStr = formatMmmDdStr(newestBin.dateStr);
  } else {
    const nowParts = getZonedParts(Date.now(), tz);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = (n) => String(n).padStart(2, "0");
    titleDateStr = `${months[nowParts.month - 1]}-${pad(nowParts.day)}`;
  }
  const widgetLines = [];
  const titleLeft = "\u{1F4B8} WTF Tokens?";
  const legendItems = [
    `\x1B[38;5;108m\u2588\x1B[0m Spec`,
    `\x1B[38;5;108;48;5;173m\u2592\x1B[0m Mixed`,
    `\x1B[38;5;173m\u2588\x1B[0m Code`,
    `\x1B[38;5;223m\u2588\x1B[0m Tests`,
    `\x1B[38;5;134m\u2588\x1B[0m Research`,
    `\x1B[38;5;73m\u2588\x1B[0m Git`,
    `\x1B[38;5;67m\u2588\x1B[0m Grep`,
    `\x1B[38;5;168m\u2591\x1B[0m Prompt`,
    `\x1B[38;5;238m\u2591\x1B[0m Other`
  ];
  const legendStr = legendItems.join("  ");
  const leftLen = getVisualLength(titleLeft);
  const legendLen = getVisualLength(legendStr);
  const totalNeeded = leftLen + legendLen + 4;
  if (totalNeeded <= finalWidth) {
    const remainingSpaces = finalWidth - leftLen - legendLen;
    const titleLine = titleLeft + " ".repeat(remainingSpaces) + legendStr;
    widgetLines.push(titleLine);
  } else {
    widgetLines.push(titleLeft);
    widgetLines.push(legendStr);
  }
  if (showTicks && scaleMax > 0) {
    const labelPrefix = padString(titleDateStr, prefixWidth);
    const ticksLine = buildTickLine(scaleMax, maxBarWidth);
    if (ticksLine) {
      widgetLines.push(labelPrefix + `\x1B[90m${ticksLine}\x1B[0m`);
    }
  }
  for (let i = 0; i < displayedBins.length; i++) {
    const bin = displayedBins[i];
    if (showTicks && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
      const labelDay = formatMmmDdStr(bin.dateStr);
      const dayChangeText = `\u2500\u2500\u2500 ${labelDay} `;
      const dividerLine = dayChangeText + "\u2500".repeat(Math.max(0, finalWidth - dayChangeText.length));
      widgetLines.push(`\x1B[90m${dividerLine}\x1B[0m`);
    }
    const barWidth = scaleMax > 0 ? Math.round(bin.total_cost / scaleMax * maxBarWidth) : 0;
    const chars = distributeChars(bin.costs, barWidth);
    let barStr = "";
    if (chars.spec > 0) {
      barStr += `\x1B[38;5;108m${"\u2588".repeat(chars.spec)}\x1B[0m`;
    }
    if (chars.mixed > 0) {
      barStr += `\x1B[38;5;108;48;5;173m${"\u2592".repeat(chars.mixed)}\x1B[0m`;
    }
    if (chars.code > 0) {
      barStr += `\x1B[38;5;173m${"\u2588".repeat(chars.code)}\x1B[0m`;
    }
    if (chars.tests > 0) {
      barStr += `\x1B[38;5;223m${"\u2588".repeat(chars.tests)}\x1B[0m`;
    }
    if (chars.research > 0) {
      barStr += `\x1B[38;5;134m${"\u2588".repeat(chars.research)}\x1B[0m`;
    }
    if (chars.git > 0) {
      barStr += `\x1B[38;5;73m${"\u2588".repeat(chars.git)}\x1B[0m`;
    }
    if (chars.grep > 0) {
      barStr += `\x1B[38;5;67m${"\u2588".repeat(chars.grep)}\x1B[0m`;
    }
    if (chars.prompt > 0) {
      barStr += `\x1B[38;5;168m${"\u2591".repeat(chars.prompt)}\x1B[0m`;
    }
    if (chars.other > 0) {
      barStr += `\x1B[38;5;238m${"\u2591".repeat(chars.other)}\x1B[0m`;
    }
    const labelPart = padString(bin.label, labelWidth);
    const coloredLabel = `\x1B[90m${labelPart}\x1B[0m`;
    if (mode === "cumulative") {
      const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
      const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
      const incPart = padString(incStr, 6);
      const coloredInc = `\x1B[90m${incPart}\x1B[0m`;
      const costPart = padString(formatCost(bin.total_cost), 6);
      const coloredCost = `\x1B[1;37m${costPart}\x1B[0m`;
      widgetLines.push(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
    } else {
      const costPart = padString(formatCost(bin.total_cost), 6);
      const coloredCost = `\x1B[1;37m${costPart}\x1B[0m`;
      widgetLines.push(`${coloredLabel}  ${coloredCost}  ${barStr}`);
    }
  }
  return widgetLines;
}
export {
  buildTickLine,
  buildWtftLines,
  calculateScaleMax,
  classifyInteraction,
  distributeChars,
  formatCost,
  formatMmmDdStr,
  getBinInfo,
  getIsoWeekAndMonday,
  getVisualLength,
  getZonedParts,
  padString,
  parseInterval
};

// --- END INLINED LOGIC ---

let intervalStr = "1h";
let limit = 100;
let width = 80;
let mode = "cumulative";
let showTicks = true;
let targetSessionPath = void 0;
let timezone = void 0;
function printHelp() {
  console.log(`
Usage: wtft [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 80).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -h, --help              Display this help menu.
`);
}
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  } else if (arg === "-s" || arg === "--session") {
    targetSessionPath = process.argv[++i];
  } else if (arg === "-i" || arg === "--interval") {
    intervalStr = process.argv[++i];
  } else if (arg === "-l" || arg === "--limit") {
    limit = parseInt(process.argv[++i], 10);
  } else if (arg === "-w" || arg === "--width") {
    width = parseInt(process.argv[++i], 10);
  } else if (arg === "-c" || arg === "--cumulative") {
    mode = "cumulative";
  } else if (arg === "-b" || arg === "--bucket") {
    mode = "bucket";
  } else if (arg === "--no-ticks") {
    showTicks = false;
  } else if (arg === "--ticks") {
    showTicks = true;
  } else if (arg === "-t" || arg === "--tz") {
    timezone = process.argv[++i];
  }
}
function findLatestSession() {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  let newestFile = null;
  let newestMtime = 0;
  const walk = (dir) => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (f.endsWith(".jsonl")) {
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newestFile = fullPath;
        }
      }
    }
  };
  try {
    walk(sessionsDir);
  } catch {
    return null;
  }
  return newestFile;
}
const finalSessionPath = targetSessionPath || findLatestSession();
if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
  console.error("\u274C Error: No active session log files found. Ensure Pi has been run, or specify an explicit session log path with -s.");
  process.exit(1);
}
const lines = fs.readFileSync(finalSessionPath, "utf8").split("\n");
const interactions = [];
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    const entry = JSON.parse(line);
    if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
      const assistantMsg = entry.message;
      const cost = assistantMsg.usage?.cost?.total || 0;
      const timestamp = assistantMsg.timestamp || new Date(entry.timestamp).getTime();
      const files = [];
      const commands = [];
      const texts = [];
      if (Array.isArray(assistantMsg.content)) {
        for (const block of assistantMsg.content) {
          if (block.type === "text") texts.push(block.text);
          else if (block.type === "thinking") texts.push(block.thinking);
          else if (block.type === "toolCall") {
            const name = block.name;
            const args = block.arguments || {};
            if (name === "read") {
              if (args.path) files.push({ path: args.path, action: "read" });
            } else if (name === "write" || name === "edit") {
              if (args.path) files.push({ path: args.path, action: "write" });
            } else if (name === "bash") {
              if (args.command) commands.push(args.command);
            }
          }
        }
      }
      interactions.push({ timestamp, cost, files, commands, texts });
    }
  } catch {
  }
}
const defaultSettings = {
  interval: "1h",
  limit: 100,
  width: 80,
  showTicks: true,
  mode: "cumulative",
  timezone: void 0
};
const outputLines = buildWtftLines(interactions, defaultSettings, {
  interval: intervalStr,
  limit,
  width,
  showTicks,
  mode,
  timezone
});
if (!outputLines) {
  console.log("No binned data found in session logs.");
  process.exit(0);
}
for (const line of outputLines) {
  console.log(line);
}

#!/usr/bin/env node

// bin/wtft.ts
import * as fs from "node:fs";
import * as path2 from "node:path";
import * as os from "node:os";

// extensions/lib/wtft-shared.ts
import * as path from "node:path";
function calculateClaudeCost(model, usage) {
  if (!usage) return 0;
  let inputPrice = 3;
  let outputPrice = 15;
  let cacheWritePrice = 3.75;
  let cacheReadPrice = 0.3;
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) {
    inputPrice = 0.8;
    outputPrice = 4;
    cacheWritePrice = 1;
    cacheReadPrice = 0.08;
  } else if (m.includes("opus")) {
    inputPrice = 15;
    outputPrice = 75;
    cacheWritePrice = 18.75;
    cacheReadPrice = 1.5;
  }
  const cost = (usage.input_tokens || 0) * (inputPrice / 1e6) + (usage.output_tokens || 0) * (outputPrice / 1e6) + (usage.cache_creation_input_tokens || 0) * (cacheWritePrice / 1e6) + (usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1e6);
  return cost;
}
function extractFilesFromBashCommand(command, files) {
  const cmdLines = command.split("\n");
  for (const line of cmdLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("cat ") || trimmed.startsWith("head ") || trimmed.startsWith("tail ")) {
      const parts = trimmed.split(/\s+/);
      if (parts.length > 1) {
        const possiblePath = parts[1].replace(/['"]/g, "");
        if (possiblePath && !possiblePath.startsWith("-")) {
          files.push({ path: possiblePath, action: "read" });
        } else if (parts.length > 2 && parts[1].startsWith("-")) {
          for (let i = 2; i < parts.length; i++) {
            const candidate = parts[i].replace(/['"]/g, "");
            if (!candidate.startsWith("-") && isNaN(Number(candidate))) {
              files.push({ path: candidate, action: "read" });
              break;
            }
          }
        }
      }
    }
  }
}
function parseEntryToInteraction(entry) {
  if (!entry) return null;
  const isPiSchema = entry.type === "message" && entry.message && entry.message.role === "assistant";
  const isClaudeSchema = entry.type === "assistant" && entry.message && entry.message.role === "assistant";
  if (isPiSchema || isClaudeSchema) {
    const assistantMsg = entry.message;
    let cost = 0;
    if (assistantMsg.usage?.cost?.total !== void 0) {
      cost = assistantMsg.usage.cost.total;
    } else if (assistantMsg.model && assistantMsg.usage) {
      cost = calculateClaudeCost(assistantMsg.model, assistantMsg.usage);
    }
    let timestampStr = assistantMsg.timestamp || entry.timestamp;
    let timestamp = 0;
    if (typeof timestampStr === "string") {
      timestamp = new Date(timestampStr).getTime();
    } else if (typeof timestampStr === "number") {
      timestamp = timestampStr;
    }
    const files = [];
    const commands = [];
    const texts = [];
    if (Array.isArray(assistantMsg.content)) {
      for (const block of assistantMsg.content) {
        if (block.type === "text") {
          texts.push(block.text);
        } else if (block.type === "thinking") {
          texts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const name = block.name;
          const args = block.arguments || {};
          if (name === "read") {
            if (args.path) files.push({ path: args.path, action: "read" });
          } else if (name === "write" || name === "edit") {
            if (args.path) files.push({ path: args.path, action: "write" });
          } else if (name === "bash") {
            if (args.command) {
              commands.push(args.command);
              extractFilesFromBashCommand(args.command, files);
            }
          }
        } else if (block.type === "tool_use") {
          const name = (block.name || "").toLowerCase();
          const args = block.input || {};
          if (name === "read" || name === "view" || name === "glob" || name === "ls") {
            const p = args.file_path || args.path || args.directory || args.target;
            if (p) files.push({ path: p, action: "read" });
          } else if (name === "edit" || name === "write" || name === "replace") {
            const p = args.file_path || args.path || args.target;
            if (p) files.push({ path: p, action: "write" });
          } else if (name === "bash" || name === "run") {
            if (args.command) {
              commands.push(args.command);
              extractFilesFromBashCommand(args.command, files);
            }
          }
        }
      }
    }
    return { timestamp, cost, files, commands, texts };
  }
  return null;
}
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
      if ([".ts", ".js", ".mjs", ".json", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml", ".sql"].includes(ext) || norm.endsWith(".gitignore") || norm.endsWith(".dockerignore")) {
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
function buildTickLine(maxCost, barWidth, prefixWidth, labelPrefix) {
  if (maxCost <= 0 || barWidth < 15) return null;
  const totalWidth = prefixWidth + barWidth;
  const chars = Array(totalWidth).fill("\u2500");
  const cleanPrefix = labelPrefix.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  for (let i = 0; i < cleanPrefix.length; i++) {
    chars[i] = cleanPrefix[i];
  }
  const ticks = [
    prefixWidth,
    prefixWidth + Math.floor(barWidth / 4),
    prefixWidth + Math.floor(barWidth / 2),
    prefixWidth + Math.floor(barWidth * 3 / 4),
    prefixWidth + barWidth - 1
  ];
  for (const t of ticks) {
    if (t < chars.length) chars[t] = "\u253F";
  }
  const labels = [];
  const tickValues = [0, maxCost / 4, maxCost / 2, maxCost * 3 / 4, maxCost];
  for (let i = 0; i < ticks.length; i++) {
    const text = `$${tickValues[i].toFixed(2)}`;
    const displayStr = ` ${text} `;
    const dotIdx = displayStr.indexOf(".");
    const startIdx = ticks[i] - dotIdx;
    const endIdx = startIdx + displayStr.length;
    let overlap = false;
    for (const l of labels) {
      if (startIdx < l.end && endIdx > l.start) {
        overlap = true;
        break;
      }
    }
    if (!overlap) {
      labels.push({
        text: displayStr,
        start: startIdx,
        end: endIdx
      });
    }
  }
  labels.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const l of labels) {
    if (l.start > cursor) {
      result += chars.slice(cursor, Math.min(l.start, chars.length)).join("");
      if (l.start > chars.length) {
        result += " ".repeat(l.start - Math.max(cursor, chars.length));
      }
    }
    result += `\x1B[7m${l.text}\x1B[27m`;
    cursor = Math.max(cursor, l.end);
  }
  if (cursor < chars.length) {
    result += chars.slice(cursor).join("");
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
  const intervalStr2 = opts?.interval !== void 0 ? opts.interval : defaultSettings.interval;
  const limit2 = opts?.limit !== void 0 ? opts.limit : defaultSettings.limit;
  const width = opts?.width !== void 0 ? opts.width : defaultSettings.width;
  const showTicks2 = opts?.showTicks !== void 0 ? opts.showTicks : defaultSettings.showTicks;
  const mode2 = opts?.mode !== void 0 ? opts.mode : defaultSettings.mode;
  const tz = opts?.timezone !== void 0 ? opts.timezone : defaultSettings.timezone;
  const intervalConfig = parseInterval(intervalStr2);
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
  if (mode2 === "cumulative") {
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
  const displayedBins = reversedBins.slice(0, limit2);
  if (displayedBins.length === 0) {
    return null;
  }
  const maxBarValue = mode2 === "cumulative" ? totalSessionCost : Math.max(...displayedBins.map((b) => b.total_cost), 0);
  const scaleMax = calculateScaleMax(maxBarValue);
  const labelWidth = Math.max(...displayedBins.map((b) => b.label.length), 5);
  let prefixWidth = labelWidth + 2;
  let maxIncLen = 6;
  let maxCostLen = 6;
  if (mode2 === "cumulative") {
    maxIncLen = Math.max(...displayedBins.map((bin) => {
      const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
      return `${incSign}${formatCost(bin.incremental_cost ?? 0)}`.length;
    }), 6);
    maxCostLen = Math.max(...displayedBins.map((b) => formatCost(b.total_cost).length), 6);
    prefixWidth += maxIncLen + 2 + maxCostLen + 2;
  } else {
    maxCostLen = Math.max(...displayedBins.map((b) => formatCost(b.total_cost).length), 6);
    prefixWidth += maxCostLen + 2;
  }
  const finalWidth = Math.max(width, 40);
  const maxBarWidth = finalWidth - prefixWidth - 3;
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
  if (showTicks2 && scaleMax > 0) {
    const dateLabel = `\u2500\u2500 ${titleDateStr} `;
    const paddingLen = Math.max(0, prefixWidth - dateLabel.length);
    const labelPrefix = dateLabel + "\u2500".repeat(paddingLen);
    const ticksLine = buildTickLine(scaleMax, maxBarWidth, prefixWidth, labelPrefix);
    if (ticksLine) {
      widgetLines.push(`\x1B[90m${ticksLine}\x1B[0m`);
    }
  }
  for (let i = 0; i < displayedBins.length; i++) {
    const bin = displayedBins[i];
    if (showTicks2 && i > 0 && bin.dateStr !== displayedBins[i - 1].dateStr) {
      const labelDay = formatMmmDdStr(bin.dateStr);
      const dayChangeText = `\u2500\u2500 ${labelDay} `;
      const dividerLine = dayChangeText + "\u2500".repeat(Math.max(0, finalWidth - dayChangeText.length));
      widgetLines.push(`\x1B[90m${dividerLine}\x1B[0m`);
    }
    let barStr = "";
    if (mode2 === "cumulative") {
      const barWidth = scaleMax > 0 ? Math.round(bin.total_cost / scaleMax * maxBarWidth) : 0;
      const chars = distributeChars(bin.costs, barWidth);
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
    } else {
      const cells = Array(maxBarWidth).fill(" ");
      const categoriesInReverse = [
        { cat: "other", color: "\x1B[38;5;238m", char: "\u2591" },
        { cat: "prompt", color: "\x1B[38;5;168m", char: "\u2591" },
        { cat: "grep", color: "\x1B[38;5;67m", char: "\u2588" },
        { cat: "git", color: "\x1B[38;5;73m", char: "\u2588" },
        { cat: "research", color: "\x1B[38;5;134m", char: "\u2588" },
        { cat: "tests", color: "\x1B[38;5;223m", char: "\u2588" },
        { cat: "code", color: "\x1B[38;5;173m", char: "\u2588" },
        { cat: "mixed", color: "\x1B[38;5;108;48;5;173m", char: "\u2592" },
        { cat: "spec", color: "\x1B[38;5;108m", char: "\u2588" }
      ];
      for (const { cat, color, char } of categoriesInReverse) {
        const cost = bin.costs[cat] || 0;
        if (cost > 0 && scaleMax > 0) {
          const pos = Math.round(cost / scaleMax * (maxBarWidth - 1));
          if (pos >= 0 && pos < maxBarWidth) {
            cells[pos] = `${color}${char}\x1B[0m`;
          }
        }
      }
      barStr = cells.join("");
    }
    const labelPart = padString(bin.label, labelWidth);
    const coloredLabel = `\x1B[90m${labelPart}\x1B[0m`;
    if (mode2 === "cumulative") {
      const incSign = (bin.incremental_cost ?? 0) >= 0 ? "+" : "";
      const incStr = `${incSign}${formatCost(bin.incremental_cost ?? 0)}`;
      const incPart = padString(incStr, maxIncLen);
      const coloredInc = `\x1B[90m${incPart}\x1B[0m`;
      const costPart = padString(formatCost(bin.total_cost), maxCostLen);
      const coloredCost = `\x1B[1;37m${costPart}\x1B[0m`;
      widgetLines.push(`${coloredLabel}  ${coloredInc}  ${coloredCost}  ${barStr}`);
    } else {
      const costPart = padString(formatCost(bin.total_cost), maxCostLen);
      const coloredCost = `\x1B[1;37m${costPart}\x1B[0m`;
      widgetLines.push(`${coloredLabel}  ${coloredCost}  ${barStr}`);
    }
  }
  return widgetLines;
}
function renderOtherHistogram(interactions, maxWidth = 80) {
  const commandMap = /* @__PURE__ */ new Map();
  for (const interaction of interactions) {
    const classification = classifyInteraction(interaction);
    if (classification === "other") {
      const primaryCommands = [];
      for (const rawCmd of interaction.commands) {
        const lines = rawCmd.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith("#")) {
            const parts = trimmed.split(" ");
            const primary = parts[0];
            if (primary) {
              primaryCommands.push(primary);
              break;
            }
          }
        }
      }
      for (const cmd of primaryCommands) {
        const existing = commandMap.get(cmd) || { count: 0, cost: 0 };
        commandMap.set(cmd, {
          count: existing.count + 1,
          cost: existing.cost + interaction.cost
        });
      }
    }
  }
  if (commandMap.size === 0) {
    return "No 'Other' commands found in this session.";
  }
  let output = "--- 'Other' Command Histogram ---\n";
  const sortedEntries = Array.from(commandMap.entries()).sort((a, b) => b[1].count - a[1].count);
  let maxCmdLen = 0;
  for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);
  const countWidth = 7;
  const costWidth = 10;
  for (const [cmd, data] of sortedEntries) {
    const countStr = `(${data.count})`.padStart(countWidth);
    const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);
    const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
    const bar = "#".repeat(Math.min(data.count, barWidth));
    output += `${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}
`;
  }
  return output;
}

// bin/wtft.ts
var intervalStr = "1h";
var limit = 100;
var widthOption = null;
var mode = "cumulative";
var showTicks = true;
var targetSessionPath = void 0;
var timezone = void 0;
var harnessOption = "auto";
var showOther = false;
function printHelp() {
  console.log(`
Usage: wtft [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 80).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Instead of the visual timeline, print a histogram of commands categorized as 'Other'.
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
    widthOption = parseInt(process.argv[++i], 10);
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
  } else if (arg === "-o" || arg === "--other") {
    showOther = true;
  } else if (arg === "--harness") {
    const val = process.argv[++i];
    if (val === "pi" || val === "claude-code" || val === "auto") {
      harnessOption = val;
    }
  }
}
function discoverSessions(harness = "auto") {
  const piSessionsDir = path2.join(os.homedir(), ".pi", "agent", "sessions");
  let claudeSessionsDirs = [];
  const claudeProjectsDir = path2.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(claudeProjectsDir)) {
    const cwdSlug = process.cwd().replace(/[/\\\\]/g, "-");
    const possibleDir = path2.join(claudeProjectsDir, cwdSlug, "sessions");
    const alternativeDir = path2.join(claudeProjectsDir, cwdSlug);
    if (fs.existsSync(possibleDir)) claudeSessionsDirs.push(possibleDir);
    if (fs.existsSync(alternativeDir)) claudeSessionsDirs.push(alternativeDir);
  }
  const candidates = [];
  const walk = (dir, type) => {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fullPath = path2.join(dir, f);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        if (f !== "subagents" && f !== "tool-results" && f !== "memory") {
          walk(fullPath, type);
        }
      } else if (f.endsWith(".jsonl")) {
        candidates.push({
          path: fullPath,
          harness: type,
          timestamp: stat.mtimeMs,
          name: f
        });
      }
    }
  };
  try {
    if (harness === "auto" || harness === "pi") {
      if (fs.existsSync(piSessionsDir)) walk(piSessionsDir, "pi");
    }
    if (harness === "auto" || harness === "claude-code") {
      for (const dir of claudeSessionsDirs) {
        if (fs.existsSync(dir)) walk(dir, "claude-code");
      }
    }
  } catch {
  }
  return candidates.sort((a, b) => b.timestamp - a.timestamp);
}
function getSessionSummary(filePath) {
  let turns = 0;
  let cost = 0;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.type === "assistant" || entry.message && entry.message.role === "assistant") {
        turns++;
      }
      const i = parseEntryToInteraction(entry);
      if (i) {
        cost += i.cost;
      }
    }
  } catch {
  }
  return { turns, cost };
}
async function selectSessionPrompt(candidates) {
  return new Promise((resolve) => {
    if (!process.stdout.isTTY) {
      console.log(`\x1B[90mNon-interactive environment detected. Defaulting to newest session [1]:\x1B[0m`);
      for (let i = 0; i < Math.min(candidates.length, 5); i++) {
        const c = candidates[i];
        const stats = getSessionSummary(c.path);
        const shortName = c.name.length > 25 ? `${c.name.substring(0, 10)}...${c.name.substring(c.name.length - 15)}` : c.name;
        const dateStr = new Date(c.timestamp).toLocaleString();
        console.log(`  [${i + 1}] ${shortName.padEnd(28)} (${dateStr}) - ${stats.turns} turns, $${stats.cost.toFixed(2)} [${c.harness.toUpperCase()}]`);
      }
      console.log(`\x1B[90mRun 'wtft -s <number>' to target a specific session index.\x1B[0m
`);
      resolve(candidates[0].path);
      return;
    }
    let selectedIndex = 0;
    const limit2 = 10;
    const displayCandidates = candidates.slice(0, limit2);
    const statsList = displayCandidates.map((c) => getSessionSummary(c.path));
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    process.stdout.write("\x1B[?25l");
    const render = () => {
      let out = `\x1B[1m\x1B[36m\u{1F4B8} WTFT Session Selector\x1B[0m (Use \u2191/\u2193 keys, Enter to select, Ctrl+C to cancel):
`;
      for (let i = 0; i < displayCandidates.length; i++) {
        const c = displayCandidates[i];
        const stats = statsList[i];
        const shortName = c.name.length > 25 ? `${c.name.substring(0, 10)}...${c.name.substring(c.name.length - 15)}` : c.name;
        const dateStr = new Date(c.timestamp).toLocaleString();
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? `\x1B[36m\x1B[1m > \x1B[0m` : "   ";
        const highlight = isSelected ? `\x1B[1m\x1B[36m` : "";
        const reset = isSelected ? `\x1B[0m` : "";
        out += `${prefix}${highlight}${shortName.padEnd(28)}${reset} \x1B[90m(${dateStr})\x1B[0m  \x1B[32m$${stats.cost.toFixed(2).padStart(6)}\x1B[0m \x1B[90m(${stats.turns} turns) [${c.harness.toUpperCase()}]\x1B[0m
`;
      }
      process.stdout.write(out);
    };
    const cleanScreen = () => {
      const linesToClear = displayCandidates.length + 1;
      process.stdout.write(`\x1B[${linesToClear}A\x1B[J`);
    };
    render();
    const onKey = (key) => {
      if (key === "") {
        cleanup();
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(displayCandidates[selectedIndex].path);
      } else if (key === "\x1B[A" || key === "k") {
        selectedIndex = (selectedIndex - 1 + displayCandidates.length) % displayCandidates.length;
        cleanScreen();
        render();
      } else if (key === "\x1B[B" || key === "j") {
        selectedIndex = (selectedIndex + 1) % displayCandidates.length;
        cleanScreen();
        render();
      }
    };
    const cleanup = () => {
      stdin.removeListener("data", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\x1B[?25h");
    };
    stdin.on("data", onKey);
  });
}
async function main() {
  const isIndex = /^\d+$/.test(targetSessionPath || "");
  const candidates = discoverSessions(harnessOption);
  let finalSessionPath = "";
  if (targetSessionPath && isIndex) {
    const idx = parseInt(targetSessionPath, 10);
    if (idx > 0 && idx <= candidates.length) {
      finalSessionPath = candidates[idx - 1].path;
    } else {
      console.error(`\u274C Error: Session index '${targetSessionPath}' is out of range. Discovered ${candidates.length} sessions.`);
      process.exit(1);
    }
  } else if (targetSessionPath) {
    finalSessionPath = targetSessionPath;
  } else {
    if (candidates.length === 0) {
      console.error("\u274C Error: No active session log files found. Ensure Pi or Claude has been run, or specify an explicit session log path with -s.");
      process.exit(1);
    } else if (candidates.length === 1) {
      finalSessionPath = candidates[0].path;
    } else {
      finalSessionPath = await selectSessionPrompt(candidates);
    }
  }
  if (!finalSessionPath || !fs.existsSync(finalSessionPath)) {
    console.error("\u274C Error: Selected session log file path is invalid or does not exist.");
    process.exit(1);
  }
  const sessionFiles = [finalSessionPath];
  const extName = path2.extname(finalSessionPath);
  if (extName === ".jsonl") {
    const baseName = path2.basename(finalSessionPath, extName);
    const parentDir = path2.dirname(finalSessionPath);
    const possibleSubagentsDir = path2.join(parentDir, baseName, "subagents");
    if (fs.existsSync(possibleSubagentsDir)) {
      try {
        const subFiles = fs.readdirSync(possibleSubagentsDir);
        for (const f of subFiles) {
          if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
            sessionFiles.push(path2.join(possibleSubagentsDir, f));
          }
        }
      } catch {
      }
    }
  }
  const lines = [];
  for (const file of sessionFiles) {
    try {
      const content = fs.readFileSync(file, "utf8");
      lines.push(...content.split("\n"));
    } catch {
    }
  }
  const interactions = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const interaction = parseEntryToInteraction(entry);
      if (interaction) {
        interactions.push(interaction);
      }
    } catch {
    }
  }
  const termColumns = process.stdout.columns || 80;
  const width = Math.min(widthOption !== null ? widthOption : termColumns, 240);
  const defaultSettings = {
    interval: "1h",
    limit: 100,
    width,
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
  if (showOther) {
    console.log("");
    const otherOutput = renderOtherHistogram(interactions, width);
    console.log(otherOutput);
  }
}
main().catch((err) => {
  console.error(`\u274C System Error: ${err.message}`);
  process.exit(1);
});

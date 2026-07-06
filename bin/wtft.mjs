#!/usr/bin/env node

// bin/wtft.ts
import * as fs3 from "node:fs";
import * as path4 from "node:path";
import { fileURLToPath } from "node:url";

// extensions/lib/wtft-shared.ts
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
function getDeepSeekPeakMultiplier(timestamp) {
  const ts = timestamp || Date.now();
  const d = new Date(ts);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const utcTime = utcHour * 60 + utcMin;
  if (utcTime >= 60 && utcTime < 240 || utcTime >= 360 && utcTime < 600) {
    return 2;
  }
  return 1;
}
function calculateClaudeCost(model, usage, timestamp) {
  if (!usage) return 0;
  let inputPrice = 3;
  let outputPrice = 15;
  let cacheReadPrice = 0.3;
  const m = (model || "").toLowerCase();
  if (m.includes("deepseek")) {
    const peak = getDeepSeekPeakMultiplier(timestamp);
    if (m.includes("v4-pro")) {
      inputPrice = 0.435 * peak;
      outputPrice = 0.87 * peak;
    } else {
      inputPrice = 0.14 * peak;
      outputPrice = 0.28 * peak;
    }
    cacheReadPrice = 0;
  } else if (m.includes("haiku")) {
    inputPrice = 1;
    outputPrice = 5;
    cacheReadPrice = 0.1;
  } else if (m.includes("opus")) {
    inputPrice = 5;
    outputPrice = 25;
    cacheReadPrice = 0.5;
  }
  let cacheWriteCost = 0;
  const cc = usage.cache_creation || {};
  const cw5m = cc.ephemeral_5m_input_tokens ?? 0;
  const cw1h = cc.ephemeral_1h_input_tokens ?? 0;
  const cwFlat = Math.max(0, (usage.cache_creation_input_tokens || 0) - cw5m - cw1h);
  if (m.includes("deepseek")) {
    cacheWriteCost = 0;
  } else {
    cacheWriteCost = cw5m * (inputPrice * 1.25 / 1e6) + cw1h * (inputPrice * 2 / 1e6) + cwFlat * (inputPrice * 1.25 / 1e6);
  }
  const cost = (usage.input_tokens || 0) * (inputPrice / 1e6) + (usage.output_tokens || 0) * (outputPrice / 1e6) + cacheWriteCost + (usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1e6);
  return cost;
}
function extractFilesFromBashCommand(command, files) {
  const cmdLines = command.split("\n");
  for (const line of cmdLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("cat ") && trimmed.includes("<<") && trimmed.includes(">")) {
      const parts = trimmed.split(/>+/);
      if (parts.length > 1) {
        const possiblePath = parts[1].trim().replace(/['"]/g, "");
        if (possiblePath && !possiblePath.startsWith("-")) {
          files.push({ path: possiblePath, action: "write" });
          continue;
        }
      }
    }
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
    let timestampStr = assistantMsg.timestamp || entry.timestamp;
    let timestamp = 0;
    if (typeof timestampStr === "string") {
      timestamp = new Date(timestampStr).getTime();
    } else if (typeof timestampStr === "number") {
      timestamp = timestampStr;
    }
    let cost = 0;
    const usage = assistantMsg.usage || {};
    const piCost = usage.cost?.total;
    const hasTokens2 = (usage.input_tokens || usage.input || 0) > 0 || (usage.output_tokens || usage.output || 0) > 0 || (usage.cache_read_input_tokens || usage.cacheRead || 0) > 0 || (usage.cache_creation_input_tokens || usage.cacheWrite || 0) > 0;
    if (piCost !== void 0 && piCost !== null && !(piCost === 0 && hasTokens2)) {
      cost = piCost;
    } else if (assistantMsg.model && hasTokens2) {
      const normalizedUsage = {
        input_tokens: usage.input_tokens ?? usage.input ?? 0,
        output_tokens: usage.output_tokens ?? usage.output ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
        cache_creation: usage.cache_creation || null
      };
      cost = calculateClaudeCost(assistantMsg.model, normalizedUsage, timestamp);
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
    return {
      timestamp,
      cost,
      messageId: assistantMsg.id,
      requestId: entry.requestId,
      model: assistantMsg.model || void 0,
      inputTokens: usage.input_tokens || usage.input || 0,
      outputTokens: usage.output_tokens || usage.output || 0,
      cacheReadTokens: usage.cache_read_input_tokens || usage.cacheRead || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || usage.cacheWrite || 0,
      files,
      commands,
      texts
    };
  }
  return null;
}
function parseSessionFile(filePath) {
  const interactions = [];
  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const interaction = parseEntryToInteraction(entry);
        if (interaction) interactions.push(interaction);
      } catch {
      }
    }
  } catch {
  }
  return interactions;
}
function deduplicateInteractions(interactions) {
  const byId = /* @__PURE__ */ new Map();
  const withoutId = [];
  for (const i of interactions) {
    if (i.messageId) {
      const existing = byId.get(i.messageId);
      if (existing) {
        existing.push(i);
      } else {
        byId.set(i.messageId, [i]);
      }
    } else {
      withoutId.push(i);
    }
  }
  const deduped = [...withoutId];
  for (const [, group] of byId) {
    if (group.length === 1) {
      deduped.push(group[0]);
    } else {
      let best = group[0];
      for (let j = 1; j < group.length; j++) {
        if (group[j].cost > best.cost) best = group[j];
      }
      const merged = {
        ...best,
        files: [],
        commands: [],
        texts: []
      };
      const seenFiles = /* @__PURE__ */ new Set();
      for (const i of group) {
        for (const f of i.files) {
          const key = `${f.path}:${f.action}`;
          if (!seenFiles.has(key)) {
            seenFiles.add(key);
            merged.files.push(f);
          }
        }
        for (const c of i.commands) {
          if (!merged.commands.includes(c)) merged.commands.push(c);
        }
        for (const t of i.texts) {
          if (!merged.texts.includes(t)) merged.texts.push(t);
        }
      }
      deduped.push(merged);
    }
  }
  return deduped;
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
    if (norm.includes("node_modules/")) {
      if (path.extname(norm).toLowerCase() === ".md" || norm.includes("/docs/")) {
        category = "research";
      } else {
        category = "code";
      }
    } else if (norm.startsWith("docs/") || norm.includes("/docs/") || norm.endsWith("AGENTS.md") || norm.endsWith("ARCHITECTURE.md") || norm.endsWith("README.md") || path.extname(norm).toLowerCase() === ".md") {
      category = "spec";
    } else if (norm.startsWith("tests/") || norm.includes("/tests/")) {
      category = "tests";
    } else if (norm.startsWith("research/") || norm.includes("/research/")) {
      category = "research";
    } else if (norm.startsWith(".pi/extensions/") || norm.includes("/.pi/extensions/") || norm.startsWith("extensions/") || norm.includes("/extensions/") || norm.startsWith("src/") || norm.includes("/src/") || norm.startsWith("public/") || norm.includes("/public/") || norm.startsWith("bin/") || norm.includes("/bin/") || norm.startsWith("debug/") || norm.includes("/debug/")) {
      category = "code";
    } else {
      const ext = path.extname(norm).toLowerCase();
      if ([".ts", ".js", ".mjs", ".json", ".jsonl", ".css", ".tsx", ".jsx", ".py", ".rs", ".go", ".sh", ".yml", ".yaml", ".sql", ".txt"].includes(ext) || norm.endsWith(".gitignore") || norm.endsWith(".dockerignore")) {
        category = "code";
      } else if (ext === "") {
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
  const labels = [];
  const tickValues = [0, maxCost / 4, maxCost / 2, maxCost * 3 / 4, maxCost];
  for (let i = 0; i < ticks.length; i++) {
    const text = formatCost(tickValues[i]);
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
  const decimals = cost > 0 && cost < 0.01 ? 4 : 2;
  return `$${cost.toFixed(decimals)}`;
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
function getTerminalWidth(isWidget = false, disabledEmoji = false) {
  let width = 80;
  if (process.stdout && process.stdout.columns) {
    width = process.stdout.columns;
  } else if (process.stderr && process.stderr.columns) {
    width = process.stderr.columns;
  } else if (process.env.COLUMNS) {
    const num = parseInt(process.env.COLUMNS, 10);
    if (!isNaN(num) && num > 0) width = num;
  }
  if (width === 80 && process.env.TMUX) {
    try {
      const tmuxWidth = execSync("tmux display-message -p '#{pane_width}'", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
      const num = parseInt(tmuxWidth, 10);
      if (!isNaN(num) && num > 0) width = num;
    } catch (e) {
    }
  }
  if (width === 80) {
    try {
      const cols = execSync("tput cols", { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }).trim();
      const num = parseInt(cols, 10);
      if (!isNaN(num) && num > 0) width = num;
    } catch (e) {
    }
  }
  return isWidget ? width - 2 : width;
}
function getCurrentLocalHour(tz) {
  const parts = getZonedParts(Date.now(), tz);
  return parts.hour;
}
function buildTimelineString(surgeHours, currentHour, proximityStatus) {
  const segments = [];
  let lastColor = null;
  for (let h = 0; h < 24; h++) {
    const isSurge = surgeHours.has(h);
    const isCurrent = h === currentHour;
    if (h === 12) {
      if (lastColor !== "") {
        segments.push({ color: "", text: "|" });
        lastColor = "";
      } else {
        segments[segments.length - 1].text += "|";
      }
      if (isCurrent) {
        const diaColor = "1;" + (isSurge ? "38;5;208" : "32");
        if (diaColor !== lastColor) {
          segments.push({ color: diaColor, text: "\u25C6" });
          lastColor = diaColor;
        } else {
          segments[segments.length - 1].text += "\u25C6";
        }
      }
      continue;
    }
    const color = isCurrent ? "1;" + (isSurge ? "38;5;208" : "32") : isSurge ? "38;5;208" : "32";
    const char = isCurrent ? "\u25C6" : "-";
    if (color !== lastColor) {
      segments.push({ color, text: char });
      lastColor = color;
    } else {
      segments[segments.length - 1].text += char;
    }
  }
  const timelineBody = segments.map((s) => `\x1B[${s.color}m${s.text}\x1B[0m`).join("");
  let result = `(${timelineBody})`;
  if (proximityStatus === "surge") {
    result += ` \x1B[1;38;5;208m\u26A1 SURGE 2x\x1B[0m`;
  } else if (proximityStatus === "approaching") {
    result += ` \x1B[1;5;38;5;208m\u26A1 SURGE APPROACHING\x1B[0m`;
  } else if (proximityStatus === "ending") {
    result += ` \x1B[1;5;32m\u26A1 SURGE ENDING\x1B[0m`;
  }
  return result;
}
function buildWtftLines(interactions, defaultSettings, opts) {
  const intervalStr2 = opts?.interval !== void 0 ? opts.interval : defaultSettings.interval;
  const limit2 = opts?.limit !== void 0 ? opts.limit : defaultSettings.limit;
  const isWidget = opts?.isWidget ?? false;
  const disabledEmoji = opts?.disabledEmoji !== void 0 ? opts.disabledEmoji : defaultSettings.disabledEmoji;
  const termWidth = getTerminalWidth(isWidget, disabledEmoji);
  const rawWidth = opts?.width !== void 0 ? opts.width : defaultSettings.width;
  const width = Math.min(rawWidth, termWidth);
  const showTicks2 = opts?.showTicks !== void 0 ? opts.showTicks : defaultSettings.showTicks;
  const mode2 = opts?.mode !== void 0 ? opts.mode : defaultSettings.mode;
  const tz = opts?.timezone !== void 0 ? opts.timezone : defaultSettings.timezone;
  const intervalConfig = parseInterval(intervalStr2);
  interactions = deduplicateInteractions(interactions);
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
  const titleLeft = disabledEmoji ? "[$] WTF Tokens?" : "\u{1F4B8} WTF Tokens?";
  const legendItems = [
    `\x1B[38;5;108m\u2588\x1B[0mSpec`,
    `\x1B[38;5;108;48;5;173m\u2592\x1B[0mMixed`,
    `\x1B[38;5;173m\u2588\x1B[0mCode`,
    `\x1B[38;5;223m\u2588\x1B[0mTests`,
    `\x1B[38;5;134m\u2588\x1B[0mResearch`,
    `\x1B[38;5;73m\u2588\x1B[0mGit`,
    `\x1B[38;5;67m\u2588\x1B[0mGrep`,
    `\x1B[38;5;168m\u2591\x1B[0mPrompt`,
    `\x1B[38;5;238m\u2591\x1B[0mOther`
  ];
  const legendStr = legendItems.join(" ");
  const leftLen = getVisualLength(titleLeft);
  const legendLen = getVisualLength(legendStr);
  const totalNeeded = leftLen + legendLen + 4;
  const forceLegendRow = opts?.forceLegendRow ?? false;
  if (!forceLegendRow && totalNeeded <= finalWidth - 3) {
    const remainingSpaces = finalWidth - 3 - leftLen - legendLen;
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
      const dividerLen = Math.max(0, finalWidth - 3 - dayChangeText.length);
      const dividerChars = Array.from({ length: dividerLen }, () => "\u2500");
      const tickPositions = [
        prefixWidth,
        prefixWidth + Math.floor(maxBarWidth / 4),
        prefixWidth + Math.floor(maxBarWidth / 2),
        prefixWidth + Math.floor(maxBarWidth * 3 / 4),
        prefixWidth + maxBarWidth - 1
      ];
      for (const t of tickPositions) {
        const idx = t - dayChangeText.length;
        if (idx >= 0 && idx < dividerChars.length) {
          dividerChars[idx] = "\u253C";
        }
      }
      const dividerLine = dayChangeText + dividerChars.join("");
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
  const totalOtherCost = interactions.filter((i) => classifyInteraction(i) === "other").reduce((sum, i) => sum + i.cost, 0);
  if (totalSessionCost > 0) {
    const otherPct = totalOtherCost / totalSessionCost;
    if (otherPct > 0.2 && totalOtherCost > 6) {
      const pctStr = `${Math.round(otherPct * 100)}%`;
      const costStr = formatCost(totalOtherCost);
      widgetLines.push(`\x1B[1;33m\u26A0\uFE0F  "Other" category: ${pctStr} of session cost (${costStr}). Run wtft --other to drill down.\x1B[0m`);
    }
  }
  return widgetLines;
}
var SEMANTIC_GROUPS = {
  build: {
    label: "Build & Bundling",
    commands: /* @__PURE__ */ new Set(["npm", "npx", "esbuild", "webpack", "vite", "tsc", "make", "gcc", "cargo", "go", "pnpm", "yarn", "bun", "node", "tsx", "ts-node", "cmake", "ninja", "g++"])
  },
  deps: {
    label: "Dependency Management",
    commands: /* @__PURE__ */ new Set(["pip", "pip3", "gem", "brew", "apt-get", "apt", "dnf", "pacman", "zypper", "apk"])
  },
  lint: {
    label: "Linting & Formatting",
    commands: /* @__PURE__ */ new Set(["eslint", "prettier", "black", "rustfmt", "shfmt", "biome", "stylelint", "shellcheck", "ruff", "flake8", "pylint", "clippy"])
  },
  test: {
    label: "Testing",
    commands: /* @__PURE__ */ new Set(["jest", "vitest", "pytest", "cypress", "playwright", "mocha", "ava", "tap", "karma"])
  },
  db: {
    label: "Database & Infrastructure",
    commands: /* @__PURE__ */ new Set(["sqlite3", "psql", "mysql", "docker", "kubectl", "aws", "terraform", "gh", "fly", "railway", "mongo", "redis-cli", "pg_dump", "pg_restore"])
  },
  sys: {
    label: "System & File Utilities",
    commands: /* @__PURE__ */ new Set(["ls", "mkdir", "cp", "rm", "mv", "chmod", "chown", "touch", "wc", "du", "df", "which", "echo", "pwd", "cd", "ln", "stat", "file", "realpath", "readlink", "dirname", "basename", "tar", "gzip", "gunzip", "zip", "unzip", "curl", "wget", "ssh", "scp", "rsync"])
  },
  git: {
    label: "Git Operations",
    commands: /* @__PURE__ */ new Set(["git"])
  },
  session: {
    label: "Session & Agent",
    commands: /* @__PURE__ */ new Set(["pi", "python", "python3", "bash", "zsh", "clear", "exit", "source", ".", "exec", "env", "export", "alias", "unalias"])
  }
};
function getSemanticCommandGroup(command) {
  const base = command.split("/").pop() || command;
  for (const [key, group] of Object.entries(SEMANTIC_GROUPS)) {
    if (group.commands.has(base)) return group.label;
  }
  if (base === "git" || command.startsWith("git ")) return SEMANTIC_GROUPS.git.label;
  if (command.startsWith("npm ")) return SEMANTIC_GROUPS.build.label;
  if (command.startsWith("yarn ") || command.startsWith("pnpm ") || command.startsWith("bun ")) return SEMANTIC_GROUPS.build.label;
  if (command.startsWith("go ")) return SEMANTIC_GROUPS.build.label;
  if (command.startsWith("cargo ")) return SEMANTIC_GROUPS.build.label;
  if (command.startsWith("pip ") || command.startsWith("pip3 ")) return SEMANTIC_GROUPS.deps.label;
  return null;
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
  const groups = /* @__PURE__ */ new Map();
  for (const [cmd, data] of commandMap) {
    const groupName = getSemanticCommandGroup(cmd) || "Unclassified";
    let group = groups.get(groupName);
    if (!group) {
      group = { count: 0, cost: 0, commands: /* @__PURE__ */ new Map() };
      groups.set(groupName, group);
    }
    group.count += data.count;
    group.cost += data.cost;
    group.commands.set(cmd, data);
  }
  const groupOrder = [
    "Build & Bundling",
    "Dependency Management",
    "Linting & Formatting",
    "Testing",
    "Database & Infrastructure",
    "System & File Utilities",
    "Git Operations",
    "Session & Agent"
  ];
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const ai = groupOrder.indexOf(a[0]);
    const bi = groupOrder.indexOf(b[0]);
    if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  let output = "--- 'Other' Command Histogram ---\n";
  let maxCmdLen = 0;
  for (const cmd of commandMap.keys()) maxCmdLen = Math.max(maxCmdLen, cmd.length);
  const countWidth = 7;
  const costWidth = 10;
  for (const [groupName, group] of sortedGroups) {
    const groupCostStr = `$${group.cost.toFixed(4)}`;
    output += `
[${groupName}]  (${group.count} calls, ${groupCostStr})
`;
    const sortedCmds = Array.from(group.commands.entries()).sort((a, b) => b[1].count - a[1].count);
    for (const [cmd, data] of sortedCmds) {
      const countStr = `(${data.count})`.padStart(countWidth);
      const costStr = `$${data.cost.toFixed(4)}`.padStart(costWidth);
      const barWidth = Math.max(5, maxWidth - maxCmdLen - countWidth - costWidth - 10);
      const bar = "#".repeat(Math.min(data.count, barWidth));
      output += `  ${cmd.padEnd(maxCmdLen)} ${costStr} ${countStr} : ${bar}
`;
    }
  }
  return output;
}
function formatTokenCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function shortenModel(model) {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
function renderTokenSummary(interactions, maxWidth = 80) {
  const deduped = deduplicateInteractions(interactions);
  const byModel = /* @__PURE__ */ new Map();
  let unmatched = 0;
  for (const i of deduped) {
    const model = i.model || "(unknown)";
    if (model === "(unknown)" || model === "<synthetic>") {
      unmatched++;
      continue;
    }
    const agg = byModel.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
    agg.inputTokens += i.inputTokens;
    agg.outputTokens += i.outputTokens;
    agg.cacheReadTokens += i.cacheReadTokens;
    agg.cacheWriteTokens += i.cacheWriteTokens;
    agg.cost += i.cost;
    byModel.set(model, agg);
  }
  if (byModel.size === 0) {
    return unmatched > 0 ? `No model-tagged interactions found (${unmatched} untagged).` : "No model-tagged interactions found.";
  }
  const sorted = Array.from(byModel.entries()).sort((a, b) => b[1].cost - a[1].cost);
  const modelColW = Math.max(10, ...sorted.map(([m]) => shortenModel(m).length));
  const numColW = 10;
  const sep = "\u2500".repeat(Math.min(maxWidth, modelColW + numColW * 4 + 20));
  let out = "";
  out += `
\u2500\u2500 Token Summary (per model, deduped) \u2500\u2500${unmatched > 0 ? `  (${unmatched} untagged interactions skipped)` : ""}
`;
  out += [
    "Model".padEnd(modelColW),
    "Input".padStart(numColW),
    "Output".padStart(numColW),
    "Cache-Read".padStart(numColW),
    "Cache-Write".padStart(numColW),
    "Cost".padStart(numColW)
  ].join(" ") + "\n";
  let totalInput = 0, totalOutput = 0, totalCr = 0, totalCw = 0, totalCost = 0;
  for (const [model, agg] of sorted) {
    out += [
      shortenModel(model).padEnd(modelColW),
      formatTokenCount(agg.inputTokens).padStart(numColW),
      formatTokenCount(agg.outputTokens).padStart(numColW),
      formatTokenCount(agg.cacheReadTokens).padStart(numColW),
      formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
      formatCost(agg.cost).padStart(numColW)
    ].join(" ") + "\n";
    totalInput += agg.inputTokens;
    totalOutput += agg.outputTokens;
    totalCr += agg.cacheReadTokens;
    totalCw += agg.cacheWriteTokens;
    totalCost += agg.cost;
  }
  out += sep + "\n";
  out += [
    "TOTAL".padEnd(modelColW),
    formatTokenCount(totalInput).padStart(numColW),
    formatTokenCount(totalOutput).padStart(numColW),
    formatTokenCount(totalCr).padStart(numColW),
    formatTokenCount(totalCw).padStart(numColW),
    formatCost(totalCost).padStart(numColW)
  ].join(" ") + "\n";
  return out;
}
async function watchMode(sessionPath, settings) {
  if (!process.stdout.isTTY) {
    console.error("\u274C --watch requires a real terminal (TTY). Refusing to start.");
    process.exit(1);
  }
  let totalCost = 0;
  let interactionCount = 0;
  let lastSize = 0;
  let needsRedraw = true;
  let _lastRenderMin = -1;
  process.stdout.write("\x1B[?1049h");
  process.stdout.write("\x1B[?25l");
  let lastBuffer = [];
  const exitWatch = () => {
    process.stdout.write("\x1B[?1049l");
    process.stdout.write("\x1B[?25h");
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (_) {
      }
      try {
        process.stdin.pause();
      } catch (_) {
      }
    }
    if (lastBuffer.length > 0) {
      for (const l of lastBuffer) console.log(l);
    }
    console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
    process.exit(0);
  };
  process.on("SIGINT", exitWatch);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on("data", (data) => {
      const key = data.toString();
      if (key === "q" || key === "Q" || key === "") {
        exitWatch();
      }
    });
  }
  const parseInteractions = (filePath) => {
    const interactions = [];
    let disabledEmoji2 = false;
    let sessionInterval2;
    let sessionLimit2;
    let sessionMode2;
    let sessionShowTicks2;
    let sessionTimezone2;
    try {
      const stat = fs.statSync(filePath);
      const currentSize = stat.size;
      if (currentSize < lastSize) {
        lastSize = 0;
      }
      if (currentSize <= lastSize) return { interactions, disabledEmoji: disabledEmoji2, sessionInterval: sessionInterval2, sessionLimit: sessionLimit2, sessionMode: sessionMode2, sessionShowTicks: sessionShowTicks2, sessionTimezone: sessionTimezone2 };
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(currentSize - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = currentSize;
      const newContent = buf.toString("utf8");
      const lines = newContent.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "custom" && entry.customType === "emoji-settings") {
            if (entry.data && typeof entry.data.disabled === "boolean") {
              disabledEmoji2 = entry.data.disabled;
            }
          } else if (entry.type === "custom" && entry.customType === "wtft-settings") {
            if (entry.data) {
              if (typeof entry.data.interval === "string") sessionInterval2 = entry.data.interval;
              if (typeof entry.data.limit === "number") sessionLimit2 = entry.data.limit;
              if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") sessionMode2 = entry.data.mode;
              if (typeof entry.data.showTicks === "boolean") sessionShowTicks2 = entry.data.showTicks;
              if (typeof entry.data.timezone === "string") sessionTimezone2 = entry.data.timezone;
            }
          }
          const interaction = parseEntryToInteraction(entry);
          if (interaction) {
            interactions.push(interaction);
          }
        } catch {
        }
      }
    } catch {
    }
    return { interactions, disabledEmoji: disabledEmoji2, sessionInterval: sessionInterval2, sessionLimit: sessionLimit2, sessionMode: sessionMode2, sessionShowTicks: sessionShowTicks2, sessionTimezone: sessionTimezone2 };
  };
  let allInteractions = [];
  let disabledEmoji = settings.disabledEmoji;
  let sessionInterval;
  let sessionLimit;
  let sessionMode;
  let sessionShowTicks;
  let sessionTimezone;
  const render = () => {
    const width = getTerminalWidth();
    const finalInterval = sessionInterval ?? settings.interval;
    const finalLimit = sessionLimit ?? settings.limit;
    const finalMode = sessionMode ?? settings.mode;
    const finalShowTicks = sessionShowTicks ?? settings.showTicks;
    const finalTimezone = sessionTimezone ?? settings.timezone;
    const finalWidth = Math.min(settings.width, width);
    const defaultSettings = {
      interval: "1h",
      limit: 100,
      width: finalWidth,
      showTicks: true,
      mode: "cumulative",
      timezone: void 0
    };
    const lines = buildWtftLines(allInteractions, defaultSettings, {
      interval: finalInterval,
      limit: finalLimit,
      width: finalWidth,
      showTicks: finalShowTicks,
      mode: finalMode,
      timezone: finalTimezone,
      disabledEmoji,
      forceLegendRow: true
    });
    const buf = [];
    buf.push("\x1B[H");
    totalCost = allInteractions.reduce((sum, i) => sum + i.cost, 0);
    interactionCount = allInteractions.length;
    buf.push(`\x1B[90m${sessionPath}  (${interactionCount} interactions, $${totalCost.toFixed(4)}) \u2014 q/Ctrl+C to exit\x1B[0m`);
    buf.push("");
    if (lines && lines.length > 0) {
      const tlHour = getCurrentLocalHour(finalTimezone);
      const tlStr = buildTimelineString(/* @__PURE__ */ new Set(), tlHour, void 0);
      lines[0] = lines[0] + "  " + tlStr;
      for (const l of lines) buf.push(l);
    } else {
      buf.push("\x1B[90mWaiting for session data...\x1B[0m");
    }
    lastBuffer = [...buf];
    process.stdout.write(buf.join("\n"));
    needsRedraw = false;
    _lastRenderMin = (/* @__PURE__ */ new Date()).getMinutes();
  };
  render();
  process.on("SIGWINCH", () => {
    needsRedraw = true;
    render();
  });
  const POLL_MS = 667;
  while (true) {
    await new Promise((resolve2) => setTimeout(resolve2, POLL_MS));
    if (!fs.existsSync(sessionPath)) {
      lastSize = 0;
      needsRedraw = true;
      render();
      continue;
    }
    const { interactions: newInteractions, disabledEmoji: newDisabledEmoji, sessionInterval: newInterval, sessionLimit: newLimit, sessionMode: newMode, sessionShowTicks: newTicks, sessionTimezone: newTz } = parseInteractions(sessionPath);
    if (newDisabledEmoji !== void 0) disabledEmoji = newDisabledEmoji;
    if (newInterval !== void 0) sessionInterval = newInterval;
    if (newLimit !== void 0) sessionLimit = newLimit;
    if (newMode !== void 0) sessionMode = newMode;
    if (newTicks !== void 0) sessionShowTicks = newTicks;
    if (newTz !== void 0) sessionTimezone = newTz;
    if (newInteractions.length > 0) {
      allInteractions.push(...newInteractions);
      needsRedraw = true;
    }
    const _curMin = (/* @__PURE__ */ new Date()).getMinutes();
    if (_curMin !== _lastRenderMin) {
      needsRedraw = true;
    }
    if (needsRedraw) {
      render();
    }
  }
}

// extensions/lib/session-selector.ts
import * as fs2 from "node:fs";
import * as path3 from "node:path";
import * as os2 from "node:os";

// extensions/lib/session-path-shortener.ts
import * as path2 from "node:path";
import * as os from "node:os";
function buildDisplayPath(filename, dirSlug, harness) {
  const uuidMatch = filename.match(/([a-f0-9]{4})\.jsonl$/i);
  const uuidTail = uuidMatch ? uuidMatch[1] : "";
  const slug = harness === "pi" ? dirSlug.replace(/^--/, "").replace(/--$/, "") : dirSlug.replace(/^-/, "");
  const homeDir = os.homedir();
  const userName = path2.basename(homeDir);
  const knownPrefix = `home-${userName}-git-projects`;
  const compactPrefix = `home-${userName}-g-p`;
  if (slug.startsWith(knownPrefix + "-")) {
    const projectName = slug.slice(knownPrefix.length + 1);
    const datePrefix2 = harness === "pi" ? extractDatePrefix(filename) : "";
    const pathStr = `~/g-p/${projectName}`;
    return appendTail(pathStr, datePrefix2, uuidTail);
  }
  if (slug.startsWith(compactPrefix + "-")) {
    const projectName = slug.slice(compactPrefix.length + 1);
    const datePrefix2 = harness === "pi" ? extractDatePrefix(filename) : "";
    const pathStr = `~/g-p/${projectName}`;
    return appendTail(pathStr, datePrefix2, uuidTail);
  }
  const cleanedSlug = slug.replace(/-/g, "/");
  const datePrefix = harness === "pi" ? extractDatePrefix(filename) : "";
  return appendTail(cleanedSlug, datePrefix, uuidTail);
}
function extractDatePrefix(filename) {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2}[^_]*)/);
  return match ? match[1] : "";
}
function appendTail(base, datePrefix, uuidTail) {
  if (datePrefix && uuidTail) {
    return `${base}/${datePrefix}...${uuidTail}`;
  }
  if (datePrefix) {
    return `${base}/${datePrefix}`;
  }
  if (uuidTail) {
    return `${base}/...${uuidTail}`;
  }
  return base;
}
function formatRelativeTime(ts) {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1e3);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMo = Math.floor(diffDay / 30);
  if (diffMo < 12) return `${diffMo}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}

// extensions/lib/session-selector.ts
function discoverSessions(harness = "auto", cwdOverride2) {
  const piSessionsDir = path3.join(os2.homedir(), ".pi", "agent", "sessions");
  let claudeSessionsDirs = [];
  const claudeProjectsDir = path3.join(os2.homedir(), ".claude", "projects");
  if (fs2.existsSync(claudeProjectsDir)) {
    const resolvedCwd = cwdOverride2 ? path3.resolve(cwdOverride2) : process.cwd();
    const cwdSlug = resolvedCwd.replace(/[/\\]/g, "-");
    const sessionsSubdir = path3.join(claudeProjectsDir, cwdSlug, "sessions");
    const directDir = path3.join(claudeProjectsDir, cwdSlug);
    if (fs2.existsSync(sessionsSubdir)) claudeSessionsDirs.push(sessionsSubdir);
    if (fs2.existsSync(directDir)) claudeSessionsDirs.push(directDir);
  }
  const candidates = [];
  const walk = (dir, type) => {
    const files = fs2.readdirSync(dir);
    for (const f of files) {
      const fullPath = path3.join(dir, f);
      const stat = fs2.statSync(fullPath);
      if (stat.isDirectory()) {
        if (f !== "subagents" && f !== "tool-results" && f !== "memory" && f !== "wtft-tags") {
          walk(fullPath, type);
        }
      } else if (f.endsWith(".jsonl")) {
        let slug;
        if (type === "pi") {
          slug = path3.basename(dir);
        } else {
          const base = path3.basename(dir);
          slug = base === "sessions" ? path3.basename(path3.dirname(dir)) : base;
        }
        candidates.push({
          path: fullPath,
          harness: type,
          timestamp: stat.mtimeMs,
          name: f,
          displayPath: buildDisplayPath(f, slug, type)
        });
      }
    }
  };
  try {
    if (harness === "auto" || harness === "pi") {
      if (fs2.existsSync(piSessionsDir)) walk(piSessionsDir, "pi");
    }
    if (harness === "auto" || harness === "claude-code") {
      for (const dir of claudeSessionsDirs) {
        if (fs2.existsSync(dir)) walk(dir, "claude-code");
      }
    }
  } catch {
  }
  return candidates.sort((a, b) => b.timestamp - a.timestamp);
}
function getSessionSummary(filePath) {
  let turns = 0;
  const interactions = [];
  try {
    const content = fs2.readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === "assistant" || entry.message && entry.message.role === "assistant") {
          turns++;
        }
        const interaction = parseEntryToInteraction(entry);
        if (interaction) interactions.push(interaction);
      } catch {
      }
    }
  } catch {
  }
  const deduped = deduplicateInteractions(interactions);
  const cost = deduped.reduce((sum, i) => sum + i.cost, 0);
  return { turns, cost };
}
function formatCostPadded(cost) {
  return formatCost(cost).padStart(7);
}
function visualLineCount(text, termWidth) {
  const ansiRe = /\x1b\[[0-9;]*[a-zA-Z]/g;
  const lines = text.replace(/\n$/, "").split("\n");
  let count = 0;
  for (const line of lines) {
    const cleanLen = line.replace(ansiRe, "").length;
    count += cleanLen === 0 ? 1 : Math.ceil(cleanLen / Math.max(termWidth, 1));
  }
  return count;
}
async function selectSessionPrompt(candidates) {
  return new Promise((resolve2) => {
    if (!process.stdout.isTTY) {
      console.log(
        `\x1B[90mNon-interactive environment detected. Defaulting to newest session [1]:\x1B[0m`
      );
      const maxPathLen2 = Math.max(
        ...candidates.slice(0, 5).map((c) => c.displayPath.length),
        10
      );
      for (let i = 0; i < Math.min(candidates.length, 5); i++) {
        const c = candidates[i];
        const stats = getSessionSummary(c.path);
        const relTime = formatRelativeTime(c.timestamp);
        console.log(
          `  [${i + 1}] ${c.displayPath.padEnd(maxPathLen2)}  ${formatCostPadded(stats.cost)}  (${stats.turns}t) [${c.harness === "claude-code" ? "CC" : "PI"}]  \x1B[90m${relTime}\x1B[0m`
        );
      }
      console.log(
        `\x1B[90mRun 'wtft -s <number>' to target a specific session index.\x1B[0m
`
      );
      resolve2(candidates[0].path);
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
    const maxPathLen = Math.max(
      ...displayCandidates.map((c) => c.displayPath.length),
      10
    );
    let lastLineCount = 0;
    const render = () => {
      const selected = displayCandidates[selectedIndex];
      let out = `\x1B[1m\x1B[36m\u{1F4B8} WTFT Session Selector\x1B[0m (j/k or arrows navigate, Enter select, q quit):
`;
      out += `  \x1B[90m${selected.path}\x1B[0m
`;
      for (let i = 0; i < displayCandidates.length; i++) {
        const c = displayCandidates[i];
        const stats = statsList[i];
        const relTime = formatRelativeTime(c.timestamp);
        const isSelected = i === selectedIndex;
        const prefix = isSelected ? "\x1B[36m\x1B[1m > \x1B[0m" : "   ";
        const highlight = isSelected ? "\x1B[1m\x1B[36m" : "";
        const reset = isSelected ? "\x1B[0m" : "";
        const harnessLabel = c.harness === "claude-code" ? "CC" : "PI";
        const costStr = `\x1B[32m${formatCostPadded(stats.cost)}\x1B[0m`;
        out += `${prefix}${highlight}${c.displayPath.padEnd(maxPathLen)}${reset}  ${costStr}  (${stats.turns}t) [${harnessLabel}]  \x1B[90m${relTime}\x1B[0m
`;
      }
      const cols = process.stdout.columns || 80;
      lastLineCount = visualLineCount(out, cols);
      process.stdout.write(out);
    };
    const overwritePrevious = () => {
      if (lastLineCount > 0) {
        process.stdout.write(`\x1B[${lastLineCount}A\x1B[J`);
      }
    };
    render();
    const onKey = (key) => {
      if (key === "" || key === "q" || key === "Q") {
        overwritePrevious();
        cleanup();
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        overwritePrevious();
        const selectedPath = displayCandidates[selectedIndex].path;
        cleanup();
        resolve2(selectedPath);
      } else if (key === "\x1B[A" || key === "k") {
        selectedIndex = (selectedIndex - 1 + displayCandidates.length) % displayCandidates.length;
        overwritePrevious();
        render();
      } else if (key === "\x1B[B" || key === "j") {
        selectedIndex = (selectedIndex + 1) % displayCandidates.length;
        overwritePrevious();
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

// bin/wtft.ts
var intervalStr = "1h";
var limit = 100;
var maxWidthOption = null;
var mode = "cumulative";
var showTicks = true;
var targetSessionPath = void 0;
var timezone = void 0;
var harnessOption = "auto";
var cwdOverride = void 0;
var showOther = false;
var showTokens = false;
function printWhy() {
  try {
    const manifestPath = path4.join(path4.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
    const manifest = JSON.parse(fs3.readFileSync(manifestPath, "utf8"));
    let text = `${manifest.name} - ${manifest.tagline}

`;
    text += `${manifest.description}

`;
    text += `Why run wtft?

`;
    const scenarios = manifest.why || [];
    for (const s of scenarios) {
      text += `  ${s.scenario}
`;
      for (const cmd of s.commands) {
        text += `    $ wtft${cmd ? " " + cmd : ""}
`;
      }
      text += `    \u2192 ${s.result}
`;
      if (s.demo && s.demo.length > 0) {
        for (const line of s.demo) {
          text += `    ${line}
`;
        }
      }
      text += `
`;
    }
    text += `Run wtft --help for the full flag reference.
`;
    console.log(text);
  } catch (err) {
    console.error(`\u26A0\uFE0F Failed to load command manifest: ${err}`);
    process.exitCode = 1;
  }
}
function printHelp() {
  console.log(`
Usage: wtft [options]

Options:
  -s, --session <path>    Specify an explicit session .jsonl log file path (defaults to latest active session).
  --dir, --cwd <path>     Working directory for Claude Code session discovery (default: current directory).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -w, --width <number>    Set the maximum character width of the CLI output (default: 240).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Print a histogram of 'Other' commands grouped by semantic sub-category (Build, Lint, System, etc.).
  -T, --tokens            Print a per-model token summary table (deduped) for cross-referencing with /usage.
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.
  --version               Display this tool's version.
  --why                   Explain why you'd run this tool, with user scenarios and anti-use-cases.
  -h, --help              Display this help menu.
`);
}
var hasInterval = false;
var hasLimit = false;
var hasWidth = false;
var hasCumulative = false;
var hasBucket = false;
var hasNoTicks = false;
var hasTicks = false;
var hasTz = false;
var hasOther = false;
var hasTokens = false;
var showWatch = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  } else if (arg === "--why") {
    printWhy();
    process.exit(0);
  } else if (arg === "--version") {
    const manifestPath = path4.join(path4.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
    const manifest = JSON.parse(fs3.readFileSync(manifestPath, "utf8"));
    console.log(`${manifest.name} ${manifest.version}`);
    process.exit(0);
  } else if (arg === "-s" || arg === "--session") {
    targetSessionPath = process.argv[++i];
  } else if (arg === "-i" || arg === "--interval") {
    intervalStr = process.argv[++i];
    hasInterval = true;
  } else if (arg === "-l" || arg === "--limit") {
    limit = parseInt(process.argv[++i], 10);
    hasLimit = true;
  } else if (arg === "-w" || arg === "--width") {
    maxWidthOption = parseInt(process.argv[++i], 10);
    hasWidth = true;
  } else if (arg === "-c" || arg === "--cumulative") {
    mode = "cumulative";
    hasCumulative = true;
  } else if (arg === "-b" || arg === "--bucket") {
    mode = "bucket";
    hasBucket = true;
  } else if (arg === "--no-ticks") {
    showTicks = false;
    hasNoTicks = true;
  } else if (arg === "--ticks") {
    showTicks = true;
    hasTicks = true;
  } else if (arg === "-t" || arg === "--tz") {
    timezone = process.argv[++i];
    hasTz = true;
  } else if (arg === "-o" || arg === "--other") {
    showOther = true;
    hasOther = true;
  } else if (arg === "--tokens" || arg === "-T") {
    showTokens = true;
    hasTokens = true;
  } else if (arg === "-W" || arg === "--watch") {
    showWatch = true;
  } else if (arg === "--dir" || arg === "--cwd") {
    cwdOverride = process.argv[++i];
  } else if (arg === "--harness") {
    const val = process.argv[++i];
    if (val === "pi" || val === "claude-code" || val === "auto") {
      harnessOption = val;
    }
  }
}
async function main() {
  const isIndex = /^\d+$/.test(targetSessionPath || "");
  const candidates = discoverSessions(harnessOption, cwdOverride);
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
  if (!finalSessionPath || !fs3.existsSync(finalSessionPath)) {
    console.error("\u274C Error: Selected session log file path is invalid or does not exist.");
    process.exit(1);
  }
  if (showWatch) {
    const termColumns2 = getTerminalWidth();
    const maxWidth2 = hasWidth ? maxWidthOption : 240;
    await watchMode(finalSessionPath, {
      interval: hasInterval ? intervalStr : "1h",
      limit: hasLimit ? limit : 100,
      width: Math.min(maxWidth2, termColumns2),
      mode: hasCumulative || hasBucket ? mode : "cumulative",
      showTicks: hasTicks || hasNoTicks ? showTicks : true,
      timezone: hasTz ? timezone : void 0,
      disabledEmoji: false
    });
    return;
  }
  const sessionFiles = [finalSessionPath];
  const extName = path4.extname(finalSessionPath);
  if (extName === ".jsonl") {
    const baseName = path4.basename(finalSessionPath, extName);
    const parentDir = path4.dirname(finalSessionPath);
    const possibleSubagentsDir = path4.join(parentDir, baseName, "subagents");
    if (fs3.existsSync(possibleSubagentsDir)) {
      try {
        const subFiles = fs3.readdirSync(possibleSubagentsDir);
        for (const f of subFiles) {
          if (f.startsWith("agent-") && f.endsWith(".jsonl")) {
            sessionFiles.push(path4.join(possibleSubagentsDir, f));
          }
        }
      } catch {
      }
    }
  }
  const interactions = [];
  for (const file of sessionFiles) {
    interactions.push(...parseSessionFile(file));
  }
  let disabledEmoji = false;
  let sessionInterval;
  let sessionLimit;
  let sessionWidth;
  let sessionMode;
  let sessionShowTicks;
  let sessionTimezone;
  if (sessionFiles.length > 0) {
    try {
      const content = fs3.readFileSync(sessionFiles[0], "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "custom" && entry.customType === "emoji-settings") {
            if (entry.data && typeof entry.data.disabled === "boolean") {
              disabledEmoji = entry.data.disabled;
            }
          } else if (entry.type === "custom" && entry.customType === "wtft-settings") {
            if (entry.data) {
              if (typeof entry.data.interval === "string") sessionInterval = entry.data.interval;
              if (typeof entry.data.limit === "number") sessionLimit = entry.data.limit;
              if (typeof entry.data.width === "number") sessionWidth = entry.data.width;
              if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") {
                sessionMode = entry.data.mode;
              }
              if (typeof entry.data.showTicks === "boolean") sessionShowTicks = entry.data.showTicks;
              if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
            }
          }
        } catch {
        }
      }
    } catch {
    }
  }
  const termColumns = getTerminalWidth();
  const maxWidth = hasWidth ? maxWidthOption : sessionWidth ?? 240;
  const finalInterval = hasInterval ? intervalStr : sessionInterval ?? "1h";
  const finalLimit = hasLimit ? limit : sessionLimit ?? 100;
  const finalMode = hasCumulative || hasBucket ? mode : sessionMode ?? "cumulative";
  const finalShowTicks = hasTicks || hasNoTicks ? showTicks : sessionShowTicks ?? true;
  const finalTimezone = hasTz ? timezone : sessionTimezone;
  const defaultSettings = {
    interval: "1h",
    limit: 100,
    width: maxWidth,
    showTicks: true,
    mode: "cumulative",
    timezone: void 0
  };
  const outputLines = buildWtftLines(interactions, defaultSettings, {
    interval: finalInterval,
    limit: finalLimit,
    width: maxWidth,
    showTicks: finalShowTicks,
    mode: finalMode,
    timezone: finalTimezone,
    disabledEmoji
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
    const dedupedInteractions = deduplicateInteractions(interactions);
    const otherOutput = renderOtherHistogram(dedupedInteractions, maxWidth);
    console.log(otherOutput);
  }
  if (showTokens) {
    const tokenOutput = renderTokenSummary(interactions, maxWidth);
    console.log(tokenOutput);
  }
}
main().catch((err) => {
  console.error(`\u274C System Error: ${err.message}`);
  process.exit(1);
});

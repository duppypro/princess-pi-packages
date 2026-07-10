#!/usr/bin/env node

// bin/wtft.ts
import * as fs5 from "node:fs";
import * as path6 from "node:path";
import { fileURLToPath } from "node:url";

// extensions/lib/wtft-cost.ts
var WEB_SEARCH_PRICE = 0.03;
var WEB_FETCH_PRICE = 0.03;
function calculateServerToolCost(model, webSearchRequests, webFetchRequests) {
  const m = (model || "").toLowerCase();
  if (!m.includes("claude") && !/\b(haiku|sonnet|opus)\b/.test(m)) {
    return 0;
  }
  return webSearchRequests * WEB_SEARCH_PRICE + webFetchRequests * WEB_FETCH_PRICE;
}
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
      inputPrice = 1.74 * peak;
      outputPrice = 3.48 * peak;
      cacheReadPrice = 0.0145 * peak;
    } else {
      inputPrice = 0.14 * peak;
      outputPrice = 0.28 * peak;
      cacheReadPrice = 28e-4 * peak;
    }
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
  const cost = (usage.input_tokens || 0) * (inputPrice / 1e6) + (usage.output_tokens || 0) * (outputPrice / 1e6) + (usage.reasoning_tokens || usage.reasoning || 0) * (outputPrice / 1e6) + cacheWriteCost + (usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1e6);
  return cost;
}

// extensions/lib/wtft-parser.ts
import * as path from "node:path";
import * as fs from "node:fs";
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
    const hasTokens2 = (usage.input_tokens || usage.input || 0) > 0 || (usage.output_tokens || usage.output || 0) > 0 || (usage.cache_read_input_tokens || usage.cacheRead || 0) > 0 || (usage.cache_creation_input_tokens || usage.cacheWrite || 0) > 0 || (usage.reasoning_tokens || usage.reasoning || 0) > 0;
    if (piCost !== void 0 && piCost !== null && !(piCost === 0 && hasTokens2)) {
      cost = piCost;
    } else if (assistantMsg.model && hasTokens2) {
      const normalizedUsage = {
        input_tokens: usage.input_tokens ?? usage.input ?? 0,
        output_tokens: usage.output_tokens ?? usage.output ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
        cache_creation: usage.cache_creation || null,
        reasoning_tokens: usage.reasoning_tokens ?? usage.reasoning ?? 0
      };
      cost = calculateClaudeCost(assistantMsg.model, normalizedUsage, timestamp);
    }
    const serverToolRequests = usage.server_tool_use || {};
    const serverToolCost = calculateServerToolCost(
      assistantMsg.model || "",
      serverToolRequests.web_search_requests || 0,
      serverToolRequests.web_fetch_requests || 0
    );
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
      reasoningTokens: usage.reasoning || 0,
      webSearchRequests: serverToolRequests.web_search_requests || 0,
      webFetchRequests: serverToolRequests.web_fetch_requests || 0,
      serverToolCost,
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
function normalizeCommand(cmd) {
  let normalized = cmd.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const stripped = normalized.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*)+/, "");
    if (stripped !== normalized) {
      normalized = stripped.trim();
      changed = true;
    }
    const afterSep = normalized.replace(/^(?:&&|;|\|\|?)\s*/, "");
    if (afterSep !== normalized) {
      normalized = afterSep;
      changed = true;
    }
    const afterCd = normalized.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, "");
    if (afterCd !== normalized) {
      normalized = afterCd;
      changed = true;
    }
  }
  return normalized;
}
function classifyInteraction(interaction) {
  if (interaction._cat) return interaction._cat;
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
      const normalized = normalizeCommand(cmd);
      if (!normalized) continue;
      const lower = normalized.toLowerCase().trim();
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

// extensions/lib/wtft-renderer.ts
function parseInterval(val) {
  const match = /^(\d+)([mhdw])$/.exec(val);
  if (match) {
    const size = parseInt(match[1], 10);
    const unit = match[2];
    if (size > 0) return { size, unit };
  }
  return { size: 1, unit: "h" };
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
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStr = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const { size, unit } = config;
  if (unit === "m") {
    const totalMins = parts.hour * 60 + parts.minute;
    const binnedMins = Math.floor(totalMins / size) * size;
    return {
      key: `${dateStr}T${pad2(Math.floor(binnedMins / 60))}:${pad2(binnedMins % 60)}:00`,
      label: `${pad2(Math.floor(binnedMins / 60))}:${pad2(binnedMins % 60)}`,
      dateStr
    };
  } else if (unit === "h") {
    const startHours = Math.floor(parts.hour / size) * size;
    return {
      key: `${dateStr}T${pad2(startHours)}:00:00`,
      label: `${pad2(startHours)}:00`,
      dateStr
    };
  } else if (unit === "d") {
    const binnedDays = Math.floor((parts.day - 1) / size) * size;
    const label = `${parts.year}-${pad2(parts.month)}-${pad2(binnedDays + 1)}`;
    return { key: `${label}T00:00:00`, label, dateStr: label };
  } else {
    const info = getIsoWeekAndMonday(parts);
    const label = `W${pad2(info.weekNum)} ${pad2(info.mondayMonth)}-${pad2(info.mondayDay)}`;
    return {
      key: `${info.mondayYear}-${pad2(info.mondayMonth)}-${pad2(info.mondayDay)}T00:00:00`,
      label,
      dateStr: `${info.mondayYear}-${pad2(info.mondayMonth)}-${pad2(info.mondayDay)}`
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
    const pad2 = (n) => String(n).padStart(2, "0");
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]}-${pad2(day)}`;
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
function getTimezoneOffsetMs(timestamp, tz) {
  const parts = getZonedParts(timestamp, tz);
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcMs - timestamp;
}
function getSurgeLocalHours(tz) {
  const result = /* @__PURE__ */ new Set();
  const now = Date.now();
  for (let localHour = 0; localHour < 24; localHour++) {
    let ts;
    if (tz) {
      const parts = getZonedParts(now, tz);
      const offsetMs = getTimezoneOffsetMs(now, tz);
      ts = Date.UTC(parts.year, parts.month - 1, parts.day, localHour, 0, 0, 0) - offsetMs;
    } else {
      const d = /* @__PURE__ */ new Date();
      d.setHours(localHour, 0, 0, 0);
      ts = d.getTime();
    }
    const utcHour = new Date(ts).getUTCHours();
    if (utcHour >= 1 && utcHour < 4 || utcHour >= 6 && utcHour < 10) {
      result.add(localHour);
    }
  }
  return result;
}
function checkSurgeProximity() {
  const now = /* @__PURE__ */ new Date();
  const currentUtcMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const surgeWindows = [[60, 240], [360, 600]];
  for (const [start, end] of surgeWindows) {
    if (currentUtcMinute >= start && currentUtcMinute < end) {
      return { status: "surge", multiplier: 2 };
    }
    if (currentUtcMinute >= start - 20 && currentUtcMinute < start) {
      return { status: "approaching", multiplier: 2 };
    }
    if (currentUtcMinute >= end - 20 && currentUtcMinute < end) {
      return { status: "ending", multiplier: 2 };
    }
  }
  return { status: void 0, multiplier: 1 };
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
  const ALL_CATEGORIES = ["spec", "code", "mixed", "tests", "research", "git", "grep", "web", "prompt", "other"];
  for (const interaction of interactions) {
    const classification = classifyInteraction(interaction);
    const { key, label, dateStr } = getBinInfo(interaction.timestamp, intervalConfig, tz);
    totalSessionCost += interaction.cost;
    let bin = binMap.get(key);
    if (!bin) {
      const costs = {};
      for (const cat of ALL_CATEGORIES) {
        costs[cat] = 0;
      }
      bin = { label, dateStr, costs, total_cost: 0 };
      binMap.set(key, bin);
    }
    bin.costs[classification] += interaction.cost;
    bin.total_cost += interaction.cost;
    if (interaction.serverToolCost) {
      bin.costs["web"] += interaction.serverToolCost;
      bin.total_cost += interaction.serverToolCost;
      totalSessionCost += interaction.serverToolCost;
    }
  }
  const sortedBins = Array.from(binMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map((entry) => entry[1]);
  if (mode2 === "cumulative") {
    const runningCosts = {};
    for (const cat of ALL_CATEGORIES) {
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
    const pad2 = (n) => String(n).padStart(2, "0");
    titleDateStr = `${months[nowParts.month - 1]}-${pad2(nowParts.day)}`;
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
    `\x1B[38;5;209m\u2593\x1B[0mWeb`,
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
      if (chars.web > 0) {
        barStr += `\x1B[38;5;209m${"\u2593".repeat(chars.web)}\x1B[0m`;
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
        { cat: "web", color: "\x1B[38;5;209m", char: "\u2593" },
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
  let surgeModel = opts?.model;
  if (!surgeModel) {
    for (const i of interactions) {
      if (i.model) {
        surgeModel = i.model;
        break;
      }
    }
  }
  const isDeepSeek = (surgeModel || "").toLowerCase().includes("deepseek");
  const surgeHours = isDeepSeek ? getSurgeLocalHours(tz) : /* @__PURE__ */ new Set();
  const currentHour = getCurrentLocalHour(tz);
  const proximity = isDeepSeek ? checkSurgeProximity() : { status: void 0, multiplier: 1 };
  const timelineStr = buildTimelineString(surgeHours, currentHour, proximity.status);
  widgetLines[0] = widgetLines[0] + "  " + timelineStr;
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
        const normalized = normalizeCommand(rawCmd);
        if (!normalized) continue;
        const lines = normalized.split("\n");
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
    const agg = byModel.get(model) || { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 0 };
    agg.inputTokens += i.inputTokens;
    agg.outputTokens += i.outputTokens;
    agg.cacheReadTokens += i.cacheReadTokens;
    agg.cacheWriteTokens += i.cacheWriteTokens;
    agg.reasoningTokens += i.reasoningTokens;
    agg.cost += i.cost;
    byModel.set(model, agg);
  }
  if (byModel.size === 0) {
    return unmatched > 0 ? `No model-tagged interactions found (${unmatched} untagged).` : "No model-tagged interactions found.";
  }
  const sorted = Array.from(byModel.entries()).sort((a, b) => b[1].cost - a[1].cost);
  const modelColW = Math.max(10, ...sorted.map(([m]) => shortenModel(m).length));
  const numColW = 10;
  const sep = "\u2500".repeat(Math.min(maxWidth, modelColW + numColW * 5 + 24));
  let out = "";
  out += `
\u2500\u2500 Token Summary (per model, deduped) \u2500\u2500${unmatched > 0 ? `  (${unmatched} untagged interactions skipped)` : ""}
`;
  out += [
    "Model".padEnd(modelColW),
    "Input".padStart(numColW),
    "Output".padStart(numColW),
    "Reasoning".padStart(numColW),
    "Cache-Read".padStart(numColW),
    "Cache-Write".padStart(numColW),
    "Cost".padStart(numColW)
  ].join(" ") + "\n";
  let totalInput = 0, totalOutput = 0, totalCr = 0, totalCw = 0, totalReasoning = 0, totalCost = 0;
  for (const [model, agg] of sorted) {
    out += [
      shortenModel(model).padEnd(modelColW),
      formatTokenCount(agg.inputTokens).padStart(numColW),
      formatTokenCount(agg.outputTokens).padStart(numColW),
      formatTokenCount(agg.reasoningTokens).padStart(numColW),
      formatTokenCount(agg.cacheReadTokens).padStart(numColW),
      formatTokenCount(agg.cacheWriteTokens).padStart(numColW),
      formatCost(agg.cost).padStart(numColW)
    ].join(" ") + "\n";
    totalInput += agg.inputTokens;
    totalOutput += agg.outputTokens;
    totalCr += agg.cacheReadTokens;
    totalCw += agg.cacheWriteTokens;
    totalReasoning += agg.reasoningTokens;
    totalCost += agg.cost;
  }
  out += sep + "\n";
  out += [
    "TOTAL".padEnd(modelColW),
    formatTokenCount(totalInput).padStart(numColW),
    formatTokenCount(totalOutput).padStart(numColW),
    formatTokenCount(totalReasoning).padStart(numColW),
    formatTokenCount(totalCr).padStart(numColW),
    formatTokenCount(totalCw).padStart(numColW),
    formatCost(totalCost).padStart(numColW)
  ].join(" ") + "\n";
  return out;
}

// extensions/lib/wtft-daemon-lib.ts
import * as path2 from "node:path";
import * as fs2 from "node:fs";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// extensions/lib/tty-helpers.ts
function enterRawStdin(onKey) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {
  };
  stdin.resume();
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  const handler = (data) => onKey(data.toString());
  stdin.on("data", handler);
  return () => {
    stdin.removeListener("data", handler);
    stdin.setRawMode(false);
    stdin.pause();
  };
}
function showCursor() {
  process.stdout.write("\x1B[?25h");
}
function hideCursor() {
  process.stdout.write("\x1B[?25l");
}
function clearPreviousLines(lineCount) {
  if (lineCount > 0) {
    process.stdout.write(`\x1B[${lineCount}A\x1B[J`);
  }
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

// extensions/lib/wtft-daemon-lib.ts
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
  hideCursor();
  let lastBuffer = [];
  let lastLineCount = 0;
  const exitWatch = () => {
    clearPreviousLines(lastLineCount);
    showCursor();
    cleanupStdin();
    if (lastBuffer.length > 0) {
      for (const l of lastBuffer) console.log(l);
    }
    console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
    process.exit(0);
  };
  process.on("SIGINT", exitWatch);
  const cleanupStdin = enterRawStdin((key) => {
    if (key === "q" || key === "Q" || key === "") {
      exitWatch();
    }
  });
  const parseInteractions = (filePath) => {
    const interactions = [];
    let disabledEmoji2 = false;
    let sessionInterval2;
    let sessionLimit2;
    let sessionMode2;
    let sessionShowTicks2;
    let sessionTimezone2;
    try {
      const stat = fs2.statSync(filePath);
      const currentSize = stat.size;
      if (currentSize < lastSize) {
        lastSize = 0;
      }
      if (currentSize <= lastSize) return { interactions, disabledEmoji: disabledEmoji2, sessionInterval: sessionInterval2, sessionLimit: sessionLimit2, sessionMode: sessionMode2, sessionShowTicks: sessionShowTicks2, sessionTimezone: sessionTimezone2 };
      const fd = fs2.openSync(filePath, "r");
      const buf = Buffer.alloc(currentSize - lastSize);
      fs2.readSync(fd, buf, 0, buf.length, lastSize);
      fs2.closeSync(fd);
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
  let disabledEmoji = false;
  let sessionInterval;
  let sessionLimit;
  let sessionMode;
  let sessionShowTicks;
  let sessionTimezone;
  process.stdout.write("\x1B7");
  const render = () => {
    clearPreviousLines(lastLineCount);
    const width = getTerminalWidth();
    const finalInterval = settings.hasInterval ? settings.interval : sessionInterval ?? settings.interval;
    const finalLimit = settings.hasLimit ? settings.limit : sessionLimit ?? settings.limit;
    const finalMode = settings.hasMode ? settings.mode : sessionMode ?? settings.mode;
    const finalShowTicks = settings.hasTicks ? settings.showTicks : sessionShowTicks ?? settings.showTicks;
    const finalTimezone = settings.hasTimezone ? settings.timezone : sessionTimezone ?? settings.timezone;
    const finalWidth = Math.min(width, 1023);
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
    buf.push(`\x1B[90m${sessionPath}\x1B[0m`);
    totalCost = deduplicateInteractions(allInteractions).reduce((sum, i) => sum + i.cost, 0);
    if (lines && lines.length > 0) {
      for (const l of lines) buf.push(l);
    } else {
      buf.push("\x1B[90mWaiting for session data...\x1B[0m");
    }
    buf.push(`'q' to exit`);
    lastBuffer = [...buf];
    const output = buf.join("\n") + "\n";
    process.stdout.write(output);
    lastLineCount = visualLineCount(output, width);
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
    if (!fs2.existsSync(sessionPath)) {
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
function classifiedToInteraction(obj) {
  if (!obj || typeof obj.t !== "number" || typeof obj.c !== "number") return null;
  return {
    timestamp: obj.t,
    cost: obj.c,
    messageId: obj.id || void 0,
    model: obj.m || void 0,
    files: (obj.f || []).map((f) => ({ path: f.p || "", action: f.a === "w" ? "write" : "read" })),
    commands: obj.cmd || [],
    texts: [],
    inputTokens: obj.in || 0,
    outputTokens: obj.out || 0,
    cacheReadTokens: obj.cr || 0,
    cacheWriteTokens: obj.cw || 0,
    reasoningTokens: obj.rs || 0,
    webSearchRequests: obj.ws || 0,
    webFetchRequests: obj.wf || 0,
    serverToolCost: obj.sc || 0,
    _cat: obj.cat || void 0
  };
}
function readClassifiedTagFile(tagPath) {
  const interactions = [];
  try {
    const content = fs2.readFileSync(tagPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._hb) continue;
        const interaction = classifiedToInteraction(obj);
        if (interaction) interactions.push(interaction);
      } catch {
      }
    }
  } catch {
  }
  return interactions;
}
var WTFT_TAGGER_VERSION = "2.3.6";
function getDaemonPidPath(sessionPath) {
  const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
  return path2.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
}
var IDLE_THRESHOLD_MS = 122e3;
var IDLE_EXIT_MS = 24 * 60 * 60 * 1e3;
function getModelCacheTtlMs(model) {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) {
    return 60 * 60 * 1e3;
  }
  if (m.includes("claude")) {
    return 5 * 60 * 1e3;
  }
  if (m.includes("gemini")) {
    return 60 * 60 * 1e3;
  }
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3")) {
    return 30 * 60 * 1e3;
  }
  if (m.includes("together") || m.includes("fireworks") || m.includes("openrouter")) {
    return 30 * 60 * 1e3;
  }
  if (/\b(haiku|sonnet|opus)\b/.test(m)) {
    return 5 * 60 * 1e3;
  }
  if (m.includes("ollama") || m.includes("llama") || m.includes("lmstudio") || m.includes("local")) {
    return null;
  }
  return 5 * 60 * 1e3;
}
function renderDaemonStatus(status, restarting = false) {
  if (restarting) {
    return "  \x1B[33m\u25CF\x1B[0m restarting...";
  }
  if (!status.alive) {
    const label = status.lastHbTime ? `stopped ${status.lastHbTime}` : status.reason || "unknown";
    return `  \x1B[31m\u25CF\x1B[0m ${label}`;
  }
  if (status.idle) {
    const cacheTtlMs = status.cacheTtlMs;
    if (cacheTtlMs != null && status.idleMs != null) {
      const remainingMs = Math.max(0, cacheTtlMs - (status.idleMs || 0));
      const remainingSec = Math.floor(remainingMs / 1e3);
      if (remainingSec >= 3600) {
        const h = Math.floor(remainingSec / 3600);
        const m2 = Math.floor(remainingSec % 3600 / 60);
        return `  \x1B[33m\u25CF\x1B[0m idle (${h}h${m2}m to expire)`;
      }
      const m = Math.floor(remainingSec / 60);
      const s = remainingSec % 60;
      return `  \x1B[33m\u25CF\x1B[0m idle (${m}:${String(s).padStart(2, "0")} to expire)`;
    }
    if (cacheTtlMs === null) {
      return "  \x1B[32m\u25CF\x1B[0m No Cache (local)";
    }
    return "  \x1B[33m\u25CF\x1B[0m idle";
  }
  return "  \x1B[32m\u25CF\x1B[0m live";
}
function checkDaemonHealth(sessionPath, tagPath) {
  const pidPath = getDaemonPidPath(sessionPath);
  let pidAlive = false;
  try {
    const pid = parseInt(fs2.readFileSync(pidPath, "utf8").trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        pidAlive = true;
      } catch {
      }
    }
  } catch {
  }
  if (pidAlive) {
    try {
      const stat = fs2.statSync(tagPath);
      if (stat.size > 0) {
        const fd = fs2.openSync(tagPath, "r");
        const buf = Buffer.alloc(Math.min(stat.size, 8192));
        fs2.readSync(fd, buf, 0, buf.length, Math.max(0, stat.size - 8192));
        fs2.closeSync(fd);
        const lines = buf.toString("utf8").split("\n");
        let lastModel;
        let idleMs;
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (!lastModel && obj.m) lastModel = obj.m;
            if (obj._hb) {
              if (typeof obj._hb === "object" && obj._hb.first && idleMs === void 0) {
                idleMs = Date.now() - obj._hb.first;
              }
              continue;
            }
            break;
          } catch {
            continue;
          }
        }
        if (idleMs !== void 0 && idleMs >= IDLE_THRESHOLD_MS) {
          const cacheTtlMs = lastModel ? getModelCacheTtlMs(lastModel) : null;
          return { alive: true, idle: true, idleMs, cacheTtlMs };
        }
      }
    } catch {
    }
    return { alive: true };
  }
  let lastHbMs = 0;
  try {
    const stat = fs2.statSync(tagPath);
    const readStart = Math.max(0, stat.size - 8192);
    const fd = fs2.openSync(tagPath, "r");
    const buf = Buffer.alloc(stat.size - readStart);
    fs2.readSync(fd, buf, 0, buf.length, readStart);
    fs2.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._hb && obj._hb.last) {
          lastHbMs = obj._hb.last;
          break;
        }
      } catch {
      }
    }
  } catch {
  }
  if (lastHbMs === 0) {
    return { alive: false, reason: "log parser not found" };
  }
  const d = new Date(lastHbMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const timeStr = `${hh}:${mm}`;
  return { alive: false, reason: "idle timeout", lastHbTime: timeStr };
}
function restartDaemon(sessionPath, daemonPath) {
  const pidPath = getDaemonPidPath(sessionPath);
  try {
    const pid = parseInt(fs2.readFileSync(pidPath, "utf8").trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
      }
    }
    try {
      fs2.unlinkSync(pidPath);
    } catch {
    }
  } catch {
  }
  try {
    const child = spawn(process.execPath, [daemonPath, "--session", sessionPath], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
async function watchTagFile(sessionPath, tagPath, settings) {
  if (!process.stdout.isTTY) {
    console.error("\u274C --watch requires a real terminal (TTY). Refusing to start.");
    process.exit(1);
  }
  let totalCost = 0;
  let interactionCount = 0;
  let needsRedraw = true;
  let _lastRenderMin = -1;
  let lastLineCount = 0;
  hideCursor();
  let lastBuffer = [];
  const exitWatch = () => {
    if (watcher) watcher.close();
    clearPreviousLines(lastLineCount);
    showCursor();
    cleanupStdin();
    if (lastBuffer.length > 0) {
      for (const l of lastBuffer) console.log(l);
    }
    console.log(`WTFT watch stopped \u2014 ${interactionCount} interactions, $${totalCost.toFixed(4)} total cost.`);
    process.exit(0);
  };
  process.on("SIGINT", exitWatch);
  let daemonDead = false;
  let daemonStopReason = "";
  let daemonStopTime = "";
  let daemonRestarting = false;
  let daemonIdle = false;
  let daemonIdleMs = 0;
  let daemonCacheTtlMs = void 0;
  const updateDaemonHealth = () => {
    if (daemonRestarting) {
      const health2 = checkDaemonHealth(sessionPath, tagPath);
      if (health2.alive) {
        daemonRestarting = false;
        daemonDead = false;
        daemonStopReason = "";
        daemonStopTime = "";
        daemonIdle = false;
      }
      return;
    }
    const health = checkDaemonHealth(sessionPath, tagPath);
    if (!health.alive) {
      daemonDead = true;
      daemonStopReason = health.reason || "unknown";
      daemonStopTime = health.lastHbTime || "";
      daemonIdle = false;
    } else if (health.idle) {
      daemonDead = false;
      daemonStopReason = "";
      daemonStopTime = "";
      daemonIdle = true;
      daemonIdleMs = health.idleMs || 0;
      daemonCacheTtlMs = health.cacheTtlMs;
    } else {
      daemonDead = false;
      daemonStopReason = "";
      daemonStopTime = "";
      daemonIdle = false;
    }
  };
  const cleanupStdin = enterRawStdin((key) => {
    if (key === "q" || key === "Q" || key === "") {
      exitWatch();
    }
    if (key === "r" || key === "R") {
      if (settings.daemonPath) {
        daemonRestarting = true;
        daemonDead = false;
        daemonIdle = false;
        const ok = restartDaemon(sessionPath, settings.daemonPath);
        if (!ok) {
          daemonRestarting = false;
          daemonDead = true;
          daemonStopReason = "restart failed";
        }
        needsRedraw = true;
        render();
        let pollCount = 0;
        const postRestartPoll = setInterval(() => {
          pollCount++;
          updateDaemonHealth();
          if (!daemonRestarting || pollCount >= 5) {
            clearInterval(postRestartPoll);
          }
          needsRedraw = true;
          render();
        }, 1e3);
      }
    }
  });
  let disabledEmoji = false;
  let allInteractions = readClassifiedTagFile(tagPath);
  let lastReadOffset = 0;
  try {
    lastReadOffset = fs2.statSync(tagPath).size;
  } catch {
  }
  let sessionInterval;
  let sessionLimit;
  let sessionMode;
  let sessionShowTicks;
  let sessionTimezone;
  try {
    const sessionContent = fs2.readFileSync(sessionPath, "utf8");
    for (const line of sessionContent.split("\n")) {
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
            if (entry.data.mode === "cumulative" || entry.data.mode === "bucket") sessionMode = entry.data.mode;
            if (typeof entry.data.showTicks === "boolean") sessionShowTicks = entry.data.showTicks;
            if (typeof entry.data.timezone === "string") sessionTimezone = entry.data.timezone;
          }
        }
      } catch {
      }
    }
  } catch {
  }
  const render = () => {
    clearPreviousLines(lastLineCount);
    const width = getTerminalWidth();
    const pad2 = settings.pad || 0;
    const maxPad = Math.max(0, Math.floor(width / 2) - 1);
    const actualPad = Math.min(pad2, maxPad);
    const padStr = " ".repeat(actualPad);
    const paddedWidth = width - 2 * actualPad;
    const finalInterval = settings.hasInterval ? settings.interval : sessionInterval ?? settings.interval;
    const finalLimit = settings.hasLimit ? settings.limit : sessionLimit ?? settings.limit;
    const finalMode = settings.hasMode ? settings.mode : sessionMode ?? settings.mode;
    const finalShowTicks = settings.hasTicks ? settings.showTicks : sessionShowTicks ?? settings.showTicks;
    const finalTimezone = settings.hasTimezone ? settings.timezone : sessionTimezone ?? settings.timezone;
    const finalWidth = Math.min(paddedWidth, 1023);
    const defaultSettings = {
      interval: "1h",
      limit: 100,
      width: finalWidth,
      showTicks: true,
      mode: "cumulative",
      timezone: void 0
    };
    const deduped = deduplicateInteractions(allInteractions);
    interactionCount = deduped.length;
    const lines = buildWtftLines(deduped, defaultSettings, {
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
    buf.push(`\x1B[90m${sessionPath}\x1B[0m`);
    totalCost = deduped.reduce((sum, i) => sum + i.cost, 0);
    if (lines && lines.length > 0) {
      let daemonStatusStr = "";
      if (daemonRestarting) {
        daemonStatusStr = renderDaemonStatus({ alive: true }, true);
      } else if (daemonDead) {
        daemonStatusStr = renderDaemonStatus({ alive: false, reason: daemonStopReason || void 0, lastHbTime: daemonStopTime || void 0 }, false);
      } else if (daemonIdle) {
        daemonStatusStr = renderDaemonStatus({ alive: true, idle: true, idleMs: daemonIdleMs, cacheTtlMs: daemonCacheTtlMs }, false);
      } else {
        daemonStatusStr = renderDaemonStatus({ alive: true }, false);
      }
      if (daemonStatusStr) {
        const titleVisualLen = getVisualLength(lines[0]);
        const statusVisualLen = getVisualLength(daemonStatusStr);
        if (titleVisualLen + statusVisualLen <= finalWidth - 2) {
          lines[0] = lines[0] + daemonStatusStr;
        } else {
          lines.splice(1, 0, daemonStatusStr.trim());
        }
      }
      for (const l of lines) buf.push(l);
    } else {
      buf.push("\x1B[90mWaiting for session data...\x1B[0m");
    }
    const restartHint = settings.daemonPath ? `, using v${WTFT_TAGGER_VERSION}, ` + (daemonDead ? `\x1B[31m'r' to restart\x1B[0m` : `'r' to restart`) : "";
    buf.push(`'q' to exit${restartHint}`);
    lastBuffer = [...buf];
    const output = buf.map((l) => padStr + l).join("\n") + "\n";
    process.stdout.write(output);
    lastLineCount = visualLineCount(output, width);
    needsRedraw = false;
    _lastRenderMin = (/* @__PURE__ */ new Date()).getMinutes();
  };
  render();
  process.on("SIGWINCH", () => {
    needsRedraw = true;
    render();
  });
  let watcher = null;
  const startWatching = () => {
    watcher = fs2.watch(tagPath, (eventType) => {
      if (eventType !== "change") return;
      try {
        const stat = fs2.statSync(tagPath);
        if (stat.size <= lastReadOffset) return;
        const fd = fs2.openSync(tagPath, "r");
        const buf = Buffer.alloc(stat.size - lastReadOffset);
        fs2.readSync(fd, buf, 0, buf.length, lastReadOffset);
        fs2.closeSync(fd);
        lastReadOffset = stat.size;
        const newContent = buf.toString("utf8");
        const lines = newContent.split("\n");
        let newCount = 0;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj._hb) continue;
            const interaction = classifiedToInteraction(obj);
            if (interaction) {
              allInteractions.push(interaction);
              newCount++;
            }
          } catch {
          }
        }
        if (newCount > 0) {
          needsRedraw = true;
          render();
        }
      } catch {
        try {
          lastReadOffset = 0;
          allInteractions = readClassifiedTagFile(tagPath);
          lastReadOffset = fs2.statSync(tagPath).size;
          needsRedraw = true;
          render();
        } catch {
        }
      }
    });
  };
  const fileWaitStart = Date.now();
  while (!fs2.existsSync(tagPath) && Date.now() - fileWaitStart < 5e3) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (fs2.existsSync(tagPath)) {
    startWatching();
  } else {
    console.error("\u274C Log parser did not create tag file within 5s. Is wtft-daemon installed?");
    console.error(`   Expected: ${tagPath}`);
    process.exit(1);
  }
  setTimeout(() => {
    updateDaemonHealth();
    needsRedraw = true;
    render();
  }, 1e4);
  const minuteInterval = setInterval(() => {
    const _curMin = (/* @__PURE__ */ new Date()).getMinutes();
    if (_curMin !== _lastRenderMin) {
      updateDaemonHealth();
      needsRedraw = true;
      render();
    }
  }, 6e4);
  await new Promise(() => {
  });
}

// bin/wtft.ts
import { execSync as execSync3, spawn as spawn2 } from "node:child_process";

// extensions/lib/config.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";
import * as os2 from "node:os";
function getConfigPaths(toolName) {
  const globalDir = path3.join(os2.homedir(), ".config", "princess-pi");
  const localDir = path3.join(process.cwd(), ".princess-pi");
  return {
    global: path3.join(globalDir, `${toolName}.json`),
    local: path3.join(localDir, `${toolName}.json`)
  };
}
function readConfig(toolName) {
  const paths = getConfigPaths(toolName);
  const merged = {};
  try {
    const globalRaw = fs3.readFileSync(paths.global, "utf8");
    const globalData = JSON.parse(globalRaw);
    if (globalData && typeof globalData === "object" && !Array.isArray(globalData)) {
      Object.assign(merged, globalData);
    }
  } catch {
  }
  try {
    const localRaw = fs3.readFileSync(paths.local, "utf8");
    const localData = JSON.parse(localRaw);
    if (localData && typeof localData === "object" && !Array.isArray(localData)) {
      Object.assign(merged, localData);
    }
  } catch {
  }
  return merged;
}

// extensions/lib/session-selector.ts
import * as fs4 from "node:fs";
import * as path5 from "node:path";
import * as os4 from "node:os";

// extensions/lib/session-path-shortener.ts
import * as path4 from "node:path";
import * as os3 from "node:os";
function buildDisplayPath(filename, dirSlug, harness) {
  const uuidMatch = filename.match(/([a-f0-9]{4})\.jsonl$/i);
  const uuidTail = uuidMatch ? uuidMatch[1] : "";
  const slug = harness === "pi" ? dirSlug.replace(/^--/, "").replace(/--$/, "") : dirSlug.replace(/^-/, "");
  const homeDir = os3.homedir();
  const userName = path4.basename(homeDir);
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
  const piSessionsDir = path5.join(os4.homedir(), ".pi", "agent", "sessions");
  let claudeSessionsDirs = [];
  const claudeProjectsDir = path5.join(os4.homedir(), ".claude", "projects");
  if (fs4.existsSync(claudeProjectsDir)) {
    const resolvedCwd = cwdOverride2 ? path5.resolve(cwdOverride2) : process.cwd();
    const cwdSlug = resolvedCwd.replace(/[/\\]/g, "-");
    const sessionsSubdir = path5.join(claudeProjectsDir, cwdSlug, "sessions");
    const directDir = path5.join(claudeProjectsDir, cwdSlug);
    if (fs4.existsSync(sessionsSubdir)) claudeSessionsDirs.push(sessionsSubdir);
    if (fs4.existsSync(directDir)) claudeSessionsDirs.push(directDir);
  }
  const candidates = [];
  const walk = (dir, type) => {
    const files = fs4.readdirSync(dir);
    for (const f of files) {
      const fullPath = path5.join(dir, f);
      const stat = fs4.statSync(fullPath);
      if (stat.isDirectory()) {
        if (f !== "subagents" && f !== "tool-results" && f !== "memory" && f !== "wtft-tags") {
          walk(fullPath, type);
        }
      } else if (f.endsWith(".jsonl")) {
        let slug;
        if (type === "pi") {
          slug = path5.basename(dir);
        } else {
          const base = path5.basename(dir);
          slug = base === "sessions" ? path5.basename(path5.dirname(dir)) : base;
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
  const piCwdSlug = cwdOverride2 ? path5.resolve(cwdOverride2).replace(/[/\\]/g, "-") : null;
  try {
    if (harness === "auto" || harness === "pi") {
      if (fs4.existsSync(piSessionsDir)) {
        if (piCwdSlug) {
          const entries = fs4.readdirSync(piSessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.includes(piCwdSlug)) {
              walk(path5.join(piSessionsDir, entry.name), "pi");
            }
          }
        } else {
          walk(piSessionsDir, "pi");
        }
      }
    }
    if (harness === "auto" || harness === "claude-code") {
      for (const dir of claudeSessionsDirs) {
        if (fs4.existsSync(dir)) walk(dir, "claude-code");
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
    const content = fs4.readFileSync(filePath, "utf8");
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
        `\x1B[90mRun 'wtft -s <substring>' to target a specific session by path or basename filter.\x1B[0m
`
      );
      resolve2(candidates[0].path);
      return;
    }
    let selectedIndex = 0;
    const limit2 = 10;
    const displayCandidates = candidates.slice(0, limit2);
    const statsList = displayCandidates.map((c) => getSessionSummary(c.path));
    hideCursor();
    const maxPathLen = Math.max(
      ...displayCandidates.map((c) => c.displayPath.length),
      10
    );
    let lastLineCount = 0;
    let logicalLineCount = 0;
    const render = () => {
      const selected = displayCandidates[selectedIndex];
      let out = `\x1B[1m\x1B[36m\u{1F4B8} WTFT \u2014 select session log\x1B[0m (j/k or arrows navigate, Enter select, q quit):
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
      logicalLineCount = out.replace(/\\n$/, "").split("\\n").length;
      process.stdout.write(out);
    };
    render();
    const onKey = (key) => {
      if (key === "" || key === "q" || key === "Q") {
        clearPreviousLines(lastLineCount);
        cleanup();
        process.exit(130);
      } else if (key === "\r" || key === "\n") {
        clearPreviousLines(lastLineCount);
        const selectedPath = displayCandidates[selectedIndex].path;
        cleanup();
        resolve2(selectedPath);
      } else if (key === "\x1B[A" || key === "k") {
        selectedIndex = (selectedIndex - 1 + displayCandidates.length) % displayCandidates.length;
        clearPreviousLines(lastLineCount);
        render();
      } else if (key === "\x1B[B" || key === "j") {
        selectedIndex = (selectedIndex + 1) % displayCandidates.length;
        clearPreviousLines(lastLineCount);
        render();
      }
    };
    const cleanupStdin = enterRawStdin(onKey);
    const cleanup = () => {
      cleanupStdin();
      showCursor();
    };
  });
}

// bin/wtft.ts
var intervalStr = "1h";
var limit = 100;
var mode = "cumulative";
var showTicks = true;
var targetSessionPath = void 0;
var timezone = void 0;
var harnessOption = "auto";
var cwdOverride = void 0;
var showOther = false;
var showTokens = false;
var pad = 1;
var hasPad = false;
function printWhy() {
  try {
    const manifestPath = path6.join(path6.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
    const manifest = JSON.parse(fs5.readFileSync(manifestPath, "utf8"));
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
  -s, --session <path|filter>  Explicit session .jsonl path, or fuzzy substring filter (e.g. 'b04c'). Skips selector on single match.
  --dir, --cwd <path>     Working directory for Claude Code session discovery (default: current directory).
  --harness <type>        Target a specific harness for auto-discovery (pi, claude-code, or auto). Default: auto.
  -i, --interval <val>    Group cost data into binned intervals (e.g., 1m, 7m, 4h, 1d, 2w; default: 1h).
  -l, --limit <number>    Limit the number of interval bars displayed (default: 100).
  -c, --cumulative        Render running cumulative sums (default behavior).
  -b, --bucket            Render discrete binned interval cost buckets.
  --ticks                 Enable the proportional cost scale ticks above the bars (default behavior).
  --no-ticks              Disable the proportional cost scale ticks above the bars.
  -t, --tz <zone>         Specify a display timezone (e.g. America/Los_Angeles).
  -o, --other             Print a histogram of 'Other' commands grouped by semantic sub-category (Build, Lint, System, etc.).
  -T, --tokens            Print a per-model token summary table (deduped) for cross-referencing with /usage.
  -W, --watch             Watch a session file for changes and re-render the bar chart in real-time.
  --pad <N>               Pad output with N spaces on each side (default: 1, max: floor(term/2)-1).
                          Makes CLI output width match Pi TUI widget in the same terminal.
  --debug                 Print diagnostic cost totals (tag file vs direct parse + dedup).

Log parser management:
  --list                  List all running log parsers with session path, PID, parser version, and idle time.
  --cleanup               Kill log parsers whose source session no longer exists.
  --restart               Kill all running log parsers (fresh spawn on next wtft).
  --stop <session>        Stop log parser for a specific session path.

  --version               Display this tool's version.
  --why                   Explain why you'd run this tool, with user scenarios and anti-use-cases.
  -h, --help              Display this help menu.
`);
}
var hasInterval = false;
var hasLimit = false;
var hasCumulative = false;
var hasBucket = false;
var hasNoTicks = false;
var hasTicks = false;
var hasTz = false;
var hasOther = false;
var hasTokens = false;
var showWatch = false;
var daemonList = false;
var daemonCleanup = false;
var daemonRestart = false;
var daemonStop;
var debugMode = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  } else if (arg === "--why") {
    printWhy();
    process.exit(0);
  } else if (arg === "--version") {
    const manifestPath = path6.join(path6.dirname(fileURLToPath(import.meta.url)), "..", "docs", "manifests", "wtft-cmd.json");
    const manifest = JSON.parse(fs5.readFileSync(manifestPath, "utf8"));
    console.log(`${manifest.name} ${manifest.version}`);
    process.exit(0);
  } else if (arg === "--list") {
    daemonList = true;
  } else if (arg === "--cleanup") {
    daemonCleanup = true;
  } else if (arg === "--restart") {
    daemonRestart = true;
  } else if (arg === "--stop") {
    daemonStop = process.argv[++i];
  } else if (arg === "-s" || arg === "--session") {
    targetSessionPath = process.argv[++i];
  } else if (arg === "-i" || arg === "--interval") {
    intervalStr = process.argv[++i];
    hasInterval = true;
  } else if (arg === "-l" || arg === "--limit") {
    limit = parseInt(process.argv[++i], 10);
    hasLimit = true;
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
  } else if (arg === "--pad") {
    const val = parseInt(process.argv[++i], 10);
    if (!isNaN(val) && val >= 0) {
      pad = val;
      hasPad = true;
    }
  } else if (arg === "--debug") {
    debugMode = true;
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
  if (daemonList || daemonCleanup || daemonRestart || daemonStop) {
    const daemonPath2 = path6.join(path6.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
    const daemonArgs = [daemonPath2];
    if (daemonList) daemonArgs.push("--list");
    if (daemonCleanup) daemonArgs.push("--cleanup");
    if (daemonRestart) daemonArgs.push("--restart");
    if (daemonStop) daemonArgs.push("--stop", daemonStop);
    try {
      const result = execSync3(`${process.execPath} ${daemonArgs.join(" ")}`, {
        encoding: "utf8",
        timeout: 1e4
      });
      if (result) console.log(result.trim());
    } catch (err) {
      if (err.stdout) console.log(err.stdout.trim());
      if (err.stderr) console.error(err.stderr.trim());
    }
    return;
  }
  const candidates = discoverSessions(harnessOption, cwdOverride);
  let finalSessionPath = "";
  if (targetSessionPath) {
    if (fs5.existsSync(targetSessionPath)) {
      finalSessionPath = targetSessionPath;
    } else {
      const filter = targetSessionPath.toLowerCase();
      const filtered = candidates.filter(
        (c) => c.path.toLowerCase().includes(filter) || c.name.toLowerCase().includes(filter)
      );
      if (filtered.length === 0) {
        console.error(`\u274C Error: Session '${targetSessionPath}' does not exist as a file and matches no discovered sessions (${candidates.length} available).`);
        process.exit(1);
      } else if (filtered.length === 1) {
        finalSessionPath = filtered[0].path;
      } else {
        finalSessionPath = await selectSessionPrompt(filtered);
      }
    }
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
  if (!finalSessionPath || !fs5.existsSync(finalSessionPath)) {
    console.error("\u274C Error: Selected session log file path is invalid or does not exist.");
    process.exit(1);
  }
  if (showWatch) {
    const sessionDir2 = path6.dirname(finalSessionPath);
    const sessionBase2 = path6.basename(finalSessionPath);
    const tagsDir2 = path6.join(sessionDir2, "wtft-tags");
    const tagPath2 = path6.join(tagsDir2, sessionBase2 + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
    const daemonPath2 = path6.join(path6.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
    try {
      const child = spawn2(process.execPath, [daemonPath2, "--session", finalSessionPath], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    } catch (err) {
      console.error(`\x1B[33m\u26A0 Log parser spawn failed, falling back to polling mode: ${err}\x1B[0m`);
      await watchMode(finalSessionPath, {
        interval: hasInterval ? intervalStr : "1h",
        limit: hasLimit ? limit : 100,
        mode: hasCumulative || hasBucket ? mode : "cumulative",
        showTicks: hasTicks || hasNoTicks ? showTicks : true,
        timezone: hasTz ? timezone : void 0,
        pad,
        hasInterval,
        hasLimit,
        hasMode: hasCumulative || hasBucket,
        hasTicks: hasTicks || hasNoTicks,
        hasTimezone: hasTz
      });
      return;
    }
    await new Promise((resolve2) => setTimeout(resolve2, 500));
    await watchTagFile(finalSessionPath, tagPath2, {
      interval: hasInterval ? intervalStr : "1h",
      limit: hasLimit ? limit : 100,
      mode: hasCumulative || hasBucket ? mode : "cumulative",
      showTicks: hasTicks || hasNoTicks ? showTicks : true,
      timezone: hasTz ? timezone : void 0,
      daemonPath: daemonPath2,
      pad,
      hasInterval,
      hasLimit,
      hasMode: hasCumulative || hasBucket,
      hasTicks: hasTicks || hasNoTicks,
      hasTimezone: hasTz
    });
    return;
  }
  const sessionDir = path6.dirname(finalSessionPath);
  const sessionBase = path6.basename(finalSessionPath);
  const tagsDir = path6.join(sessionDir, "wtft-tags");
  const tagPath = path6.join(tagsDir, sessionBase + `.wtft-tag.v${WTFT_TAGGER_VERSION}.jsonl`);
  const daemonPath = path6.join(path6.dirname(fileURLToPath(import.meta.url)), "wtft-daemon.mjs");
  try {
    const child = spawn2(process.execPath, [daemonPath, "--session", finalSessionPath], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch (err) {
    console.error(`\x1B[33m\u26A0 Log parser spawn failed, falling back to direct parse: ${err}\x1B[0m`);
  }
  const waitStart = Date.now();
  let tagInteractions = [];
  while (Date.now() - waitStart < 3e4) {
    if (fs5.existsSync(tagPath)) {
      tagInteractions = readClassifiedTagFile(tagPath);
      if (tagInteractions.length > 0) {
        const directInteractions = deduplicateInteractions(parseSessionFile(finalSessionPath));
        if (tagInteractions.length >= directInteractions.length) break;
      }
    }
    await new Promise((r) => setTimeout(r, 667));
  }
  const interactions = tagInteractions.length > 0 ? tagInteractions : [];
  if (interactions.length === 0) {
    interactions.push(...parseSessionFile(finalSessionPath));
  }
  const config = readConfig("wtft");
  const disabledEmoji = typeof config.disabledEmoji === "boolean" ? config.disabledEmoji : false;
  const sessionInterval = typeof config.interval === "string" ? config.interval : void 0;
  const sessionLimit = typeof config.limit === "number" ? config.limit : void 0;
  const sessionMode = config.mode === "cumulative" || config.mode === "bucket" ? config.mode : void 0;
  const sessionShowTicks = typeof config.showTicks === "boolean" ? config.showTicks : void 0;
  const sessionTimezone = typeof config.timezone === "string" ? config.timezone : void 0;
  const termColumns = getTerminalWidth();
  if (!hasPad) pad = 1;
  const maxPad = Math.max(0, Math.floor(termColumns / 2) - 1);
  pad = Math.min(pad, maxPad);
  const padStr = " ".repeat(pad);
  const paddedWidth = termColumns - 2 * pad;
  const finalInterval = hasInterval ? intervalStr : sessionInterval ?? "1h";
  const finalLimit = hasLimit ? limit : sessionLimit ?? 100;
  const finalMode = hasCumulative || hasBucket ? mode : sessionMode ?? "cumulative";
  const finalShowTicks = hasTicks || hasNoTicks ? showTicks : sessionShowTicks ?? true;
  const finalTimezone = hasTz ? timezone : sessionTimezone;
  const defaultSettings = {
    interval: "1h",
    limit: 100,
    width: Math.min(paddedWidth, 1023),
    showTicks: true,
    mode: "cumulative",
    timezone: void 0
  };
  const outputLines = buildWtftLines(interactions, defaultSettings, {
    interval: finalInterval,
    limit: finalLimit,
    width: Math.min(paddedWidth, 1023),
    showTicks: finalShowTicks,
    mode: finalMode,
    timezone: finalTimezone,
    disabledEmoji
  });
  if (!outputLines) {
    console.log(padStr + "No binned data found in session logs.");
    process.exit(0);
  }
  console.log(padStr + `\x1B[90m${finalSessionPath}\x1B[0m`);
  for (const line of outputLines) {
    console.log(padStr + line);
  }
  if (debugMode) {
    const tagCost = interactions.reduce((sum, i) => sum + (i.cost || 0), 0);
    const rawInteractions = parseSessionFile(finalSessionPath);
    const directCost = deduplicateInteractions(rawInteractions).reduce((sum, i) => sum + i.cost, 0);
    console.log(padStr + `\x1B[90m\u2500\u2500 debug \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\x1B[0m`);
    console.log(padStr + `\x1B[90m  tag file (daemon): $${tagCost.toFixed(4)}  (${interactions.length} entries)\x1B[0m`);
    console.log(padStr + `\x1B[90m  direct parse+dedup: $${directCost.toFixed(4)}  (${deduplicateInteractions(rawInteractions).length} entries)\x1B[0m`);
    console.log(padStr + `\x1B[90m  raw parse (no dedup): $${rawInteractions.reduce((sum, i) => sum + i.cost, 0).toFixed(4)}  (${rawInteractions.length} entries)\x1B[0m`);
  }
  if (showOther) {
    console.log("");
    const dedupedInteractions = deduplicateInteractions(interactions);
    const otherOutput = renderOtherHistogram(dedupedInteractions, Math.min(paddedWidth, 1023));
    for (const line of otherOutput.split("\n")) {
      console.log(padStr + line);
    }
  }
  if (showTokens) {
    const tokenOutput = renderTokenSummary(interactions, Math.min(paddedWidth, 1023));
    for (const line of tokenOutput.split("\n")) {
      console.log(padStr + line);
    }
  }
}
main().catch((err) => {
  console.error(`\u274C System Error: ${err.message}`);
  process.exit(1);
});

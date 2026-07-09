#!/usr/bin/env node

// bin/wtft-daemon.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
    const hasTokens = (usage.input_tokens || usage.input || 0) > 0 || (usage.output_tokens || usage.output || 0) > 0 || (usage.cache_read_input_tokens || usage.cacheRead || 0) > 0 || (usage.cache_creation_input_tokens || usage.cacheWrite || 0) > 0 || (usage.reasoning_tokens || usage.reasoning || 0) > 0;
    if (piCost !== void 0 && piCost !== null && !(piCost === 0 && hasTokens)) {
      cost = piCost;
    } else if (assistantMsg.model && hasTokens) {
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
      model: assistantMsg.model || void 0,
      inputTokens: usage.input_tokens ?? usage.input ?? 0,
      outputTokens: usage.output_tokens ?? usage.output ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
      reasoningTokens: usage.reasoning_tokens ?? usage.reasoning ?? 0,
      files,
      commands,
      texts
    };
  }
  return null;
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
      if (lower === "git" || lower.startsWith("git ")) isGit = true;
      else if (lower === "grep" || lower.startsWith("grep ") || lower === "rg" || lower.startsWith("rg ") || lower === "ripgrep" || lower.startsWith("ripgrep ") || lower === "find" || lower.startsWith("find ")) isGrep = true;
    }
    if (isGit) return "git";
    if (isGrep) return "grep";
    return "other";
  }
  if (interaction.texts.length > 0) return "prompt";
  return "other";
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
        timestamp: best.timestamp,
        cost: best.cost,
        messageId: best.messageId,
        files: [],
        commands: [],
        texts: []
      };
      const seenFiles = /* @__PURE__ */ new Set();
      for (const i of group) {
        for (const f of i.files) {
          const key = f.path + ":" + f.action;
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
var TAGGER_VERSION = "2.3.4";
var TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
var POLL_MS = 667;
var IDLE_EXIT_MS = 24 * 60 * 60 * 1e3;
function serializeClassified(interaction) {
  const cost = Number(interaction.cost.toFixed(6));
  const line = {
    t: interaction.timestamp,
    c: cost,
    cat: classifyInteraction(interaction),
    f: interaction.files.map((f) => ({ p: f.path, a: f.action })),
    cmd: interaction.commands
  };
  if (interaction.messageId) line.id = interaction.messageId;
  if (interaction.model) line.m = interaction.model;
  if (interaction.inputTokens > 0) line.in = interaction.inputTokens;
  if (interaction.outputTokens > 0) line.out = interaction.outputTokens;
  if (interaction.cacheReadTokens > 0) line.cr = interaction.cacheReadTokens;
  if (interaction.cacheWriteTokens > 0) line.cw = interaction.cacheWriteTokens;
  if (interaction.reasoningTokens > 0) line.rs = interaction.reasoningTokens;
  return JSON.stringify(line) + "\n";
}
var sessionPath = null;
var tagPath = null;
var pidPath = null;
var lastSize = 0;
var lastWriteMs = 0;
var lastActivityMs = Date.now();
var startupTime = Date.now();
var pendingLines = [];
var idleStartMs = 0;
var running = true;
function shutdown(reason) {
  if (!running) return;
  running = false;
  flushPending();
  try {
    fs.appendFileSync(tagPath, JSON.stringify({ _hb: "stop" }) + "\n");
  } catch (_) {
  }
  try {
    fs.unlinkSync(pidPath);
  } catch (_) {
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));
function upsertHeartbeat(now) {
  try {
    const hbLine = JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n";
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) {
      fs.appendFileSync(tagPath, hbLine);
      return;
    }
    const fd = fs.openSync(tagPath, "r+");
    const CHUNK = 512;
    let searchOffset = stat.size;
    let tail = "";
    let lastLineStart = -1;
    while (searchOffset > 0 && lastLineStart === -1) {
      const readSize = Math.min(CHUNK, searchOffset);
      searchOffset -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, searchOffset);
      tail = buf.toString("utf8") + tail;
      lastLineStart = tail.lastIndexOf("\n");
    }
    if (lastLineStart === -1) lastLineStart = 0;
    else lastLineStart += 1;
    const lastLine = tail.slice(lastLineStart).trim();
    let isHb = false;
    try {
      const obj = JSON.parse(lastLine);
      isHb = obj._hb !== void 0;
    } catch (_) {
    }
    if (isHb) {
      const newBytes = Buffer.from(hbLine);
      const oldByteLen = Buffer.from(lastLine + "\n").length;
      const writeBuf = Buffer.alloc(Math.max(newBytes.length, oldByteLen), 32);
      newBytes.copy(writeBuf, 0, 0, Math.min(newBytes.length, oldByteLen));
      const offset = searchOffset + lastLineStart;
      fs.writeSync(fd, writeBuf, 0, oldByteLen, offset);
    } else {
      fs.appendFileSync(tagPath, hbLine);
    }
    fs.closeSync(fd);
  } catch (_) {
    try {
      fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n");
    } catch (_2) {
    }
  }
}
function flushPending() {
  if (pendingLines.length === 0) return;
  const batch = pendingLines.join("");
  pendingLines = [];
  try {
    fs.appendFileSync(tagPath, batch);
    idleStartMs = 0;
  } catch (err) {
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] write error: ${err.message}
`);
    }
  }
  lastWriteMs = Date.now();
}
function parseNewLines(filePath) {
  const interactions = [];
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < lastSize) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session truncated, resetting offset
`);
      }
      lastSize = 0;
    }
    if (currentSize <= lastSize) return interactions;
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
        const interaction = parseEntryToInteraction(entry);
        if (interaction) {
          interactions.push(interaction);
        }
      } catch (_) {
      }
    }
  } catch (_) {
  }
  return interactions;
}
function initClassified() {
  let hasData = false;
  try {
    fs.accessSync(tagPath);
    const tagContent = fs.readFileSync(tagPath, "utf8");
    hasData = tagContent.split("\n").some((l) => l.trim() && !l.includes('"_hb"'));
    if (hasData) {
      try {
        const stat = fs.statSync(sessionPath);
        lastSize = stat.size;
      } catch (_) {
      }
    } else {
      lastSize = 0;
    }
  } catch (_) {
    lastSize = 0;
  }
  const startNow = Date.now();
  fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  idleStartMs = startNow;
}
function main() {
  let showList = false;
  let showCleanup = false;
  let showRestart = false;
  let stopSession = null;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--session" || arg === "-s") {
      sessionPath = process.argv[++i];
    } else if (arg === "--list" || arg === "-l") {
      showList = true;
    } else if (arg === "--cleanup") {
      showCleanup = true;
    } else if (arg === "--restart") {
      showRestart = true;
    } else if (arg === "--stop") {
      stopSession = process.argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`wtft-daemon \u2014 Session log parser for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running log parsers (session, PID, idle time)
  --cleanup             Kill log parsers whose source session no longer exists
  --restart             Kill all running log parsers (fresh spawn on next wtft)
  --stop <session>      Stop log parser for a specific session path

Log parser mode:
  -s, --session <path>  Path to session.jsonl to watch
  --debug               Enable debug logging to stderr
  -h, --help            Show this help`);
      process.exit(0);
    } else if (arg === "--debug") {
      process.env.WTFT_DAEMON_DEBUG = "1";
    }
  }
  if (showList || showCleanup || showRestart || stopSession) {
    const pidDir = os.tmpdir();
    let pidFiles = [];
    try {
      pidFiles = fs.readdirSync(pidDir).filter((f) => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
    } catch (_) {
    }
    let found = 0;
    for (const pidFile of pidFiles) {
      const fullPath = path.join(pidDir, pidFile);
      let pid = 0;
      try {
        pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
      } catch (_) {
        continue;
      }
      if (pid <= 0) continue;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (_) {
      }
      let sessionFound = null;
      let tagMtime = 0;
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const args = cmdline.split("\0");
        const sessIdx = args.indexOf("--session");
        if (sessIdx >= 0 && sessIdx + 1 < args.length) {
          sessionFound = args[sessIdx + 1];
        }
      } catch (_) {
      }
      let taggerVersion = "?";
      if (sessionFound) {
        try {
          const tagsDir2 = path.join(path.dirname(sessionFound), "wtft-tags");
          const sessBase = path.basename(sessionFound);
          const prefix = sessBase + ".wtft-tag.v";
          for (const f of fs.readdirSync(tagsDir2)) {
            if (f.startsWith(prefix)) {
              tagMtime = fs.statSync(path.join(tagsDir2, f)).mtimeMs;
              taggerVersion = f.slice(prefix.length, f.length - 6);
              break;
            }
          }
        } catch (_) {
        }
      }
      if (showRestart) {
        if (alive) {
          process.kill(pid, "SIGTERM");
        }
        try {
          fs.unlinkSync(fullPath);
        } catch (_) {
        }
        if (sessionFound) {
          try {
            const child = spawn(process.execPath, [process.argv[1], "--session", sessionFound], {
              detached: true,
              stdio: "ignore"
            });
            child.unref();
          } catch (_2) {
          }
        }
        console.log(`Restarted: PID ${pid} \u2192 fresh log parser for ${sessionFound || "(unknown)"}`);
        found++;
        continue;
      }
      if (showCleanup) {
        if (!alive) {
          try {
            fs.unlinkSync(fullPath);
          } catch (_) {
          }
          continue;
        }
        if (sessionFound && !fs.existsSync(sessionFound)) {
          process.kill(pid, "SIGTERM");
          try {
            fs.unlinkSync(fullPath);
          } catch (_) {
          }
          console.log(`Cleaned up: PID ${pid} \u2014 session gone: ${sessionFound}`);
          found++;
          continue;
        }
      }
      if (stopSession && sessionFound === stopSession) {
        if (alive) {
          process.kill(pid, "SIGTERM");
        }
        try {
          fs.unlinkSync(fullPath);
        } catch (_) {
        }
        console.log(`Stopped: PID ${pid} \u2014 ${sessionFound}`);
        found++;
        continue;
      }
      if (showList) {
        found++;
        const status = alive ? "RUNNING" : "DEAD (stale pid)";
        let idleStr = "?";
        if (tagMtime > 0) {
          const idleSec = Math.floor((Date.now() - tagMtime) / 1e3);
          if (idleSec < 60) idleStr = `${idleSec}s`;
          else if (idleSec < 3600) idleStr = `${Math.floor(idleSec / 60)}m`;
          else idleStr = `${Math.floor(idleSec / 3600)}h`;
        }
        const sessionDisplay = sessionFound || `(hash: ${pidFile.replace(/^wtft-daemon-/, "").replace(/\.pid$/, "")})`;
        console.log(`PID ${String(pid).padEnd(7)} ${status.padEnd(20)} v${taggerVersion.padEnd(7)} idle: ${idleStr.padEnd(5)} ${sessionDisplay}`);
      }
    }
    if (showRestart) {
      console.log(`Restarted ${found} log parser(s). Run wtft to spawn fresh instances.`);
    }
    if (showCleanup) {
      console.log(`Cleaned up ${found} log parser(s).`);
    }
    if (showList && found === 0) {
      console.log("No log parser processes found.");
    }
    if (stopSession && found === 0) {
      console.log(`No log parser found for: ${stopSession}`);
    }
    process.exit(0);
  }
  if (!sessionPath) {
    process.stderr.write("wtft-daemon: --session <path> is required\n");
    process.exit(1);
  }
  if (!fs.existsSync(sessionPath)) {
    process.stderr.write(`wtft-daemon: session file not found: ${sessionPath}
`);
    process.exit(1);
  }
  if (sessionPath.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag cache file: ${sessionPath}
`);
    process.exit(1);
  }
  const sessionDir = path.dirname(sessionPath);
  const sessionBase = path.basename(sessionPath);
  const tagsDir = path.join(sessionDir, "wtft-tags");
  try {
    fs.mkdirSync(tagsDir, { recursive: true });
  } catch (_) {
  }
  tagPath = path.join(tagsDir, sessionBase + TAG_SUFFIX);
  try {
    const prefix = sessionBase + ".wtft-tag.v";
    for (const f of fs.readdirSync(tagsDir)) {
      if (f.startsWith(prefix) && f !== sessionBase + TAG_SUFFIX) {
        const stale = path.join(tagsDir, f);
        try {
          fs.unlinkSync(stale);
        } catch (_) {
        }
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] removed stale tag file: ${f}
`);
        }
      }
    }
  } catch (_) {
  }
  const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);
  const pidPayload = `${process.pid} ${TAGGER_VERSION}`;
  let fd;
  try {
    fd = fs.openSync(pidPath, "wx");
    fs.writeSync(fd, pidPayload);
    fs.closeSync(fd);
  } catch (_) {
    try {
      const existing = fs.readFileSync(pidPath, "utf8").trim().split(/\s+/);
      const existingPid = parseInt(existing[0], 10);
      const existingVer = existing[1] || "";
      if (existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          if (existingVer !== TAGGER_VERSION) {
            if (process.env.WTFT_DAEMON_DEBUG) {
              process.stderr.write(`[wtft-log-parser] replacing v${existingVer} daemon (pid ${existingPid}) with v${TAGGER_VERSION}
`);
            }
            try {
              process.kill(existingPid, "SIGTERM");
            } catch {
            }
            try {
              fs.unlinkSync(pidPath);
            } catch {
            }
            fd = fs.openSync(pidPath, "wx");
            fs.writeSync(fd, pidPayload);
            fs.closeSync(fd);
          } else {
            process.exit(0);
          }
        } catch (_2) {
          try {
            fs.unlinkSync(pidPath);
          } catch {
          }
          fd = fs.openSync(pidPath, "wx");
          fs.writeSync(fd, pidPayload);
          fs.closeSync(fd);
        }
      }
    } catch (_3) {
      try {
        fs.unlinkSync(pidPath);
      } catch (_4) {
      }
      fd = fs.openSync(pidPath, "wx");
      fs.writeSync(fd, pidPayload);
      fs.closeSync(fd);
    }
  }
  initClassified();
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] started, watching: ${sessionPath}
`);
    process.stderr.write(`[wtft-log-parser] classified: ${tagPath}
`);
    process.stderr.write(`[wtft-log-parser] pid: ${process.pid}
`);
  }
  const loop = () => {
    if (!running) return;
    try {
      const rawInteractions = parseNewLines(sessionPath);
      const newInteractions = deduplicateInteractions(rawInteractions);
      if (newInteractions.length > 0) {
        lastActivityMs = Date.now();
        for (const interaction of newInteractions) {
          pendingLines.push(serializeClassified(interaction));
        }
      }
      const now = Date.now();
      if (pendingLines.length > 0 && now - lastWriteMs >= POLL_MS) {
        flushPending();
      }
      if (pendingLines.length === 0) {
        if (idleStartMs === 0) idleStartMs = now;
        upsertHeartbeat(now);
        lastWriteMs = now;
      }
      if (now - lastActivityMs >= IDLE_EXIT_MS && now - startupTime >= 6e4) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - lastActivityMs) / 6e4)}m, exiting
`);
        }
        shutdown("idle timeout");
        return;
      }
      if (!fs.existsSync(sessionPath)) {
        shutdown("session removed");
        return;
      }
    } catch (err) {
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] poll error: ${err.message}
`);
      }
    }
    setTimeout(loop, POLL_MS);
  };
  loop();
}
main();

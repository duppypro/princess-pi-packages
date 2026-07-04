#!/usr/bin/env node

// bin/wtft-daemon.mjs — Classifier daemon: session.jsonl → classified.jsonl
// Pure Unix pipe: one input file, one output file. No network.
// Throttled writes at 90bpm (667ms). Heartbeat protocol.
// Auto-spawned by wtft CLI; runs detached.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

// ---
// SHARED CLASSIFIER FUNCTIONS (inlined from extensions/lib/wtft-shared.ts)
// Single source of truth for classification logic.
// ---

function getDeepSeekPeakMultiplier(timestamp) {
  const ts = timestamp || Date.now();
  const d = new Date(ts);
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const utcTime = utcHour * 60 + utcMin;
  if ((utcTime >= 60 && utcTime < 240) || (utcTime >= 360 && utcTime < 600)) {
    return 2.0;
  }
  return 1.0;
}

function calculateClaudeCost(model, usage, timestamp) {
  if (!usage) return 0;
  let inputPrice = 3.0;
  let outputPrice = 15.0;
  let cacheWritePrice = 3.75;
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
    cacheWritePrice = 0;
    cacheReadPrice = 0;
  } else if (m.includes("haiku")) {
    inputPrice = 0.8;
    outputPrice = 4.0;
    cacheWritePrice = 1.0;
    cacheReadPrice = 0.08;
  } else if (m.includes("opus")) {
    inputPrice = 15.0;
    outputPrice = 75.0;
    cacheWritePrice = 18.75;
    cacheReadPrice = 1.5;
  }
  const cost =
    (usage.input_tokens || 0) * (inputPrice / 1e6) +
    (usage.output_tokens || 0) * (outputPrice / 1e6) +
    (usage.cache_creation_input_tokens || 0) * (cacheWritePrice / 1e6) +
    (usage.cache_read_input_tokens || 0) * (cacheReadPrice / 1e6);
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
    const hasTokens = (usage.input_tokens || usage.input || 0) > 0 ||
                      (usage.output_tokens || usage.output || 0) > 0;
    if (piCost !== undefined && piCost !== null && !(piCost === 0 && hasTokens)) {
      cost = piCost;
    } else if (assistantMsg.model && hasTokens) {
      const normalizedUsage = {
        input_tokens: usage.input_tokens ?? usage.input ?? 0,
        output_tokens: usage.output_tokens ?? usage.output ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
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
    return { timestamp, cost, files, commands, texts };
  }
  return null;
}

function classifyInteraction(interaction) {
  const specPaths = new Set();
  const codePaths = new Set();
  const testsPaths = new Set();
  const researchPaths = new Set();
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

// ---
// CLASSIFIED FORMAT WRITER
// ---

const CLASSIFIER_VERSION = 1;
const POLL_MS = 667;              // 90bpm throttle
const IDLE_EXIT_MS = 30 * 60 * 1000; // exit if session.jsonl unchanged for 30 min
// Consumer crash detection: file unmodified for >2s with no _hb:"stop" = crash.

function serializeClassified(interaction) {
  const line = {
    t: interaction.timestamp,
    c: interaction.cost,
    cat: classifyInteraction(interaction),
    f: interaction.files.map(f => ({ p: f.path, a: f.action })),
    cmd: interaction.commands,
  };
  return JSON.stringify(line) + "\n";
}

// ---
// DAEMON STATE
// ---

let sessionPath = null;
let classifiedPath = null;
let pidPath = null;
let lastSize = 0;            // bytes read from session.jsonl
let lastWriteMs = 0;         // last time we flushed to classified.jsonl
let lastActivityMs = Date.now(); // last time we classified a new interaction
let pendingLines = [];       // classified lines waiting for next flush
let idleStartMs = 0;         // start of current idle period (for _hb range)
let running = true;

// ---
// SIGNAL HANDLING
// ---

function shutdown(reason) {
  if (!running) return;
  running = false;
  // Flush any pending lines
  flushPending();
  // Write stop heartbeat
  try {
    fs.appendFileSync(classifiedPath, JSON.stringify({ _hb: "stop" }) + "\n");
  } catch (_) {}
  // Remove PID file
  try { fs.unlinkSync(pidPath); } catch (_) {}
  // Daemon goes silent but exits cleanly
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

// ---
// FILE I/O HELPERS
// ---

/**
 * Overwrite the last line of classified.jsonl if it's a heartbeat.
 * Updates the _hb range's `last` timestamp in place.
 * Always uses {"_hb":{"first":<ts>,"last":<ts>}} format for fixed width
 * so overwrites never change byte length. If the last line isn't a heartbeat
 * (new data arrived), appends a new heartbeat line.
 *
 * Scans backwards from EOF for the last newline to handle arbitrarily long
 * preceding lines (classified data lines can be large with `cmd` arrays).
 */
function upsertHeartbeat(now) {
  try {
    const hbLine = JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n";
    const stat = fs.statSync(classifiedPath);
    if (stat.size === 0) {
      fs.appendFileSync(classifiedPath, hbLine);
      return;
    }

    // Scan backwards from EOF in chunks to find the last complete line.
    // A classified data line can be large (e.g. long `cmd` array), so a
    // fixed-size read window would land mid-line.
    const fd = fs.openSync(classifiedPath, "r+");
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
      isHb = obj._hb !== undefined;
    } catch (_) {}

    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] upsertHeartbeat: isHb=${isHb} lastLine=${lastLine.slice(0,60)}... fileSize=${stat.size}\n`);
    }

    if (isHb) {
      // Overwrite in place — same format guarantees same length
      const newBytes = Buffer.from(hbLine);
      const oldByteLen = Buffer.from(lastLine + "\n").length;
      const writeBuf = Buffer.alloc(Math.max(newBytes.length, oldByteLen), 0x20);
      newBytes.copy(writeBuf, 0, 0, Math.min(newBytes.length, oldByteLen));
      // offset = file start + (position of lastLineStart within the tail buffer)
      // tail covers bytes [searchOffset, EOF), so lastLineStart is relative to searchOffset
      const offset = searchOffset + lastLineStart;
      fs.writeSync(fd, writeBuf, 0, oldByteLen, offset);
    } else {
      // Last line is data — append new heartbeat
      fs.appendFileSync(classifiedPath, hbLine);
    }
    fs.closeSync(fd);
  } catch (err) {
    // Fallback: append if we can't seek/overwrite
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] upsertHeartbeat fallback: ${err.message}\n`);
    }
    try {
      fs.appendFileSync(classifiedPath, JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n");
    } catch (_2) {}
  }
}

function flushPending() {
  if (pendingLines.length === 0) return;
  const batch = pendingLines.join("");
  pendingLines = [];
  try {
    fs.appendFileSync(classifiedPath, batch);
    idleStartMs = 0; // Data arrived — idle period ended
  } catch (err) {
    // If we can't write, log and continue — don't crash the daemon
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] write error: ${err.message}\n`);
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
      // File truncated or rotated — reset
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-daemon] session truncated, resetting offset\n`);
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
        // Skip unparseable lines (partial writes, non-JSON)
      }
    }
  } catch (_) {
    // File may not exist yet
  }
  return interactions;
}

// ---
// INITIALIZATION
// ---

function initClassified() {
  // Read existing classified.jsonl to check version
  let existingVersion = null;
  let lineCount = 0;
  try {
    const content = fs.readFileSync(classifiedPath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._cv !== undefined) {
          existingVersion = obj._cv;
        } else if (!obj._hb) {
          lineCount++;
        }
      } catch (_) {}
    }
  } catch (_) {
    // No existing file — fresh start
  }

  if (existingVersion !== CLASSIFIER_VERSION) {
    // Version mismatch — delete and start fresh
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-daemon] classifier version changed (${existingVersion} → ${CLASSIFIER_VERSION}), full reclassify\n`);
    }
    try { fs.unlinkSync(classifiedPath); } catch (_) {}
    // Reset session offset to force full re-parse
    lastSize = 0;
  } else {
    // Version matches — resume incrementally
    // lastSize stays 0 on first run; session is parsed fully but classified.jsonl is appended
    // (will produce duplicates if session hasn't changed but classified.jsonl exists).
    // Instead: set lastSize to session file size so we only pick up new lines.
    try {
      const stat = fs.statSync(sessionPath);
      lastSize = stat.size;
    } catch (_) {}
  }

  // Write version header if new file
  try {
    fs.accessSync(classifiedPath);
  } catch (_) {
    fs.appendFileSync(classifiedPath, JSON.stringify({ _cv: CLASSIFIER_VERSION }) + "\n", { flag: "w" });
  }

  // Write start heartbeat (range format — always includes both first and last)
  const startNow = Date.now();
  fs.appendFileSync(classifiedPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  idleStartMs = startNow;
}

// ---
// MAIN LOOP
// ---

function main() {
  // ---
  // ARG PARSING & MANAGEMENT COMMANDS
  // ---

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
      console.log(`wtft-daemon — Classifier daemon for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running daemons (session, PID, idle time)
  --cleanup             Kill daemons whose source session no longer exists
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Stop daemon for a specific session path

Daemon mode:
  -s, --session <path>  Path to session.jsonl to watch
  --debug               Enable debug logging to stderr
  -h, --help            Show this help`);
      process.exit(0);
    } else if (arg === "--debug") {
      process.env.WTFT_DAEMON_DEBUG = "1";
    }
  }

// --- Management commands (no session required) ---

if (showList || showCleanup || showRestart || stopSession) {
  const pidDir = os.tmpdir();
  let pidFiles = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}

  let found = 0;
  for (const pidFile of pidFiles) {
    const fullPath = path.join(pidDir, pidFile);
    let pid = 0;
    try {
      pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
    } catch (_) { continue; }
    if (pid <= 0) continue;

    // Check if process is alive
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (_) {}

    // Try to find session path from classified file
    let sessionFound = null;
    let classifiedMtime = 0;
    // The PID file name contains a hash — we need to scan for matching classified files
    // Since the hash is derived from session path, we can't reverse it.
    // Instead, check /proc/<pid>/cmdline to find the --session argument.
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    // Get classified file mtime for idle time
    if (sessionFound) {
      const cf = sessionFound + ".classified.jsonl";
      try {
        classifiedMtime = fs.statSync(cf).mtimeMs;
      } catch (_) {}
    }

    if (showRestart) {
      if (alive) {
        process.kill(pid, "SIGTERM");
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      console.log(`Restarted: PID ${pid} — ${sessionFound || "(unknown session)"}`);
      found++;
      continue;
    }

    if (showCleanup) {
      if (!alive) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
        continue;
      }
      if (sessionFound && !fs.existsSync(sessionFound)) {
        process.kill(pid, "SIGTERM");
        try { fs.unlinkSync(fullPath); } catch (_) {}
        console.log(`Cleaned up: PID ${pid} — session gone: ${sessionFound}`);
        found++;
        continue;
      }
    }

    if (stopSession && sessionFound === stopSession) {
      if (alive) {
        process.kill(pid, "SIGTERM");
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      console.log(`Stopped: PID ${pid} — ${sessionFound}`);
      found++;
      continue;
    }

    if (showList) {
      found++;
      const status = alive ? "RUNNING" : "DEAD (stale pid)";
      let idleStr = "?";
      if (classifiedMtime > 0) {
        const idleSec = Math.floor((Date.now() - classifiedMtime) / 1000);
        if (idleSec < 60) idleStr = `${idleSec}s`;
        else if (idleSec < 3600) idleStr = `${Math.floor(idleSec / 60)}m`;
        else idleStr = `${Math.floor(idleSec / 3600)}h`;
      }
      const sessionDisplay = sessionFound || `(hash: ${pidFile.replace(/^wtft-daemon-/, "").replace(/\.pid$/, "")})`;
      console.log(`PID ${String(pid).padEnd(7)} ${status.padEnd(20)} idle: ${idleStr.padEnd(5)} ${sessionDisplay}`);
    }
  }

  if (showRestart) {
    console.log(`Restarted ${found} daemon(s). Run wtft to spawn fresh instances.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${found} daemon(s).`);
  }
  if (showList && found === 0) {
    console.log("No wtft-daemon processes found.");
  }
  if (stopSession && found === 0) {
    console.log(`No daemon found for: ${stopSession}`);
  }
  process.exit(0);
}

// --- Daemon mode (session required) ---

  if (!sessionPath) {
    process.stderr.write("wtft-daemon: --session <path> is required\n");
    process.exit(1);
  }
  if (!fs.existsSync(sessionPath)) {
    process.stderr.write(`wtft-daemon: session file not found: ${sessionPath}\n`);
    process.exit(1);
  }

  // Determine classified.jsonl path (alongside session)
  const sessionDir = path.dirname(sessionPath);
  const sessionBase = path.basename(sessionPath);
  classifiedPath = path.join(sessionDir, sessionBase + ".classified.jsonl");

  // PID file for singleton detection
  const sessionHash = createHash("sha256").update(sessionPath).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);

  // Singleton check — atomic exclusive-create prevents TOCTOU race.
  // If PID file exists, verify the process is alive; clean up stale ones.
  let fd;
  try {
    fd = fs.openSync(pidPath, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (_) {
    // PID file exists — check if the process is still alive
    try {
      const existingPid = parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
      if (existingPid > 0) {
        try {
          process.kill(existingPid, 0);
          // Process exists — another daemon is running, exit quietly
          process.exit(0);
        } catch (_2) {
          // Stale PID — clean up and retry
          fs.unlinkSync(pidPath);
          fd = fs.openSync(pidPath, "wx");
          fs.writeSync(fd, String(process.pid));
          fs.closeSync(fd);
        }
      }
    } catch (_3) {
      // Couldn't read PID — clean up and retry
      try { fs.unlinkSync(pidPath); } catch (_4) {}
      fd = fs.openSync(pidPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    }
  }

  // Initialize classified.jsonl (version check, header, start heartbeat)
  initClassified();

  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-daemon] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-daemon] classified: ${classifiedPath}\n`);
    process.stderr.write(`[wtft-daemon] pid: ${process.pid}\n`);
  }

  // --- Main poll loop ---
  const loop = () => {
    if (!running) return;

    // Read new lines from session
    const newInteractions = parseNewLines(sessionPath);
    if (newInteractions.length > 0) {
      lastActivityMs = Date.now();
      for (const interaction of newInteractions) {
        pendingLines.push(serializeClassified(interaction));
      }
    }

    // Throttled flush: write at most every 667ms
    const now = Date.now();
    if (pendingLines.length > 0 && (now - lastWriteMs) >= POLL_MS) {
      flushPending();
    }

    // Heartbeat: on every poll cycle when idle, update the _hb range line.
    // First idle poll appends {"_hb":{"first":<ts>}}. Subsequent idle polls
    // overwrite the last line in-place with {"_hb":{"first":<ts>,"last":<ts>}}.
    // When data arrives, the idle period ends — next idle starts a new line.
    if (pendingLines.length === 0) {
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
      lastActivityMs = now;
    }

    // Idle exit: if session.jsonl hasn't been modified in >30 min,
    // assume the session is finished and shut down cleanly.
    try {
      const sessionStat = fs.statSync(sessionPath);
      if (now - sessionStat.mtimeMs >= IDLE_EXIT_MS) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-daemon] session idle for ${Math.round((now - sessionStat.mtimeMs)/60000)}m, exiting\n`);
        }
        shutdown("idle timeout");
        return;
      }
    } catch (_) {
      // Session file gone — clean exit
      shutdown("session removed");
      return;
    }

    setTimeout(loop, POLL_MS);
  };

  // Initial full classification if no existing cache
  // parseNewLines handles incremental via lastSize. If this is a fresh start,
  // lastSize is 0 and we'll parse all existing lines.
  loop();
}

main();

#!/usr/bin/env -S node --experimental-strip-types

// bin/wtft-daemon.ts — Tagger daemon: session.jsonl → session.jsonl.wtft-tag.v{N}.jsonl
// Pure Unix pipe: one input file, one output file. No network.
// Throttled writes at 90bpm (667ms). Heartbeat protocol.
// Auto-spawned by wtft CLI; runs detached.
//
// Source file — build.ts (Bun.build) bundles into bin/wtft-daemon.mjs.
// Parsing, classification, and cost calculation live in extensions/lib/wtft-shared.ts
// and are imported here. The daemon owns only: file watching, incremental parsing,
// tag file I/O, heartbeat protocol, singleton PID management, and serialization.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	parseEntryToInteraction,
	parseSessionFile,
	deduplicateInteractions,
	serializeClassified,
	serializeClassifiedWithOverheadSplit,
	applyControlEntry,
	newParseStreamState,
	attributeClaudeSubAgentCosts,
	extractCwdFromBashCommand,
	discoverClaudeSubAgentSessionFiles,
	discoverSubagentSessionFiles,
	loadSubagentInteractions,
	loadUserPricing,
	resolveMovedSession,
	getCurrentVersionTagPath,
	isSessionIdBasename,
	loadExternalHarnesses,
	WTFT_TAGGER_VERSION as TAGGER_VERSION
} from "../extensions/lib/wtft-shared.js";
import type { ParseStreamState } from "../extensions/lib/wtft-shared.js";




// ---
// DAEMON CONFIGURATION
// ---

// Bump when classification heuristics or cost model change (#54, #55, etc).
const TAG_SUFFIX = `.wtft-tag.v${TAGGER_VERSION}.jsonl`;
const POLL_MS = 667;              // 90bpm throttle
const IDLE_EXIT_MS = 24 * 60 * 60 * 1000; // exit if session.jsonl unchanged for 24h (polite to ps aux)
// How long to stay parked on a session .jsonl that has NEVER appeared (#308).
// Claude Code writes the transcript only after the first real prompt completes,
// so "absent at spawn" is the normal launch state, not an orphan — but a session
// that never gets a prompt must not pin a daemon forever. One hour matches
// ZERO_INTERACTIONS_AGE (the reaper's own notion of "zombie"), and a later
// `wtft` run respawns for free. Only the never-seen case uses this ceiling; a
// session seen once and then removed exits on the daemon's own knowledge.
const SESSION_WAIT_MAX_MS = 60 * 60 * 1000;

// ---
// DAEMON STATE
// ---

// Empty string = not yet initialized (set once during startup, before the poll loop).
let sessionPath = "";
let tagPath = "";
let pidPath = "";
let lastSize = 0;            // bytes read from session.jsonl
let lastWriteMs = 0;         // last time we flushed to the tag file
let lastActivityMs = Date.now(); // last time we classified a new interaction
let startupTime = Date.now();    // daemon start time (idle exit grace period)
// {interaction, prevCtx} waiting for next flush (#52 Phase 3: serialized at
// flush so late interrupt markers can still stamp the tail interaction).
let pendingItems: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
let idleStartMs = 0;         // start of current idle period (for _hb range)
// Stream state threaded across incremental reads: thinking level (#77), model
// from model_change (#128), compaction tokensBefore (#90), and the pending
// after-compaction flag (#52 Phase 3). Shared shape with parseSessionFile so
// the incremental and whole-file paths cannot drift (#156).
const streamState = newParseStreamState();
let stampInterruptOnPending = false; // interrupt marker seen; assistant turn is in pendingItems (#52 Phase 3)
let prevCtxTokens = 0; // input+cacheRead+cacheWrite of prev non-sidechain interaction (recache signature)
let running = true;
let sessionExisted = false; // becomes true first time we observe the session file (#129 Bug A)

// Claude bash sub-agent discovery (#138): track interactions that spawn
// `claude -p` so we can periodically check for completed sub-agent sessions
// and write their classified interactions to the tag file.
const pendingClaudeCommands: { interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>; prevCtx: number }[] = [];
const discoveredClaudeSessions = new Set<string>();

// Task/agent sub-agent discovery (#82), incrementally re-parsed (#270): a
// subagent transcript is discovered while it is still running, so parsing it
// only once — at discovery — makes everything it writes afterward invisible
// forever, and the undercount gets persisted into the tag file. Presence in
// this map means "discovered"; each entry carries its OWN byte offset and
// stream state so the file is re-read exactly like the parent session is
// (readNewSubagentLines below) — cheap when unchanged (one stat, no read).
// Bounded by the transcripts that currently exist for this session, not by
// every one ever discovered: scanForSubAgents evicts entries whose file is
// gone. It cannot be bounded tighter — an offset per LIVE file is exactly the
// state an incremental read needs, and forgetting a live one re-reads it from
// zero, which is the overcount. See the eviction comment in scanForSubAgents
// for why "the subagent finished" is not a safe rule.
interface SubagentFileState {
  /** Byte offset already read from this transcript. */
  lastSize: number;
  /** Control-entry state threaded across polls (thinking level, model, compaction). */
  streamState: ParseStreamState;
  /**
   * Last interaction appended to the tag file for this subagent (#270 review).
   * An interrupt marker can arrive in a LATER poll than the turn it killed, and
   * a subagent has no pendingItems queue to re-stamp — so the turn is re-emitted
   * with `ir` set instead. Held by reference so a late attribution or stamp
   * lands on the same object the tag file was written from.
   */
  lastWritten?: NonNullable<ReturnType<typeof parseEntryToInteraction>>;
  /** An interrupt marker arrived in a batch with no interaction of its own. */
  stampInterruptOnLastWritten?: boolean;
}

const discoveredSubagentFiles = new Map<string, SubagentFileState>();

// ---
// SIGNAL HANDLING
// ---

function shutdown(reason: string) {
  if (!running) return;
  running = false;
  // Why the daemon stopped is the diagnostic #155 turns on: "session moved" and
  // "session removed" look identical from outside, and only one is a bug.
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] shutdown: ${reason}\n`);
  }
  // Ownership-aware shutdown (#95): a taken-over daemon must exit silently.
  // Writing anything would recreate the tag file the new owner's version
  // hygiene just deleted, and unlinking would destroy the new owner's lease
  // — that unlocked singleton was the daemon-per-restart leak.
  let ownsLease = false;
  try {
    ownsLease = fs.readFileSync(pidPath, "utf8").trim() === String(process.pid);
  } catch (_) {}
  if (ownsLease) {
    flushPending();
    // Stop heartbeat only if our tag file still exists — never recreate.
    try {
      if (fs.existsSync(tagPath)) {
        fs.appendFileSync(tagPath, JSON.stringify({ _hb: "stop" }) + "\n");
      }
    } catch (_) {}
    try { fs.unlinkSync(pidPath); } catch (_) {}
  }
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
 * Update the heartbeat line in the tag file.
 *
 * If the last line is already a heartbeat, truncates it off and appends the
 * updated one (Fork C: no in-place overwrite, no fixed-width contract).
 * If the last line is classified data, appends a new heartbeat line.
 *
 * Scans backwards from EOF for the last newline to handle arbitrarily long
 * preceding lines (classified data lines can be large with `cmd` arrays).
 */
function upsertHeartbeat(now: number) {
  try {
    const hbLine = JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n";
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) {
      fs.appendFileSync(tagPath, hbLine);
      return;
    }

    // Scan backwards from EOF in chunks to find the last complete line.
    // A classified data line can be large (e.g. long `cmd` array), so a
    // fixed-size read window would land mid-line.
    const fd = fs.openSync(tagPath, "r+");
    const CHUNK = 512;
    let searchOffset = stat.size;
    let tail = "";
    let lastNl = -1;

    while (searchOffset > 0 && lastNl === -1) {
      const readSize = Math.min(CHUNK, searchOffset);
      searchOffset -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, searchOffset);
      tail = buf.toString("utf8") + tail;
      lastNl = tail.lastIndexOf("\n");
    }

    // Resolve the last complete line. If the file ends with \n (normal),
    // the last \n is a terminator — step back to the previous \n to find
    // the actual last line. If the file does not end with \n (edge case),
    // the last \n is the separator before the last line.
    let lastLineStart: number;
    if (lastNl === tail.length - 1) {
      // File ends with \n — find the \n that precedes the last line
      const prevNl = tail.lastIndexOf("\n", tail.length - 2);
      lastLineStart = prevNl === -1 ? 0 : prevNl + 1;
    } else if (lastNl === -1) {
      lastLineStart = 0;
    } else {
      lastLineStart = lastNl + 1;
    }

    const lastLine = tail.slice(lastLineStart).trim();

    let isHb = false;
    try {
      const obj = JSON.parse(lastLine);
      isHb = obj._hb !== undefined;
    } catch (_) {}

    if (isHb) {
      // Truncate the stale heartbeat line, then append the updated one.
      // No fixed-width overwrite — the file simply shrinks by one heartbeat
      // line and grows by one (net-zero for equal-length heartbeats).
      const truncAt = searchOffset + lastLineStart;
      fs.ftruncateSync(fd, truncAt);
    }
    fs.appendFileSync(tagPath, hbLine);
    fs.closeSync(fd);
  } catch (_) {
    // Fallback: append if we can't seek/overwrite
    try {
      fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: idleStartMs, last: now } }) + "\n");
    } catch (_2) {}
  }
}

function flushPending() {
  if (pendingItems.length === 0) return;
  // Serialize at flush: compaction/recache meter-splits emit dual lines,
  // and interrupt markers that arrived after enqueue are already stamped.
  const batch = pendingItems.map(it => serializeClassifiedWithOverheadSplit(it.interaction, it.prevCtx)).join("");
  pendingItems = [];
  try {
    fs.appendFileSync(tagPath, batch);
    // _meta offset tracking (#124): record the byte position processed so the
    // next daemon instance knows exactly where to resume, rather than skipping
    // to sessionPath.size and missing lines written while the daemon was dead.
    fs.appendFileSync(tagPath, JSON.stringify({ _meta: { offset: lastSize } }) + "\n");
    idleStartMs = 0; // Data arrived — idle period ended
  } catch (err) {
    // If we can't write, log and continue — don't crash the daemon
    if (process.env.WTFT_DAEMON_DEBUG) {
      process.stderr.write(`[wtft-log-parser] write error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  lastWriteMs = Date.now();
}

/** Check if an interaction has a bash command that spawns `claude -p`. */
function hasClaudeCommand(interaction: NonNullable<ReturnType<typeof parseEntryToInteraction>>): boolean {
  return interaction.commands.some(cmd => {
    // Replicate normalizeCommand + regex from wtft-parser.ts classifyInteraction
    let normalized = cmd.trim();
    let changed = true;
    while (changed) {
      changed = false;
      const stripped = normalized.replace(/^(?:\w+=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*)+/, '');
      if (stripped !== normalized) { normalized = stripped.trim(); changed = true; }
      const afterSep = normalized.replace(/^(?:&&|;|\|\|?)\s*/, '');
      if (afterSep !== normalized) { normalized = afterSep; changed = true; }
      const afterCd = normalized.replace(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/, '');
      if (afterCd !== normalized) { normalized = afterCd; changed = true; }
    }
    if (!normalized) return false;
    return /(?:^|\s)claude(?:\s+-|\s*\||\s*$)/.test(normalized.toLowerCase());
  });
}

/** Scan for sub-agent sessions (both task/agent/workflow spawns #82 and
 *  claude -p bash commands #138). When found, parse, classify, and write
 *  to the tag file — renderers see them as regular turns. */
function scanForSubAgents() {
  let wroteAny = false;

  // --- Claude bash sub-agents (#138) ---
  if (pendingClaudeCommands.length > 0) {
    const stillPending: typeof pendingClaudeCommands = [];
    for (const item of pendingClaudeCommands) {
      const interaction = item.interaction;
      let cwd: string | null = null;
      for (const cmd of interaction.commands) {
        cwd = extractCwdFromBashCommand(cmd);
        if (cwd) break;
      }
      if (!cwd) continue;

      const files = discoverClaudeSubAgentSessionFiles(cwd, interaction.timestamp);
      if (files.length === 0) {
        stillPending.push(item);
        continue;
      }
      for (const file of files) {
        const sessionId = path.basename(file, '.jsonl');
        if (discoveredClaudeSessions.has(sessionId)) continue;
        discoveredClaudeSessions.add(sessionId);
        wroteAny = writeSessionToTagFile(file) || wroteAny;
      }
    }
    pendingClaudeCommands.length = 0;
    if (stillPending.length > 0) pendingClaudeCommands.push(...stillPending);
  }

  // --- Task/agent/workflow sub-agents (#82), re-parsed while running (#270) ---
  // A subagent is discovered while it is STILL RUNNING, so parsing it once at
  // discovery would freeze its numbers at whatever it had written so far.
  // Instead, every poll re-reads each known subagent file incrementally —
  // exactly like the parent session (parseNewLines below) — so growth after
  // discovery is still counted, and a finished subagent naturally stops being
  // re-parsed once readNewSubagentLines finds no new bytes.
  const taskAgentFiles = discoverSubagentSessionFiles(sessionPath);

  // Eviction (#270 review): drop state for transcripts that are GONE, and only
  // those. "The subagent finished" is NOT a safe rule — discoverSubagentSessionFiles
  // re-lists every transcript on disk every poll, so a finished subagent is
  // re-discovered on the very next one; evicting it would re-read it from offset 0
  // forever and re-append the whole transcript each time. A file that is no longer
  // listed cannot be re-discovered, and if one reappears under the same name it is
  // a new file that must be read from zero anyway — so its stale offset is not
  // merely droppable, it is wrong to keep (the truncate branch only self-heals when
  // the replacement is SMALLER).
  //
  // This bounds the map by the transcripts that currently exist for this session,
  // not by every one ever seen. It cannot do better: an offset per live file is
  // exactly the state the incremental read needs, and forgetting a live one is the
  // overcount. Guarded on a non-empty scan because discoverSubagentSessionFiles
  // swallows directory-read errors and returns [] — a transient unreadable dir must
  // not look like "every subagent vanished".
  if (taskAgentFiles.length > 0 && discoveredSubagentFiles.size > taskAgentFiles.length) {
    const live = new Set(taskAgentFiles.map(f => path.basename(f, '.jsonl')));
    for (const knownId of [...discoveredSubagentFiles.keys()]) {
      if (!live.has(knownId)) discoveredSubagentFiles.delete(knownId);
    }
  }

  for (const file of taskAgentFiles) {
    const sessionId = path.basename(file, '.jsonl');
    let fileState = discoveredSubagentFiles.get(sessionId);
    if (!fileState) {
      fileState = { lastSize: 0, streamState: newParseStreamState() };
      discoveredSubagentFiles.set(sessionId, fileState);
    }
    // Offset BEFORE the read, so a failed write can put it back. The reader
    // advances fileState.lastSize as soon as it has the bytes, which on its own
    // would mean an ENOSPC/EACCES/removed-tag-dir loses those interactions for
    // good — #270's own "later writes invisible forever", re-triggered by an
    // I/O blip. The code this replaced (writeSessionToTagFile) wrapped the whole
    // parse+dedupe+serialize+append in one try/catch; this keeps that guarantee
    // and adds the rollback the old whole-file re-parse never needed.
    const offsetBefore = fileState.lastSize;
    const rawInteractions = readNewSubagentLines(file, fileState);
    // Late interrupt marker (#270 review): the killed turn was appended in an
    // earlier poll and the tag file is append-only, so re-emit that turn with
    // `ir` set. The tag file's read-side collapse (dedupeClassifiedById) merges
    // copies sharing a message.id and propagates `interrupted` from any of them
    // at unchanged cost, so this corrects the record without duplicating it.
    let replayedTail: NonNullable<ReturnType<typeof parseEntryToInteraction>> | null = null;
    if (fileState.stampInterruptOnLastWritten) {
      const tail = fileState.lastWritten;
      if (tail && !tail.interrupted) {
        tail.interrupted = true;
        replayedTail = tail;
        rawInteractions.unshift(tail);
      }
      fileState.stampInterruptOnLastWritten = false;
    }
    if (rawInteractions.length === 0) continue; // unchanged since last poll
    try {
      const deduped = deduplicateInteractions(rawInteractions);
      // Nested claude-bash sub-agents (#138) spawned FROM this subagent's own
      // commands — parseSessionFile does this for a whole-file read; do the
      // same for this batch so incremental reads don't lose the attribution.
      attributeClaudeSubAgentCosts(deduped);
      let batch = '';
      for (const si of deduped) {
        batch += serializeClassified(si);
      }
      if (batch) {
        fs.appendFileSync(tagPath, batch);
        wroteAny = true;
      }
      if (deduped.length > 0) fileState.lastWritten = deduped[deduped.length - 1];
    } catch (err) {
      // Rewind so the un-written bytes are re-read on a later poll. Replaying
      // the same control entries through streamState is idempotent (thinking
      // level and model are plain sets; compaction flags are re-set and
      // re-consumed by the same interaction), so the only cost is one repeated
      // parse. Keep polling — one bad write must not stop this subagent, the
      // other subagents in this loop, or the parent session's own tag writes.
      fileState.lastSize = offsetBefore;
      // Un-do the interrupt replay too, so the rewound bytes redo it cleanly
      // rather than silently swallowing the stamp.
      if (replayedTail) {
        replayedTail.interrupted = undefined;
        fileState.stampInterruptOnLastWritten = true;
      }
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] subagent write error (${sessionId}), offset rewound to ${offsetBefore}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }

  if (wroteAny) {
    lastWriteMs = Date.now();
    idleStartMs = 0;
  }
}

/** Parse a sub-agent session file, classify its interactions, and write
 *  them to the tag file. Returns true if any entries were written. */
function writeSessionToTagFile(file: string): boolean {
  try {
    const subInteractions = parseSessionFile(file);
    const deduped = deduplicateInteractions(subInteractions);
    let batch = '';
    for (const si of deduped) {
      batch += serializeClassified(si);
    }
    if (batch) {
      fs.appendFileSync(tagPath, batch);
      return true;
    }
  } catch { /* file unreadable */ }
  return false;
}

/** Parse new lines into interactions, threading control entries (thinking
 *  level #77, model_change #128, compaction #90, interrupt #52 Phase 3)
 *  through the given stream state. Shared by the parent's parseNewLines and
 *  the subagent incremental reader (#270) so the two paths cannot drift
 *  apart (#156) — same shape as parseSessionFile's whole-file loop. */
function parseLinesIntoInteractions(
  newContent: string,
  fileStreamState: ReturnType<typeof newParseStreamState>,
  onInterrupt: (interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[]) => void
) {
  const interactions: NonNullable<ReturnType<typeof parseEntryToInteraction>>[] = [];
  const lines = newContent.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const isControl = applyControlEntry(entry, fileStreamState, () => onInterrupt(interactions));
      if (isControl) continue;

      const interaction = parseEntryToInteraction(entry, fileStreamState.thinkingLevel, fileStreamState.compactionTokensBefore, fileStreamState.afterCompaction, fileStreamState.model);
      if (interaction) {
        interactions.push(interaction);
        fileStreamState.compactionTokensBefore = undefined; // consumed
        fileStreamState.afterCompaction = false; // consumed
      }
    } catch (_) {
      // Skip unparseable lines (partial writes, non-JSON)
    }
  }
  return interactions;
}

function parseNewLines(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < lastSize) {
      // File truncated or rotated — reset
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] session truncated, resetting offset\n`);
      }
      lastSize = 0;
    }
    if (currentSize <= lastSize) return [];
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(currentSize - lastSize);
    fs.readSync(fd, buf, 0, buf.length, lastSize);
    fs.closeSync(fd);
    lastSize = currentSize;
    const newContent = buf.toString("utf8");
    // Interrupt: the killed turn is either the last interaction of this
    // batch, or still sitting unflushed in pendingItems (stamped in the
    // main loop). If it was already flushed to the tag file, the stamp is
    // dropped — bounded by one 667ms beat.
    return parseLinesIntoInteractions(newContent, streamState, (interactions) => {
      if (interactions.length > 0) {
        interactions[interactions.length - 1].interrupted = true;
      } else {
        stampInterruptOnPending = true;
      }
    });
  } catch (_) {
    // File may not exist yet
    return [];
  }
}

/** Incrementally read a subagent transcript exactly like the parent session
 *  is read — a byte offset plus threaded stream state — so tokens written
 *  AFTER first discovery are still counted (#270). Mutates fileState.lastSize
 *  in place. Cheap when unchanged: one stat, no read. */
function readNewSubagentLines(filePath: string, fileState: SubagentFileState) {
  try {
    const stat = fs.statSync(filePath);
    const currentSize = stat.size;
    if (currentSize < fileState.lastSize) {
      // Truncated/rotated — rare for a subagent transcript, but keep symmetry
      // with the parent's own reset-on-truncate handling, diagnostic included
      // (#270 review): a silent offset reset is the harder failure to diagnose,
      // and the parent has named this on stderr since #155. Name the file too —
      // unlike the parent, there are many of these.
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] subagent transcript truncated, resetting offset: ${path.basename(filePath)}\n`);
      }
      fileState.lastSize = 0;
      // The turn held for a late interrupt stamp belongs to the file that just
      // went away; stamping it after a rotation would correct the wrong record.
      fileState.lastWritten = undefined;
      fileState.stampInterruptOnLastWritten = false;
    }
    if (currentSize <= fileState.lastSize) return [];
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(currentSize - fileState.lastSize);
    fs.readSync(fd, buf, 0, buf.length, fileState.lastSize);
    fs.closeSync(fd);
    fileState.lastSize = currentSize;
    const newContent = buf.toString("utf8");
    // A subagent transcript has no cross-poll pendingItems queue, so the two
    // cases split (#270 review): a marker mid-batch stamps the last interaction
    // parsed in this batch, and a marker that arrives with no interaction of its
    // own belongs to a turn already appended in an earlier poll — the caller
    // re-emits that turn stamped. Without the second case the `ir` flag was
    // dropped for good, and an interrupted turn's whole cost is discarded work
    // (#52 Phase 3), so reporting it as productive is a real error.
    return parseLinesIntoInteractions(newContent, fileState.streamState, (interactions) => {
      if (interactions.length > 0) interactions[interactions.length - 1].interrupted = true;
      else fileState.stampInterruptOnLastWritten = true;
    });
  } catch (_) {
    return [];
  }
}

// ---
// META OFFSET TRACKING (#124)
// ---

/**
 * Read the byte offset from the last _meta line in the tag file.
 * Returns null if no _meta line found (tag file predates offset tracking).
 */
function readLastMetaOffset(tagPath: string): number | null {
  try {
    const stat = fs.statSync(tagPath);
    if (stat.size === 0) return null;
    // Scan last ~8KB for the most recent _meta line.
    const readStart = Math.max(0, stat.size - 8192);
    const fd = fs.openSync(tagPath, "r");
    const buf = Buffer.alloc(stat.size - readStart);
    fs.readSync(fd, buf, 0, buf.length, readStart);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj._meta && typeof obj._meta.offset === "number") {
          return obj._meta.offset;
        }
      } catch { continue; }
    }
  } catch { /* tag file unreadable */ }
  return null;
}

// ---
// FOLLOW A MOVED SESSION (#155)
// ---

/**
 * The transcript is MOVED, not copied, when a session changes project dirs
 * (worktree enter/exit). One file, one session id, nothing duplicated — so the
 * right response to a vanished path is to find the file again, not to die.
 *
 * Re-points `sessionPath` and returns true when the session was found
 * elsewhere. Deliberately does NOT re-point `tagPath`: `--watch` binds fs.watch
 * to the tag path once and never re-resolves, so holding the output fixed is
 * what lets an attached watch survive the move. One daemon, moving input, fixed
 * output. A `wtft` started afterwards from the new directory still finds that
 * output — getTagPath() searches sibling project dirs for exactly this case.
 *
 * Incremental parsing is untouched: a move preserves size, so the next poll
 * reads from where the last one stopped.
 */
function followMovedSession(): boolean {
  const moved = resolveMovedSession(sessionPath);
  if (!moved) return false;
  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] session moved: ${sessionPath} -> ${moved}\n`);
  }
  sessionPath = moved;
  return true;
}

/**
 * Guard for the two places that SIGTERM a daemon whose `--session` path (read
 * from /proc/<pid>/cmdline) no longer exists. After a move the cmdline still
 * shows the old path, so without this every `wtft` run would kill the very
 * daemon #155 exists to keep alive.
 */
function sessionIsGone(sessionCmdlinePath: string): boolean {
  if (fs.existsSync(sessionCmdlinePath)) return false;
  if (resolveMovedSession(sessionCmdlinePath) !== null) return false;
  // Never written ≠ gone (#308). A daemon parked on a transcript Claude Code has
  // not written yet (#124/#129) is doing its job; before this guard the reaper
  // — which runs at every daemon's startup — SIGTERMed it, and SIGTERMed *itself*
  // in the same pass, so the "waiting for session .jsonl" state could never be
  // reached by a live daemon. "Gone" needs evidence the session once existed:
  // a classified line or a _meta offset in the tag file. Absent that, the owner
  // daemon's own SESSION_WAIT_MAX_MS ceiling is the bound, not this reaper.
  return sessionWasEverParsed(sessionCmdlinePath);
}

/** Does the tag file carry evidence the session existed (a classified entry or a _meta offset)? */
function sessionWasEverParsed(sessionCmdlinePath: string): boolean {
  try {
    const tagsDir = path.join(path.dirname(sessionCmdlinePath), "wtft-tags");
    const prefix = path.basename(sessionCmdlinePath) + ".wtft-tag.v";
    for (const f of fs.readdirSync(tagsDir)) {
      if (!f.startsWith(prefix)) continue;
      const content = fs.readFileSync(path.join(tagsDir, f), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.cat !== undefined || o._meta !== undefined) return true;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return false;
}

// ---
// REAP & WARN (#130)
// ---

const WARN_LOG_DIR = path.join(os.homedir(), ".local", "state", "wtft");
const WARN_LOG = path.join(WARN_LOG_DIR, "reap.log");
const TAG_SIZE_WARN = 1_000_000;     // 1 MB — tag file suspiciously large
const HB_RATIO_WARN = 0.9;            // >90% of lines are heartbeats → malfunction
const ZERO_INTERACTIONS_AGE = 3600000; // 1h with zero real interactions → zombie

function reapAndWarn() {
  const pidDir = os.tmpdir();
  let pidFiles: string[] = [];
  try {
    pidFiles = fs.readdirSync(pidDir).filter(f => f.startsWith("wtft-daemon-") && f.endsWith(".pid"));
  } catch (_) {}

  const warnings: string[] = [];

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

    // Resolve session path from /proc/<pid>/cmdline
    let sessionFound: string | null = null;
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const args = cmdline.split("\0");
      const sessIdx = args.indexOf("--session");
      if (sessIdx >= 0 && sessIdx + 1 < args.length) {
        sessionFound = args[sessIdx + 1];
      }
    } catch (_) {}

    // HARD: stale pidfile (process dead)
    if (!alive) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      continue;
    }

    // HARD: session file gone → kill daemon. "Gone" excludes "merely moved" (#155)
    // and "not written yet" (#308). Never our own PID — the owner decides for itself.
    if (pid !== process.pid && sessionFound && sessionIsGone(sessionFound)) {
      process.kill(pid, "SIGTERM");
      try { fs.unlinkSync(fullPath); } catch (_) {}
      warnings.push(`[${new Date().toISOString()}] KILLED PID ${pid}: session gone — ${sessionFound}`);
      continue;
    }

    // SOFT: check alive daemon for warning predicates
    if (sessionFound) {
      // Find tag file for this session
      let tagFound: string | null = null;
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagFound = path.join(tagsDir, f);
            break;
          }
        }
      } catch (_) {}

      if (tagFound) {
        try {
          const stat = fs.statSync(tagFound);
          const content = fs.readFileSync(tagFound, "utf8");
          const lines = content.trim().split("\n");
          const hbLines = lines.filter(l => l.includes('"_hb"') && !l.includes('"stop"'));
          const hbRatio = lines.length > 0 ? hbLines.length / lines.length : 0;

          // SOFT: tag file suspiciously large
          if (stat.size > TAG_SIZE_WARN) {
            const mb = (stat.size / (1024 * 1024)).toFixed(1);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: tag file large (${mb} MB) — ${tagFound}`);
          }

          // SOFT: heartbeat ratio too high (malfunctioning daemon writing only heartbeats)
          if (lines.length > 10 && hbRatio >= HB_RATIO_WARN) {
            const pct = Math.round(hbRatio * 100);
            warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${pct}% heartbeats (${hbLines.length}/${lines.length} lines) — possible malfunction — ${tagFound}`);
          }

          // SOFT: daemon age with zero real interactions
          // Check if any line in the tag file is a classified interaction (not _hb, not _meta)
          const hasInteractions = lines.some(l => {
            try { const o = JSON.parse(l.trim()); return o.cat !== undefined; } catch { return false; }
          });
          if (!hasInteractions) {
            // Estimate daemon age from first heartbeat
            const firstHb = hbLines[0];
            if (firstHb) {
              try {
                const hb = JSON.parse(firstHb);
                const startTime = hb._hb?.first;
                if (startTime && (Date.now() - startTime) > ZERO_INTERACTIONS_AGE) {
                  const ageH = Math.round((Date.now() - startTime) / 3600000);
                  warnings.push(`[${new Date().toISOString()}] WARN PID ${pid}: ${ageH}h old with zero real interactions — zombie daemon? — ${sessionFound}`);
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }
  }

  // SOFT: stale fixture dirs in /tmp with no owning daemon
  try {
    const tmpEntries = fs.readdirSync(os.tmpdir());
    const liveSessions = new Set<string>();
    for (const pidFile of pidFiles) {
      try {
        const fullPath = path.join(pidDir, pidFile);
        const pid = parseInt(fs.readFileSync(fullPath, "utf8").trim(), 10);
        if (pid > 0) {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          const args = cmdline.split("\0");
          const sessIdx = args.indexOf("--session");
          if (sessIdx >= 0 && sessIdx + 1 < args.length) {
            liveSessions.add(args[sessIdx + 1]);
          }
        }
      } catch (_) {}
    }
    for (const entry of tmpEntries) {
      if (!entry.startsWith("wtft-")) continue;
      const fullDir = path.join(os.tmpdir(), entry);
      let isDir = false;
      try { isDir = fs.statSync(fullDir).isDirectory(); } catch (_) { continue; }
      if (!isDir) continue;
      // Check if any live daemon's session path contains this dir
      const claimed = [...liveSessions].some(s => s.startsWith(fullDir));
      if (!claimed) {
        // Check age: only warn for dirs older than 1h (avoid fresh test dirs)
        try {
          const mtime = fs.statSync(fullDir).mtimeMs;
          if (Date.now() - mtime > 3600000) {
            warnings.push(`[${new Date().toISOString()}] WARN: stale fixture dir with no owning daemon — ${fullDir}`);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  if (warnings.length > 0) {
    try {
      fs.mkdirSync(WARN_LOG_DIR, { recursive: true });
      fs.appendFileSync(WARN_LOG, warnings.join("\n") + "\n");
    } catch (_) {}
  }
}

function initClassified() {
  // Version is embedded in filename (TAG_SUFFIX), so no _cv header needed.
  // On startup: if the tag file already exists (same version) AND contains
  // actual classified entries (not just heartbeats or _meta lines), resume
  // incrementally from the recorded _meta offset (#124). If no _meta offset
  // exists, fall back to full re-parse.
  // If tag file is missing or only has heartbeats, do a full re-parse.
  let hasData = false;
  try {
    fs.accessSync(tagPath);
    // Check if tag file has actual classified entries (not just _hb or _meta lines).
    const tagContent = fs.readFileSync(tagPath, "utf8");
    hasData = tagContent.split("\n").some(l => l.trim() && !l.includes('"_hb"') && !l.includes('"_meta"'));
    if (hasData) {
      // Tag file has real data — resume from last known byte offset (#124).
      const metaOffset = readLastMetaOffset(tagPath);
      if (metaOffset !== null) {
        lastSize = metaOffset;
      } else {
        // No _meta found — tag file predates offset tracking.
        // Full re-parse — clear the tag file first so old entries
        // don't duplicate when we re-classify everything from scratch.
        try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
        lastSize = 0;
      }
    } else {
      // Tag file exists but no classified data (only heartbeats from a
      // previous daemon that exited before its first poll). Full re-parse.
      // Clear the tag file so previous heartbeat/stop lines don't accumulate.
      try { fs.truncateSync(tagPath, 0); } catch { /* best effort */ }
      lastSize = 0;
    }
  } catch (_) {
    // No tag file for this version — fresh start, full reparse on next poll
    lastSize = 0;
  }

  // Write start heartbeat
  const startNow = Date.now();
  fs.appendFileSync(tagPath, JSON.stringify({ _hb: { first: startNow, last: startNow } }) + "\n");
  idleStartMs = startNow;
}

// ---
// MAIN LOOP
// ---

async function main() {
  // User pricing registry (#140) — the daemon computes every per-turn cost
  // baked into tag files, so overrides must merge before any parsing.
  loadUserPricing();

  // Out-of-tree harnesses (#156) — config-declared modules must register
  // before any discovery or parsing. Built-ins need no load step.
  await loadExternalHarnesses();

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
      console.log(`wtft-daemon — Log parser daemon for WTFT
Usage: wtft-daemon --session <path> [--debug]

Management:
  --list, -l            List all running daemons (session, PID, idle time)
  --cleanup             Kill daemons whose source session no longer exists
  --restart             Kill all running daemons (fresh spawn on next wtft)
  --stop <session>      Stop the daemon for a specific session path

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
  let pidFiles: string[] = [];
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

    // Try to find session path from cmdline
    let sessionFound = null;
    let tagMtime = 0;
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

    // Get tag file mtime and version (look in wtft-tags/ subdirectory)
    let taggerVersion = "?";
    if (sessionFound) {
      try {
        const tagsDir = path.join(path.dirname(sessionFound), "wtft-tags");
        const sessBase = path.basename(sessionFound);
        const prefix = sessBase + ".wtft-tag.v";
        for (const f of fs.readdirSync(tagsDir)) {
          if (f.startsWith(prefix)) {
            tagMtime = fs.statSync(path.join(tagsDir, f)).mtimeMs;
            // Extract version from filename: ...wtft-tag.v2.3.1.jsonl → 2.3.1
            taggerVersion = f.slice(prefix.length, f.length - 6); // strip '.jsonl'
            break;
          }
        }
      } catch (_) {}
    }

    if (showRestart) {
      if (alive) {
        process.kill(pid, "SIGTERM");
      }
      try { fs.unlinkSync(fullPath); } catch (_) {}
      // Re-launch fresh daemon for same session
      if (sessionFound) {
        try {
          const child = spawn(process.execPath, [process.argv[1], "--session", sessionFound], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();
        } catch (_2) {}
      }
      console.log(`Restarted: PID ${pid} → fresh daemon for ${sessionFound || "(unknown)"}`);
      found++;
      continue;
    }

    if (showCleanup) {
      if (!alive) {
        try { fs.unlinkSync(fullPath); } catch (_) {}
        continue;
      }
      if (sessionFound && sessionIsGone(sessionFound)) {
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
      if (tagMtime > 0) {
        const idleSec = Math.floor((Date.now() - tagMtime) / 1000);
        if (idleSec < 60) idleStr = `${idleSec}s`;
        else if (idleSec < 3600) idleStr = `${Math.floor(idleSec / 60)}m`;
        else idleStr = `${Math.floor(idleSec / 3600)}h`;
      }
      const sessionDisplay = sessionFound || `(hash: ${pidFile.replace(/^wtft-daemon-/, "").replace(/\.pid$/, "")})`;
      console.log(`PID ${String(pid).padEnd(7)} ${status.padEnd(20)} v${taggerVersion.padEnd(7)} idle: ${idleStr.padEnd(5)} ${sessionDisplay}`);
    }
  }

  if (showRestart) {
    console.log(`Restarted ${found} daemon(s). Run wtft to spawn fresh instances.`);
  }
  if (showCleanup) {
    console.log(`Cleaned up ${found} daemon(s).`);
  }
  if (showList && found === 0) {
    console.log("No daemon processes found.");
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
  // Session file may not exist yet (e.g. Pi TUI started but no prompt
  // entered — session.jsonl is created on first write). The daemon waits
  // in its poll loop until the file appears, writing heartbeats so the
  // widget can show "waiting for session .jsonl..." (#124).
  //
  // Guard: refuse to watch a wtft-tag file (prevents recursive daemon loops).
  if (sessionPath.includes(".wtft-tag.v")) {
    process.stderr.write(`wtft-daemon: refusing to watch a tag cache file: ${sessionPath}\n`);
    process.exit(1);
  }

  // Determine wtft-tag path (wtft-tags/ subdirectory, version in filename).
  // Subdirectory keeps tag files out of session discovery — no filename filter needed.
  const sessionBase = path.basename(sessionPath);
  // Prefer an existing current-version tag wherever it lives — a session that
  // moved project dirs leaves its tag behind, and adopting it keeps one
  // continuous tag file across the switch instead of stranding the fuller
  // artifact in an abandoned directory (#155).
  tagPath = getCurrentVersionTagPath(sessionPath);
  const tagsDir = path.dirname(tagPath);
  try { fs.mkdirSync(tagsDir, { recursive: true }); } catch (_) {}

  // PID file for singleton detection. Keyed on the transcript BASENAME, not the
  // full path (#155): a worktree switch moves the transcript between project
  // dirs, and a path-keyed hash would change under it — a `wtft` run from the
  // new directory would miss the still-live daemon and spawn a second one on
  // the same transcript. Must stay in step with getDaemonPidPath().
  const sessionHash = createHash("sha256").update(
    isSessionIdBasename(sessionPath) ? sessionBase : sessionPath
  ).digest("hex").slice(0, 12);
  pidPath = path.join(os.tmpdir(), `wtft-daemon-${sessionHash}.pid`);

  // Version-aware spawn takeover (#95): if an old-version tag file exists,
  // an old-build daemon may still own this session (it baked its tag path at
  // startup and would heartbeat into the stale file forever). Claim the PID
  // file by overwriting it — the old daemon notices the lost lease on its
  // next beat and exits via the takeover protocol. No SIGTERM: the signal
  // handler race (dying daemon unlinking the new owner's PID file) was the
  // daemon-per-restart leak.
  const prefix = sessionBase + ".wtft-tag.v";
  let claimedByTakeover = false;
  try {
    for (const f of fs.readdirSync(tagsDir)) {
      if (f.indexOf(prefix) === 0 && f !== sessionBase + TAG_SUFFIX) {
        fs.writeFileSync(pidPath, String(process.pid));
        claimedByTakeover = true;
        break;
      }
    }
  } catch (e) {
    process.stderr.write(`[wtft-log-parser] takeover scan error: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Singleton check — atomic exclusive-create prevents TOCTOU race.
  // Skipped when takeover already claimed the lease above.

  if (!claimedByTakeover) {
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
  }

  // Version hygiene AFTER claiming the lease (#95): other-version tag files
  // are derived caches — regeneration is the point of the version bump.
  // Re-sweep once after 5s to catch a final heartbeat the outgoing daemon
  // may have written into its old file during its last beat window.
  const sweepOldTagFiles = () => {
    try {
      for (const f of fs.readdirSync(tagsDir)) {
        if (f.startsWith(prefix) && f !== sessionBase + TAG_SUFFIX) {
          try { fs.unlinkSync(path.join(tagsDir, f)); } catch (_) {}
          if (process.env.WTFT_DAEMON_DEBUG) {
            process.stderr.write(`[wtft-log-parser] removed stale tag file: ${f}\n`);
          }
        }
      }
    } catch (_) {}
  };
  sweepOldTagFiles();
  const resweep = setTimeout(sweepOldTagFiles, 5000);
  resweep.unref();

  // Reap orphaned daemons and warn on malfunctioning ones (#130).
  // This is the auto-invocation that was missing — before #130, cleanup
  // only ran when a human explicitly typed `wtft --cleanup`.
  reapAndWarn();

  // Initialize tag file (version check, header, start heartbeat)
  initClassified();

  if (process.env.WTFT_DAEMON_DEBUG) {
    process.stderr.write(`[wtft-log-parser] started, watching: ${sessionPath}\n`);
    process.stderr.write(`[wtft-log-parser] classified: ${tagPath}\n`);
    process.stderr.write(`[wtft-log-parser] pid: ${process.pid}\n`);
  }

  // --- Main poll loop ---
  const loop = () => {
    if (!running) return;

    // Takeover protocol (#95): ownership of the PID file IS ownership of the
    // session. If the lease no longer holds our PID (another daemon claimed
    // it, or the file is gone), exit before writing anything — the check runs
    // first each beat so a superseded daemon dies within one beat.
    try {
      if (fs.readFileSync(pidPath, "utf8").trim() !== String(process.pid)) {
        running = false;
        process.exit(0);
      }
    } catch (_) {
      running = false;
      process.exit(0);
    }

    // If session file doesn't exist yet (Pi session just started, no
    // prompt entered), wait for it to be created. Write heartbeats so
    // the widget knows the daemon is alive and waiting (#124).
    if (!fs.existsSync(sessionPath)) {
      // Was it previously seen and then deleted? Distinguish MOVED from DELETED
      // first (#155): a worktree switch moves the transcript to a project dir
      // derived from the new cwd, so the path vanishes while the session is
      // very much alive. Only shut down when no harness can find it.
      // If never seen yet, keep waiting — the session file is just late (#129 Bug A).
      if (sessionExisted) {
        if (!followMovedSession()) {
          shutdown("session removed");
          return;
        }
      }
      const now = Date.now();
      // Never seen, and past the wait ceiling → the session never got a prompt (#308).
      if (!sessionExisted && now - startupTime >= SESSION_WAIT_MAX_MS) {
        shutdown("session never written");
        return;
      }
      if (idleStartMs === 0) idleStartMs = now;
      upsertHeartbeat(now);
      lastWriteMs = now;
      // Update lastActivityMs so the idle-exit timer doesn't kill a daemon
      // that's been waiting for the session file since startup.
      lastActivityMs = now;
      setTimeout(loop, POLL_MS);
      return;
    }
    sessionExisted = true; // confirmed session file present at least once (#129 Bug A)

    try {
      // Read new lines from session, dedup by message.id (#54), then classify.
      const rawInteractions = parseNewLines(sessionPath);
      // Late interrupt marker: the killed turn is the unflushed tail of
      // pendingItems (order is preserved; anything newer would have caught
      // the stamp inside parseNewLines).
      if (stampInterruptOnPending) {
        if (pendingItems.length > 0) {
          pendingItems[pendingItems.length - 1].interaction.interrupted = true;
        }
        stampInterruptOnPending = false;
      }
      const newInteractions = deduplicateInteractions(rawInteractions);
      if (newInteractions.length > 0) {
        lastActivityMs = Date.now();
        for (const interaction of newInteractions) {
          // prevCtx is captured per-interaction in arrival order — the
          // recache signature compares against the previous non-sidechain
          // message's context size (#52 Phase 3).
          pendingItems.push({ interaction, prevCtx: prevCtxTokens });
          if (!interaction.isSidechain) {
            prevCtxTokens = interaction.inputTokens + interaction.cacheReadTokens + interaction.cacheWriteTokens;
          }
          // Track claude -p commands for sub-agent discovery (#138)
          if (hasClaudeCommand(interaction)) {
            pendingClaudeCommands.push({ interaction, prevCtx: prevCtxTokens });
          }
        }
      }

      // Throttled flush: write at most every 667ms
      const now = Date.now();
      if (pendingItems.length > 0 && (now - lastWriteMs) >= POLL_MS) {
        flushPending();
      }

      // Sub-agent discovery (#82, #138): scan for completed sub-agent
      // sessions (task/agent spawns and claude -p bash commands) and
      // write their classified interactions to the tag file.
      scanForSubAgents();

      // Heartbeat: on every poll cycle when idle, update the _hb range line.
      // First idle poll appends {"_hb":{"first":<ts>}}. Subsequent idle polls
      // overwrite the last line in-place with {"_hb":{"first":<ts>,"last":<ts>}}.
      // When data arrives, the idle period ends — next idle starts a new line.
      // NOTE: do NOT update lastActivityMs here — it tracks actual data activity
      // for the idle-exit check below, not heartbeat flushes.
      if (pendingItems.length === 0) {
        if (idleStartMs === 0) idleStartMs = now;
        upsertHeartbeat(now);
        lastWriteMs = now;
      }

      // Idle exit: if no new interactions have been classified in >24h,
      // assume the session is finished and shut down cleanly.
      // Skip idle exit during the first 60s of daemon runtime (startup grace
      // period) so freshly-spawned daemons aren't killed on their first cycle.
      if (now - lastActivityMs >= IDLE_EXIT_MS && now - startupTime >= 60000) {
        if (process.env.WTFT_DAEMON_DEBUG) {
          process.stderr.write(`[wtft-log-parser] no new data for ${Math.round((now - lastActivityMs)/60000)}m, exiting\n`);
        }
        shutdown("idle timeout");
        return;
      }

      // If the session file disappears, follow it if it merely moved (#155);
      // otherwise exit cleanly.
      if (!fs.existsSync(sessionPath) && !followMovedSession()) {
        shutdown("session removed");
        return;
      }
    } catch (err) {
      // Transient error (disk full, permission denied, corrupted JSON) —
      // log and continue. Don't crash the daemon on a single bad poll cycle.
      if (process.env.WTFT_DAEMON_DEBUG) {
        process.stderr.write(`[wtft-log-parser] poll error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    setTimeout(loop, POLL_MS);
  };

  // Initial full classification if no existing cache
  // parseNewLines handles incremental via lastSize. If this is a fresh start,
  // lastSize is 0 and we'll parse all existing lines.
  loop();
}

main().catch((err) => {
  process.stderr.write(`wtft-daemon: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});

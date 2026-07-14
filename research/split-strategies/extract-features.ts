#!/usr/bin/env -S npx tsx
/**
 * @package princess-pi-packages
 * @research #52 sub-turn cost attribution experiment
 * @description Strategy-agnostic feature extraction: streams a session.jsonl
 *   and emits one feature record per assistant message — billing meters,
 *   per-content-block sizes with category mapping, and the tool results that
 *   entered this turn's context (with the category of the tool that produced
 *   them). Strategies consume these records; they never re-read the session.
 *
 *   Why a separate pass: every proposed strategy needs the same measurable
 *   quantities; extracting once makes strategy runs comparable and cheap.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import { parseEntryToInteraction, classifyInteraction } from "../../extensions/lib/wtft-parser.ts";
import type { Category, Interaction } from "../../extensions/lib/wtft-parser.ts";

// ---
// Per-block / per-result feature shapes
// ---

export interface BlockFeature {
	kind: "text" | "thinking" | "tool_use";
	toolName?: string;
	/** Category this block maps to (tool map / file-path classification). */
	category: Category;
	/** Serialized character count — the measurable size proxy. */
	chars: number;
}

export interface ResultFeature {
	/** Category of the tool_use that produced this result (from prev assistant msg). */
	category: Category;
	toolName: string;
	chars: number;
}

export interface MessageFeatures {
	index: number;
	messageId?: string;
	model?: string;
	timestamp: number;
	/** Billing meters (normalized names across Pi/Claude). */
	meters: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
	/** cache_creation.ephemeral_1h_input_tokens (Claude; recache signature). */
	e1h: number;
	/** usage.iterations length when present (recache guard). */
	iterations: number;
	isSidechain: boolean;
	/** Total $ cost (harness-computed or Pi-native). */
	cost: number;
	/** Baseline category from current latest-stage-wins classifier. */
	baselineCategory: Category;
	/** Content blocks of THIS message (drive output tokens). */
	blocks: BlockFeature[];
	/** Tool results that entered context since the previous assistant message
	 *  (drive this message's input/cacheWrite). */
	incomingResults: ResultFeature[];
	/** True when this turn follows a compact summary marker. */
	afterCompaction: boolean;
	/** True when this turn was followed by a user interrupt marker. */
	interrupted: boolean;
	/** Internal: raw entry accumulator for same-message-id merging (deleted before return). */
	mergedRaw?: any;
}

// ---
// Category mapping for a single block — mirrors wtft-parser's rules by
// building a one-block pseudo-interaction and reusing classifyInteraction,
// so research numbers can't drift from production classification.
// ---

function classifyBlock(block: any, schema: "pi" | "claude"): { cat: Category; toolName?: string } {
	const pseudoEntry = schema === "pi"
		? { type: "message", message: { role: "assistant", id: "x", timestamp: 0, usage: {}, content: [block] } }
		: { type: "assistant", message: { role: "assistant", id: "x", timestamp: 0, usage: {}, content: [block] } };
	const pseudo = parseEntryToInteraction(pseudoEntry);
	const cat = pseudo ? classifyInteraction(pseudo) : ("other" as Category);
	const toolName = block.name ? String(block.name) : undefined;
	// Pure text/thinking blocks classify "prompt" via the pseudo-interaction.
	return { cat, toolName };
}

function blockChars(block: any): number {
	if (block.type === "text") return (block.text || "").length;
	if (block.type === "thinking") return (block.thinking || "").length;
	// tool_use / toolCall: arguments are what the model actually generated.
	const args = block.input ?? block.arguments ?? {};
	try { return JSON.stringify(args).length; } catch { return 0; }
}

/** Char count of a tool result entry (Claude user-type tool_result / Pi toolResult). */
function resultChars(entry: any): number {
	// Claude: toolUseResult (string or object) and/or message.content tool_result blocks
	let chars = 0;
	const tr = entry.toolUseResult;
	if (tr !== undefined) {
		try { chars = Math.max(chars, (typeof tr === "string" ? tr : JSON.stringify(tr)).length); } catch {}
	}
	const content = entry.message?.content;
	if (Array.isArray(content)) {
		for (const b of content) {
			if (b?.type === "tool_result") {
				try { chars += (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")).length; } catch {}
			}
		}
	}
	// Pi: { type: "toolResult", ... } shape
	if (entry.type === "toolResult" || entry.type === "tool_result") {
		try { chars = Math.max(chars, JSON.stringify(entry.result ?? entry.content ?? entry).length); } catch {}
	}
	return chars;
}

// Prefix match: markers come in two spellings — "[Request interrupted by user]"
// and "[Request interrupted by user for tool use]".
const INTERRUPT_PREFIX = "[Request interrupted by user";

function isInterruptMarker(entry: any): boolean {
	if (entry.type !== "user") return false;
	const c = entry.message?.content;
	if (typeof c === "string") return c.includes(INTERRUPT_PREFIX);
	if (Array.isArray(c)) return c.some((b: any) => typeof b?.text === "string" && b.text.includes(INTERRUPT_PREFIX));
	return false;
}

// ---
// Streaming extraction
// ---

export async function extractSession(sessionPath: string): Promise<MessageFeatures[]> {
	const rl = readline.createInterface({ input: fs.createReadStream(sessionPath), crlfDelay: Infinity });

	const out: MessageFeatures[] = [];
	// tool_use id → category/name of the call that will produce a result
	const pendingToolCats = new Map<string, { cat: Category; toolName: string }>();
	let incoming: ResultFeature[] = [];
	let pendingCompaction = false;
	let index = 0;

	for await (const line of rl) {
		if (!line.trim()) continue;
		let entry: any;
		try { entry = JSON.parse(line); } catch { continue; }

		if (entry.isCompactSummary === true || entry.type === "compaction") {
			pendingCompaction = true;
			continue;
		}
		if (isInterruptMarker(entry)) {
			if (out.length > 0) out[out.length - 1].interrupted = true;
			continue;
		}

		const isPi = entry.type === "message" && entry.message?.role === "assistant";
		const isClaude = entry.type === "assistant" && entry.message?.role === "assistant";

		// Pi tool results: type:"message" with role:"toolResult", linked by toolCallId.
		if (entry.type === "message" && entry.message?.role === "toolResult") {
			const m = entry.message;
			let chars = 0;
			try { chars = (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).length; } catch {}
			if (chars > 0) {
				const src = m.toolCallId ? pendingToolCats.get(m.toolCallId) : undefined;
				incoming.push({
					category: src?.cat ?? "other",
					toolName: src?.toolName ?? m.toolName ?? "unknown",
					chars,
				});
			}
			continue;
		}

		if (!isPi && !isClaude) {
			// Possible tool-result carrier: attribute to the tool_use that caused it.
			const chars = resultChars(entry);
			if (chars > 0) {
				// Claude tool_result blocks carry tool_use_id
				let matched = false;
				const content = entry.message?.content;
				if (Array.isArray(content)) {
					for (const b of content) {
						if (b?.type === "tool_result" && b.tool_use_id && pendingToolCats.has(b.tool_use_id)) {
							const src = pendingToolCats.get(b.tool_use_id)!;
							incoming.push({ category: src.cat, toolName: src.toolName, chars });
							matched = true;
						}
					}
				}
				if (!matched) incoming.push({ category: "other", toolName: "unknown", chars });
			} else if (entry.type === "user") {
				// Plain user text (typed prompt / system-reminder) — enters context as prompt.
				const c = entry.message?.content;
				let userChars = 0;
				if (typeof c === "string") userChars = c.length;
				else if (Array.isArray(c)) for (const b of c) if (typeof b?.text === "string") userChars += b.text.length;
				if (userChars > 0) incoming.push({ category: "prompt", toolName: "user", chars: userChars });
			}
			continue;
		}

		const interaction: Interaction | null = parseEntryToInteraction(entry);
		if (!interaction) continue;
		const schema = isPi ? "pi" : "claude";
		const usage = entry.message.usage || {};

		const blocks: BlockFeature[] = [];
		if (Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (!block || typeof block !== "object") continue;
				const kind = block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : "tool_use";
				const { cat, toolName } = classifyBlock(block, schema);
				blocks.push({ kind, toolName, category: kind === "tool_use" ? cat : "prompt", chars: blockChars(block) });
				// Remember tool_use ids so later results attribute to this call's category
				if ((block.type === "tool_use" || block.type === "toolCall") && block.id) {
					pendingToolCats.set(block.id, { cat, toolName: toolName || "?" });
				}
			}
		}

		// Claude Code logs one assistant ENTRY per content block, all sharing a
		// message id and carrying the SAME usage object — the billing unit is
		// the message-id GROUP (this is why production dedups by message id).
		// Merge consecutive same-id entries: blocks accumulate, usage counts once.
		const prev = out.length > 0 ? out[out.length - 1] : null;
		if (prev && interaction.messageId && prev.messageId === interaction.messageId) {
			prev.blocks.push(...blocks);
			prev.incomingResults.push(...incoming);
			prev.afterCompaction = prev.afterCompaction || pendingCompaction;
			// Re-baseline with the merged content: rebuild via merged pseudo entry
			prev.mergedRaw.message.content.push(...(entry.message.content || []));
			const mergedInteraction = parseEntryToInteraction(prev.mergedRaw);
			if (mergedInteraction) prev.baselineCategory = classifyInteraction(mergedInteraction);
		} else {
			out.push({
				index: index++,
				messageId: interaction.messageId,
				model: interaction.model,
				timestamp: interaction.timestamp,
				meters: {
					input: usage.input_tokens ?? usage.input ?? 0,
					output: usage.output_tokens ?? usage.output ?? 0,
					cacheRead: usage.cache_read_input_tokens ?? usage.cacheRead ?? 0,
					cacheWrite: usage.cache_creation_input_tokens ?? usage.cacheWrite ?? 0,
					reasoning: usage.reasoning ?? 0,
				},
				e1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
				iterations: Array.isArray(usage.iterations) ? usage.iterations.length : 0,
				isSidechain: entry.isSidechain === true,
				cost: interaction.cost,
				baselineCategory: classifyInteraction(interaction),
				blocks,
				incomingResults: incoming,
				afterCompaction: pendingCompaction,
				interrupted: false,
				mergedRaw: { ...entry, message: { ...entry.message, content: [...(entry.message.content || [])] } },
			});
		}
		incoming = [];
		pendingCompaction = false;
	}

	for (const f of out) delete (f as any).mergedRaw;
	return out;
}

// ---
// CLI: extract one session → summary stats (sanity check)
// ---

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (invokedDirectly) {
	const sessionPath = process.argv[2];
	if (!sessionPath) {
		console.error("usage: extract-features.ts <session.jsonl>");
		process.exit(1);
	}
	const features = await extractSession(sessionPath);
	const mixed = features.filter(f => new Set(f.blocks.filter(b => b.kind === "tool_use").map(b => b.category)).size > 1);
	const totalCost = features.reduce((s, f) => s + f.cost, 0);
	const mixedCost = mixed.reduce((s, f) => s + f.cost, 0);
	console.log(JSON.stringify({
		messages: features.length,
		totalCost: +totalCost.toFixed(4),
		mixedMessages: mixed.length,
		mixedCostShare: +(mixedCost / (totalCost || 1)).toFixed(3),
		withIncomingResults: features.filter(f => f.incomingResults.length > 0).length,
		afterCompaction: features.filter(f => f.afterCompaction).length,
		interrupted: features.filter(f => f.interrupted).length,
	}, null, 1));
}

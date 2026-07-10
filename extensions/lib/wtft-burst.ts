/**
 * @package princess-pi-packages
 * @module wtft-burst
 * @description Burst-aware incremental token accumulation for WTFT.
 *   Replaces the retroactive O(n) branch-scan with O(1) per-message
 *   accumulation using message_end + agent_settled hooks.
 *   (#78 — Phase 3 of #80)
 */

import type { Interaction } from "./wtft-parser.js";
import { parseEntryToInteraction } from "./wtft-parser.js";

/**
 * Accumulates per-message interactions during a single burst
 * (one user prompt → all agent responses until agent_settled).
 *
 * Each `message_end` for an assistant message contributes one
 * Interaction. On `agent_settled`, the entire burst is flushed
 * and a new accumulator starts fresh.
 *
 * The extension-level `_allInteractions` array holds the merged
 * history: branch-walk data from session_start + flushed bursts.
 */
export class BurstAccumulator {
	private _interactions: Interaction[] = [];

	/**
	 * Parse a raw session entry (from the branch or from a message_end
	 * wrapper) and accumulate it into the current burst. Classification
	 * happens immediately via parseEntryToInteraction — no deferred
	 * branch scan needed.
	 */
	accumulateFromEntry(entry: any, thinkingLevel?: string): void {
		const interaction = parseEntryToInteraction(entry, thinkingLevel);
		if (interaction) {
			this._interactions.push(interaction);
		}
	}

	/** Flush accumulated interactions and reset for the next burst. */
	flush(): Interaction[] {
		const result = [...this._interactions];
		this._interactions = [];
		return result;
	}

	/** Current burst interaction count. */
	get count(): number {
		return this._interactions.length;
	}

	/** Total cost accumulated in this burst. */
	get cost(): number {
		return this._interactions.reduce((sum, i) => sum + (i.cost || 0), 0);
	}

	/** Whether this burst has any accumulated interactions. */
	get hasData(): boolean {
		return this._interactions.length > 0;
	}
}

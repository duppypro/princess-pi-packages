/**
 * @package princess-pi-packages
 * @spec docs/EXT_DEDUP.html
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as process from "node:process";
import { fileURLToPath } from "node:url";
import { runFilterChunked } from "./lib/dedup/io-chunked.js";

// ---
// Standalone pipe-filter mode
// Invoked when the script is the entry point: tail -f app.log | npx tsx dedup.ts
// Uses the chunk-buffered stdin reader (extensions/lib/dedup/io-chunked.ts) —
// see extensions/lib/dedup/benchmark.ts for why this replaced the original
// readline-based reader (still kept in io-readline.ts as the benchmark baseline).
// ---

function runFilter(): void {
    void runFilterChunked();
}

// ---
// Pi extension registration
// ---

export default function dedupExtension(pi: ExtensionAPI) {
    pi.registerCommand("dedup", {
        description: "Stream log deduplicator — pipe logs through it: tail -f app.log | npx tsx extensions/dedup.ts",
        handler: async (_args, ctx) => {
            ctx.ui.notify(
                "Run dedup as a shell pipe:\n  tail -f app.log | npx tsx extensions/dedup.ts",
                "info"
            );
        },
    });
}

// ---
// Entry point detection — run filter when executed directly, not when imported by Pi
// ---

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    runFilter();
}

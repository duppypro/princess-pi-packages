/**
 * @package princess-pi-packages
 * @spec docs/EXT_DEDUP.html
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as readline from "node:readline";
import * as process from "node:process";
import { fileURLToPath } from "node:url";
import {
    createGroup,
    addToGroup,
    buildSummaryLine,
    isMatchingGroup,
    type DupGroup,
} from "./lib/dedup/core.js";

// ---
// Standalone pipe-filter mode
// Invoked when the script is the entry point: tail -f app.log | npx tsx dedup.ts
// ---

function runFilter(): void {
    const isTTY = process.stdout.isTTY ?? false;

    let currentGroup: DupGroup | null = null;

    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

    rl.on("line", (line) => {
        if (currentGroup === null) {
            currentGroup = createGroup(line);
            process.stdout.write(line + "\n");
            return;
        }

        if (isMatchingGroup(currentGroup, line)) {
            addToGroup(currentGroup, line);
            const summary = buildSummaryLine(currentGroup);

            if (isTTY) {
                // Move up one line, clear it, reprint with updated count and ranges.
                process.stdout.write("\x1b[1A\r\x1b[2K" + summary + "\n");
            }
            // Non-TTY: accumulate silently; emit on group end (below).
        } else {
            // Group boundary: flush previous group in non-TTY mode.
            if (!isTTY && currentGroup.count > 1) {
                process.stdout.write("  " + buildSummaryLine(currentGroup) + "\n");
            }

            currentGroup = createGroup(line);
            process.stdout.write(line + "\n");
        }
    });

    rl.on("close", () => {
        // EOF: flush the final group if running non-TTY.
        if (!isTTY && currentGroup && currentGroup.count > 1) {
            process.stdout.write("  " + buildSummaryLine(currentGroup) + "\n");
        }
    });
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

import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createGroup, addToGroup, buildSummaryLine, isMatchingGroup, type DupGroup } from "./core.js";

// Original line-by-line implementation via Node's readline module.
// Kept as the performance baseline for extensions/lib/dedup/benchmark.ts —
// the live dedup.ts entry point uses io-chunked.ts instead.
export function runFilterReadline(
    input: Readable = process.stdin,
    output: Writable = process.stdout
): Promise<void> {
    return new Promise((resolve) => {
        const isTTY = (output as NodeJS.WriteStream).isTTY ?? false;
        let currentGroup: DupGroup | null = null;

        const rl = readline.createInterface({ input, crlfDelay: Infinity });

        rl.on("line", (line) => {
            if (currentGroup === null) {
                currentGroup = createGroup(line);
                output.write(line + "\n");
                return;
            }

            if (isMatchingGroup(currentGroup, line)) {
                addToGroup(currentGroup, line);
                if (isTTY) {
                    output.write("\x1b[1A\r\x1b[2K" + buildSummaryLine(currentGroup) + "\n");
                }
            } else {
                if (!isTTY && currentGroup.count > 1) {
                    output.write("  " + buildSummaryLine(currentGroup) + "\n");
                }
                currentGroup = createGroup(line);
                output.write(line + "\n");
            }
        });

        rl.on("close", () => {
            if (!isTTY && currentGroup && currentGroup.count > 1) {
                output.write("  " + buildSummaryLine(currentGroup) + "\n");
            }
            resolve();
        });
    });
}

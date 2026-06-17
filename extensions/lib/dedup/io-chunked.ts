import type { Readable, Writable } from "node:stream";
import { createGroup, addToGroup, buildSummaryLine, isMatchingGroup, type DupGroup } from "./core.js";

// Chunk-buffered implementation: consumes raw stdin "data" buffers directly
// instead of going through readline's per-line event-emitter machinery.
// Ported from pi-dedup's yada.ts (process.stdin.on("data") + manual leftover
// buffering), whose spec claimed a large speedup over readline on big inputs.
export function runFilterChunked(
    input: Readable = process.stdin,
    output: Writable = process.stdout
): Promise<void> {
    return new Promise((resolve) => {
        const isTTY = (output as NodeJS.WriteStream).isTTY ?? false;
        let currentGroup: DupGroup | null = null;
        let leftover = "";

        function processLine(line: string): void {
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
        }

        input.setEncoding("utf-8");

        input.on("data", (chunk: string) => {
            const lines = (leftover + chunk).split("\n");
            leftover = lines.pop() ?? "";
            for (const line of lines) processLine(line);
        });

        input.on("end", () => {
            if (leftover) processLine(leftover);
            if (!isTTY && currentGroup && currentGroup.count > 1) {
                output.write("  " + buildSummaryLine(currentGroup) + "\n");
            }
            resolve();
        });
    });
}

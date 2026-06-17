const fs = require('fs');
const path = require('path');

const logFile = '/home/princess-pi/.pi/agent/sessions/--home-princess-pi-git-projects-pi-dedup--/2026-06-16T23-49-05-287Z_019ed2d6-ae87-73de-805d-34008d10c2e1.jsonl';

const lines = fs.readFileSync(logFile, 'utf8').split('\n');
const commandMap = new Map();

function classify(interaction) {
    // Very simplified version of our classification logic for the histogram debug
    if (interaction.files.length === 0 && interaction.commands.length > 0) return 'other';
    return 'other_or_prompt';
}

for (const line of lines) {
    if (!line.trim()) continue;
    try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message && entry.message.role === "assistant") {
            const assistantMsg = entry.message;
            const commands = [];
            
            if (Array.isArray(assistantMsg.content)) {
                for (const block of assistantMsg.content) {
                    if (block.type === "toolCall" && block.name === "bash") {
                        const args = block.arguments || {};
                        if (args.command) {
                            const lines = args.command.split('\n');
                            for (const l of lines) {
                                const trimmed = l.trim();
                                if (trimmed && !trimmed.startsWith("#")) {
                                    const primary = trimmed.split(" ")[0];
                                    if (primary) commands.push(primary);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            
            for (const cmd of commands) {
                commandMap.set(cmd, (commandMap.get(cmd) || 0) + 1);
            }
        }
    } catch (e) {}
}

const sorted = Array.from(commandMap.entries()).sort((a, b) => b[1] - a[1]);
console.log("--- 'Other' Command Histogram ---");
for (const [cmd, count] of sorted) {
    console.log(`${cmd.padEnd(15)} : ${"#".repeat(count)} (${count})`);
}

console.log("--- 16-color Palette ---");
for (let i = 30; i <= 37; i++) {
    process.stdout.write(`\x1b[${i}m█\x1b[0m `);
}
for (let i = 90; i <= 97; i++) {
    process.stdout.write(`\x1b[${i}m█\x1b[0m `);
}
console.log("\n");

console.log("--- 256-color Palette (Sample) ---");
const sampleColors = [121, 202, 226, 129, 51, 27, 218, 240, 108, 173, 179, 134, 73, 67, 223, 238];
for (const c of sampleColors) {
    process.stdout.write(`\x1b[38;5;${c}m█\x1b[0m `);
}
console.log("\n");

console.log("--- Current WTFT Color Render Test ---");
const current = [
    { name: "Spec (ANSI 92)", code: "\x1b[92m" },
    { name: "Mixed (120/208)", code: "\x1b[38;5;120;48;5;208m" },
    { name: "Code (208)", code: "\x1b[38;5;208m" },
    { name: "Tests (93)", code: "\x1b[93m" },
    { name: "Research (95)", code: "\x1b[95m" },
    { name: "Git (96)", code: "\x1b[96m" },
    { name: "Grep (94)", code: "\x1b[94m" },
    { name: "Prompt (37)", code: "\x1b[37m" },
    { name: "Other (90)", code: "\x1b[90m" }
];
for (const item of current) {
    console.log(`${item.name.padEnd(20)}: ${item.code}██████\x1b[0m`);
}

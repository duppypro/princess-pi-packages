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

console.log("--- New Solarized Matte (with Rose Tests) Color Render Test ---");
const current = [
    { name: "Spec (108)", code: "\x1b[38;5;108m" },
    { name: "Mixed (108/173)", code: "\x1b[38;5;108;48;5;173m" },
    { name: "Code (173)", code: "\x1b[38;5;173m" },
    { name: "Tests (168)", code: "\x1b[38;5;168m" },
    { name: "Research (134)", code: "\x1b[38;5;134m" },
    { name: "Git (73)", code: "\x1b[38;5;73m" },
    { name: "Grep (67)", code: "\x1b[38;5;67m" },
    { name: "Prompt (223)", code: "\x1b[38;5;223m" },
    { name: "Other (238)", code: "\x1b[38;5;238m" }
];
for (const item of current) {
    console.log(`${item.name.padEnd(20)}: ${item.code}██████\x1b[0m`);
}

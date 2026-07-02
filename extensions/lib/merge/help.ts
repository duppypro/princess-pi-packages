import * as fs from "node:fs";

export function renderHelp(manifestPath: string, invokedAs: string): string {
	const manifestStr = fs.readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(manifestStr);

	let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
	helpText += `${manifest.description}\n\n`;

	helpText += `\x1b[1mExamples:\x1b[0m\n`;
	for (const e of manifest.examples) {
		const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
		helpText += `  ${fullCmd.padEnd(30)} ${e.desc}\n`;
	}

	helpText += `\n\x1b[1mUsage:\x1b[0m\n`;
	for (const u of manifest.usage) {
		helpText += `  ${invokedAs} ${(u.flags).padEnd(28)} ${u.desc}\n`;
	}

	return helpText;
}

// ---
// --why renderer: scenario-driven "why would I use this?" output
// Manifest entries in the "why" array each have: scenario, commands[], result.
// At least one entry should describe what the tool CAN'T do (anti-use-case).
// ---
export function renderWhy(manifestPath: string, invokedAs: string): string {
	const manifestStr = fs.readFileSync(manifestPath, "utf8");
	const manifest = JSON.parse(manifestStr);

	let text = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m - ${manifest.tagline}\n\n`;
	text += `${manifest.description}\n\n`;
	text += `\x1b[1mWhy run ${invokedAs}?\x1b[0m\n\n`;

	const scenarios = manifest.why || [];
	for (const s of scenarios) {
		text += `  ${s.scenario}\n`;
		for (const cmd of s.commands) {
			text += `    \x1b[33m$ ${invokedAs}${cmd ? " " + cmd : ""}\x1b[0m\n`;
		}
		text += `    \x1b[32m→ ${s.result}\x1b[0m\n\n`;
	}

	if (manifest.usage) {
		text += `\x1b[2mRun \x1b[0m${invokedAs} --help\x1b[2m for the full flag reference.\x1b[0m\n`;
	}

	return text;
}
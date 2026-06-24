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
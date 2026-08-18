// skills/ must reach BOTH harness targets — a skill deployed to one and not
// the other IS the drift #345 exists to close. Pi and Claude Code read
// different roots (~/.pi/agent/skills vs ~/.claude/skills), so "deployed"
// only means something if it means both.
//
// Modeled on tests/statusline-deploy-drift.test.ts, generalised for a
// manifest that fans ONE repo file out to TWO destinations instead of one to
// one.
//
// The machine-global side effect this replaces (#345): CLAUDE.md used to tell
// a human to hand-copy skills/<name>/SKILL.md out to both harness targets
// after editing. ~/.claude/skills/ is ONE directory shared by every worktree,
// every branch, and main — so the moment any branch legitimately edited a
// skill and copied it out by hand, every OTHER worktree's
// tests/spec-163-spec-reconcile.test.ts (which used to assert repo-vs-deploy
// parity directly) went red for a reason that had nothing to do with that
// worktree's own changes. That parity question now belongs to
// `install-workflow-tools --check` — a host-drift question, checked here
// against a seeded temp $HOME rather than this host's real one.
//
// Run with: bun run test skills-deploy

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const INSTALLER_SRC = fs.readFileSync(INSTALLER, "utf8");
const SKILLS_SRC = path.join(REPO_ROOT, "skills");

let failures = 0;
let checks = 0;

function check(cond: boolean, label: string, detail = ""): void {
	checks++;
	if (cond) {
		console.log(`  ✅ ${label}`);
	} else {
		console.error(`  ❌ ${label}${detail ? `\n     ${detail.split("\n").join("\n     ")}` : ""}`);
		failures++;
	}
}

/**
 * Read one bash array from the installer, dropping comment lines.
 *
 * Parsed rather than restated — same reason tests/installer-path-ownership.test.ts
 * parses SCRIPTS/HOOKS/STATUSLINES this way (#263): a second hardcoded copy of
 * the manifest drifts the moment a branch adds a skill, and the resulting gap
 * is invisible on either branch alone.
 */
function bashArray(name: string): string[] {
	const m = INSTALLER_SRC.match(new RegExp(`(?:^|\\n)${name}=\\(([\\s\\S]*?)\\n\\)`));
	if (!m) throw new Error(`${name} array not found in bin/install-workflow-tools`);
	return m[1]
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}

const SKILLS = bashArray("SKILLS");

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "skills-deploy-home-"));
}

function run(home: string, args: string[] = []): { code: number; out: string } {
	const r = spawnSync("bash", [INSTALLER, ...args], {
		encoding: "utf8",
		env: { ...process.env, HOME: home },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { code: r.status ?? -1, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function claudeDest(home: string, skill: string): string {
	return path.join(home, ".claude", "skills", skill, "SKILL.md");
}
function piDest(home: string, skill: string): string {
	return path.join(home, ".pi", "agent", "skills", skill, "SKILL.md");
}

console.log("skills deploy + drift gate (#345)");

check(SKILLS.length > 0, "SKILLS manifest is non-empty", "parsed from bin/install-workflow-tools");

// 0. Every skills/*/ directory with a SKILL.md is in the manifest — the
//    "no silently unshipped skill" gate. A skill added to the repo and
//    forgotten here is deployed nowhere, and nothing else would say so.
{
	const onDisk = fs
		.readdirSync(SKILLS_SRC, { withFileTypes: true })
		.filter((e) => e.isDirectory() && fs.existsSync(path.join(SKILLS_SRC, e.name, "SKILL.md")))
		.map((e) => e.name)
		.sort();
	const missing = onDisk.filter((s) => !SKILLS.includes(s));
	check(
		missing.length === 0,
		"every skills/*/SKILL.md directory is in the installer's SKILLS manifest",
		missing.length === 0 ? "" : `on disk but not in manifest: ${missing.join(", ")}`,
	);
}

// 1. Install deploys every manifest skill to BOTH harness targets,
//    byte-identical, and NOT executable — skills are Markdown, not scripts.
{
	const home = freshHome();
	const { code, out } = run(home);

	check(code === 0, "installer exits 0 on a fresh machine", `got ${code}, out:\n${out}`);
	for (const skill of SKILLS) {
		const src = fs.readFileSync(path.join(SKILLS_SRC, skill, "SKILL.md"), "utf8");
		for (const [label, dest] of [
			["Claude", claudeDest(home, skill)],
			["Pi", piDest(home, skill)],
		] as const) {
			const exists = fs.existsSync(dest);
			check(exists, `'${skill}' deployed to ${label} target`, out);
			if (!exists) continue;
			check(fs.readFileSync(dest, "utf8") === src, `'${skill}' deployed byte-identical to source (${label})`);
			check((fs.statSync(dest).mode & 0o111) === 0, `'${skill}' deployed WITHOUT the executable bit (${label})`);
		}
	}

	const second = run(home);
	check(second.code === 0, "second install run → exit 0 (idempotent)", second.out);
	for (const skill of SKILLS) {
		const src = fs.readFileSync(path.join(SKILLS_SRC, skill, "SKILL.md"), "utf8");
		check(fs.readFileSync(claudeDest(home, skill), "utf8") === src, `'${skill}' unchanged after second run (Claude)`);
		check(fs.readFileSync(piDest(home, skill), "utf8") === src, `'${skill}' unchanged after second run (Pi)`);
	}
}

// 2. --check on a drifted temp $HOME reports the drift and repairs nothing —
//    a check that repairs is a check that hides the drift it found.
{
	const home = freshHome();
	run(home);
	const dest = claudeDest(home, SKILLS[0]);
	const stale = "# pretend this SKILL.md is behind source\n";
	fs.writeFileSync(dest, stale);

	const { code, out } = run(home, ["--check"]);
	check(code === 1, `--check with a drifted '${SKILLS[0]}' → exit 1`, `got ${code}, out:\n${out}`);
	check(out.includes(SKILLS[0]), "--check names the drifted skill", out);
	check(fs.readFileSync(dest, "utf8") === stale, "--check left the drifted file alone (report, not repair)");

	const repair = run(home);
	check(repair.code === 0, "install run after drift → exit 0", repair.out);
	check(
		fs.readFileSync(dest, "utf8") === fs.readFileSync(path.join(SKILLS_SRC, SKILLS[0], "SKILL.md"), "utf8"),
		"install run overwrote the drifted file with source",
	);
}

// 3. --check on a fresh (never-deployed) $HOME: exit 1, names every skill,
//    writes nothing.
{
	const home = freshHome();
	const { code, out } = run(home, ["--check"]);
	check(code === 1, "--check with nothing deployed → exit 1", `got ${code}, out:\n${out}`);
	for (const skill of SKILLS) {
		check(!fs.existsSync(claudeDest(home, skill)), `--check deployed nothing for '${skill}' (Claude)`, out);
		check(!fs.existsSync(piDest(home, skill)), `--check deployed nothing for '${skill}' (Pi)`, out);
	}
}

// 4. Neighbouring skills in the temp $HOME survive untouched — the
//    no-directory-sync guarantee. ~/.claude/skills holds 60+ skills from
//    other sources and ~/.pi/agent/skills holds ~50; this installer must
//    create/overwrite only the manifest's six files and touch nothing else.
{
	const home = freshHome();
	const decoyClaude = path.join(home, ".claude", "skills", "decoy", "SKILL.md");
	const decoyPi = path.join(home, ".pi", "agent", "skills", "decoy2", "SKILL.md");
	fs.mkdirSync(path.dirname(decoyClaude), { recursive: true });
	fs.mkdirSync(path.dirname(decoyPi), { recursive: true });
	const decoyClaudeBody = "# SENTINEL decoy — not ours, must survive install\n";
	const decoyPiBody = "# SENTINEL decoy2 — not ours, must survive install\n";
	fs.writeFileSync(decoyClaude, decoyClaudeBody);
	fs.writeFileSync(decoyPi, decoyPiBody);

	const { code, out } = run(home);
	check(code === 0, "install with decoy skills present → exit 0", out);
	check(fs.readFileSync(decoyClaude, "utf8") === decoyClaudeBody, "decoy skill in ~/.claude/skills/ untouched");
	check(fs.readFileSync(decoyPi, "utf8") === decoyPiBody, "decoy skill in ~/.pi/agent/skills/ untouched");
}

// ---
// Frontmatter must survive a YAML parse (#226 review finding).
//
// A skill's `description` is what a harness shows when an agent PICKS a skill —
// it is read before the body, and for a retired or superseded skill it is the
// only warning that arrives in time. In an unquoted YAML scalar a space
// followed by `#` opens a COMMENT, so `description: SUPERSEDED by #226 …`
// parses to exactly `SUPERSEDED by` and the rest is discarded silently. That
// happened here: the banner added to stop agents following a retired recipe was
// itself truncated to two words.
//
// Checked without a YAML dependency, because the hazard is narrow and nameable:
// an unquoted scalar must not contain " #". Issue references are the common way
// to hit it, and this repo puts issue numbers in prose constantly.
// ---
console.log("\n— skill frontmatter survives a YAML parse");

for (const skill of SKILLS) {
	const src = fs.readFileSync(path.join(REPO_ROOT, "skills", skill, "SKILL.md"), "utf8");
	const fm = src.split("---")[1] ?? "";
	for (const field of ["name", "description"]) {
		const line = fm.split("\n").find((l) => l.startsWith(`${field}:`));
		if (!line) {
			check(false, `${skill}: frontmatter has a ${field}`);
			continue;
		}
		const value = line.slice(field.length + 1).trim();
		const quoted = /^".*"$|^'.*'$/.test(value);
		check(
			quoted || !value.includes(" #"),
			`${skill}: ${field} is not silently truncated by a YAML comment`,
			`unquoted value contains " #", so YAML keeps only: ${JSON.stringify(value.split(" #")[0])}`,
		);
	}
}

console.log(`\n${failures === 0 ? "✅" : "❌"} skills deploy + drift: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

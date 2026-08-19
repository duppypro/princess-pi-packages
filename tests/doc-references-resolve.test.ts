// --- #230: a doc that names a file names one that exists ---
//
// Every drift found in this repo's two doc sweeps had the same shape: prose citing
// a path that used to be there. `skills/cross-harness-tool` named `bin/merge.mjs`
// (deleted #201) as its reference implementation, `tests/merge-fallback.sandbox.sh`
// as the test to copy, and `skills/learning-pi/` for the widget API — three dead
// citations in one file, all read in good faith by whoever loaded the skill.
//
// A citation is a claim about the repo, and it is the one class of claim a test can
// check exactly. So this suite checks three kinds:
//
//   1. every `docs/manifests/*-cmd.json` names a target that ships;
//   2. every skill-to-skill reference resolves to a skill on disk;
//   3. every repo-relative path a skill cites exists.
//
// Deliberately scoped to skills and manifests, not all of docs/: skills are LOADED
// INTO CONTEXT and acted on, which makes a dead path there expensive in a way a
// dead path in a design doc is not.
//
// Run with: bun run test doc-references-resolve

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

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

const exists = (rel: string) => fs.existsSync(path.join(REPO, rel));

console.log("#230: every cited path resolves");

// ---
// 1. Manifests name a live target. This is what would have caught merge-cmd.json
//    outliving bin/merge.
// ---
console.log("\n— manifests name a target that ships");

const manifestDir = path.join(REPO, "docs", "manifests");
const manifests = fs.readdirSync(manifestDir).filter((f) => f.endsWith("-cmd.json"));
check(manifests.length > 0, `found ${manifests.length} command manifests`);

for (const m of manifests) {
	const name = m.replace(/-cmd\.json$/, "");
	// A manifest is honest if SOME face of the tool ships: a bin, or an extension.
	const targets = [`bin/${name}.ts`, `bin/${name}.mjs`, `bin/${name}`, `extensions/${name}.ts`];
	const found = targets.filter(exists);
	check(found.length > 0, `${m} → a shipping target exists`, `none of: ${targets.join(", ")}`);
}

// ---
// 1b. Every command `package.json` registers has a build target.
//
//     `package.json` `bin` is a citation too — it names a `.mjs` file npm will put
//     on a user's PATH. `build.ts` produces those from a FIXED `TARGETS` array and
//     discovers nothing, so registering a bin without adding a target yields a
//     build that succeeds, says nothing, and ships a global command that does not
//     exist. Found by macroscopeapp on PR #375 in the skill that teaches this;
//     the guidance and the guard land together, because guidance alone is what
//     was already there.
// ---
console.log("\n— every registered bin has a build target");

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const buildSrc = fs.readFileSync(path.join(REPO, "build.ts"), "utf8");
const targetsBlock = buildSrc.slice(buildSrc.indexOf("const TARGETS"), buildSrc.indexOf("];", buildSrc.indexOf("const TARGETS")));
const targets = [...targetsBlock.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);

check(targets.length >= 3, `build.ts declares ${targets.length} targets`, targetsBlock.slice(0, 200));

for (const [cmd, rel] of Object.entries(pkg.bin ?? {}) as Array<[string, string]>) {
	const clean = rel.replace(/^\.\//, "");
	check(exists(clean), `bin "${cmd}" → ${clean} exists on disk`);
	// A handwritten .mjs needs no target; a generated one does. The ⚠️ GENERATED
	// banner is what tells them apart, and it is the repo's own existing marker.
	const generated = exists(clean) && /GENERATED/.test(fs.readFileSync(path.join(REPO, clean), "utf8").slice(0, 400));
	if (!generated) continue;
	const base = path.basename(clean, ".mjs");
	check(targets.includes(base),
		`bin "${cmd}" → ${base} is in build.ts TARGETS`,
		`generated artifact with no build target — \`bun run build\` will not produce it. Targets: ${targets.join(", ")}`);
}

// The generated/handwritten split is what decides whether a target is required, so
// it must not go blind in either direction: a classifier that called everything
// handwritten would skip every real check and still print all green.
check(/GENERATED/.test(fs.readFileSync(path.join(REPO, "bin/serve.mjs"), "utf8").slice(0, 400)),
	"the GENERATED banner is detected on a built artifact");
check(!/GENERATED/.test(fs.readFileSync(path.join(REPO, "bin/patch-pi-widgets.mjs"), "utf8").slice(0, 400)),
	"and absent on the handwritten bin — which is why it needs no target");

// ---
// 2 & 3. Skills cite skills, and skills cite paths.
// ---
console.log("\n— skills cite skills that exist");

const skillsDir = path.join(REPO, "skills");
const skills = fs.readdirSync(skillsDir).filter((d) =>
	fs.existsSync(path.join(skillsDir, d, "SKILL.md")),
);
check(skills.length > 0, `found ${skills.length} skills`);

const known = new Set(skills);
const badSkillRefs: string[] = [];
const badPathRefs: string[] = [];

// `skills/<name>` or `skills/<name>/` — an explicit reference to another skill.
const SKILL_REF = /skills\/([a-z0-9][a-z0-9-]*)\b/g;

// A repo-relative path in backticks. Anchored on the directories this repo actually
// has, so prose like `~/bin/pr-open` or a URL fragment is not mistaken for one.
const PATH_REF = /`((?:bin|extensions|docs|tests|research|skills|hooks|statusline)\/[A-Za-z0-9._/-]+)`/g;

for (const s of skills) {
	const rel = `skills/${s}/SKILL.md`;
	const src = fs.readFileSync(path.join(REPO, rel), "utf8");

	for (const m of src.matchAll(SKILL_REF)) {
		if (!known.has(m[1])) badSkillRefs.push(`${rel}: skills/${m[1]} — no such skill`);
	}
	for (const m of src.matchAll(PATH_REF)) {
		const cited = m[1].replace(/\/$/, "");
		// A glob or placeholder is a pattern, not a citation.
		if (/[*<]|\.\.\./.test(cited)) continue;
		if (!exists(cited)) badPathRefs.push(`${rel}: ${cited} — does not exist`);
	}
}

check(badSkillRefs.length === 0, "every skill-to-skill reference resolves", badSkillRefs.join("\n"));
check(badPathRefs.length === 0, "every repo path a skill cites exists", badPathRefs.join("\n"));

// The detectors must still SEE a violation.
check([..."`bin/does-not-exist.ts`".matchAll(PATH_REF)].length === 1,
	"the path detector still matches a backticked repo path");
check([..."skills/never-existed".matchAll(SKILL_REF)].length === 1,
	"the skill detector still matches a skills/ reference");

// ---
// 4. NOT checked here: whether ~/.claude/skills and ~/.pi/agent/skills match the
//    repo copy.
//
//    #230's test-steps asked for it and this suite deliberately does not deliver
//    it, because #345 already removed exactly this assertion for exactly this
//    reason: those directories are ONE per host, shared by every worktree, every
//    branch, and main. Any branch that legitimately edits a skill turns the check
//    red in every OTHER worktree, for a reason that has nothing to do with that
//    worktree's changes — and red for a correct state is how a suite gets ignored.
//
//    The question is real; it is a HOST-drift question, not a repo one, and it is
//    already owned twice over: `bin/install-workflow-tools --check` reports live
//    drift and writes nothing, and tests/skills-deploy.test.ts proves the fan-out
//    reaches both targets against a seeded temp $HOME.
// ---

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #230 references: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

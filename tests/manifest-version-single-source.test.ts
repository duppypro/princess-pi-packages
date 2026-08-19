// --- #347 / #134: a tool's version has exactly one source, and it is package.json ---
//
// tests/build-stamp.test.ts already proves each CLI's `--version` REPORTS
// package.json's semver. That is the symptom check, and it passes even while the
// defect is present: `wtft` matched package.json for a whole release cycle because
// someone happened to bump both files, not because anything made them agree.
//
// This suite checks the STRUCTURE instead — that a second copy cannot exist to
// drift:
//
//   1. no command manifest carries a `version` field, so a tool added later is
//      covered by construction rather than by someone remembering;
//   2. no source reads a version out of a manifest, including as a fallback.
//
// (2) is not pedantry. `renderWtftVersion` used to seed `semver` from
// `manifest.version` and overwrite it from package.json inside a try — so an
// unreadable package.json printed a stale number instead of failing. That is a
// wrong answer where an error belongs, and `--version` is precisely the command
// you run when you already suspect you are running the wrong build. The manifest
// keeps `name`, `tagline`, `description`, `examples`, `usage`: everything that
// describes the command rather than identifying the build.
//
// Run with: bun run test manifest-version-single-source

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

console.log("#347: one version source, and it is package.json");

// ---
// 1. The duplicate field does not exist anywhere.
// ---
console.log("\n— no manifest carries a version field");

const manifestDir = path.join(REPO, "docs", "manifests");
const manifests = fs.readdirSync(manifestDir).filter((f) => f.endsWith("-cmd.json"));
check(manifests.length >= 3, `found ${manifests.length} command manifests`);

for (const m of manifests) {
	const doc = JSON.parse(fs.readFileSync(path.join(manifestDir, m), "utf8"));
	check(!("version" in doc), `${m} has no version field`,
		`version: ${JSON.stringify(doc.version)} — delete it; package.json is the source`);
	// The fields that describe the COMMAND stay. Asserted so a later cleanup does
	// not read this suite as "manifests should be smaller".
	for (const keep of ["name", "tagline", "description", "examples", "usage"]) {
		check(keep in doc, `${m} still carries ${keep}`);
	}
}

// ---
// 2. Nothing reads a version out of a manifest — not as a primary, not as a
//    fallback. Scoped to the files that render --version.
// ---
console.log("\n— no source reads a version from a manifest");

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Every .ts under bin/ and extensions/, recursively. */
function sources(dir: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) sources(p, out);
		else if (e.name.endsWith(".ts")) out.push(p);
	}
	return out;
}

const MANIFEST_VERSION = /\bmanifest(?:Doc|Json)?\.version\b|\bversion\b\s*:\s*manifest\./;
const offenders: string[] = [];
for (const f of [...sources(path.join(REPO, "bin")), ...sources(path.join(REPO, "extensions"))]) {
	const code = stripComments(fs.readFileSync(f, "utf8"));
	if (MANIFEST_VERSION.test(code)) {
		offenders.push(path.relative(REPO, f));
	}
}
check(offenders.length === 0,
	"no source reads manifest.version",
	`${offenders.join("\n")}\n→ read package.json, resolved from import.meta.url (never process.cwd(): every node project has one, so a cwd-relative read prints a stranger's version instead of failing)`);

// The detector must still SEE a violation, or a regex that stopped matching would
// read as a clean codebase.
check(MANIFEST_VERSION.test("let semver = manifest.version;"),
	"the detector still catches a known-bad probe");
check(!MANIFEST_VERSION.test("const v = pkg.version;"),
	"a package.json read does not trip the detector");

// ---
// 3. The package.json read is resolved from the module, not the cwd — trap 1 in
//    the issue, and the one that fails QUIETLY rather than loudly.
// ---
console.log("\n— the package.json read is module-relative");

for (const rel of ["bin/yada.ts", "extensions/lib/wtft-cli-shared.ts", "extensions/serve.ts"]) {
	const code = stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));
	const pkgReads = code.includes("package.json");
	if (!pkgReads) continue;
	check(/fileURLToPath\((?:import\.meta\.url|moduleUrl)\)/.test(code),
		`${rel} resolves package.json from import.meta.url`,
		"a process.cwd()-relative read finds a stranger's package.json and prints its version");
	check(!/path\.join\(\s*process\.cwd\(\)[^)]*package\.json/.test(code),
		`${rel} does not resolve package.json from process.cwd()`);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #347: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

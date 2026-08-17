// ---
// #178: "which build am I actually running?"
//
// `bun link` and `install-workflow-tools` put ONE copy of each CLI on PATH,
// resolved into the main clone. Running `wtft` from a feature worktree
// therefore executes main's build — silently — so a branch can never exercise
// its own CLI change by using the CLI. This module makes the running artifact
// name itself instead of leaving that a thing you have to remember.
//
// WHY A SIDECAR FILE, NOT A CONSTANT BAKED INTO bin/*.mjs:
// the .mjs bundles are COMMITTED, and tests/build-staleness-gate.test.ts
// asserts that a fresh build leaves `git diff --exit-code -- bin/` empty. A
// value that changed on every build would fail that gate permanently. And
// baking HEAD's sha is impossible in principle, not just awkward: the file
// carrying the sha becomes part of the NEXT commit, whose sha is by definition
// different, so a clean rebuild would never reproduce the committed bytes.
// The sidecar sidesteps both — it is gitignored, so builds never dirty a
// tracked artifact, and pacote honours .gitignore, so it stays out of the npm
// tarball. That last part is correct rather than merely convenient: a released
// package's identity is its semver, while the stamp answers "which working
// tree built this", a question only a working tree can have.
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildStamp {
	/** Short HEAD sha of the tree that ran the build. */
	sha: string;
	/** Whether that tree had uncommitted changes at build time. */
	dirty: boolean;
	/** Builds at this sha with a dirty tree, 0-based; resets when sha changes. */
	dev: number;
	/** Absolute path of the repo root that produced this build. */
	builtFrom: string;
}

/** Sidecar lives beside the built artifact: bin/build-stamp.json. */
export const STAMP_BASENAME = "build-stamp.json";

/**
 * Read the stamp deposited next to the calling module, or null when there is
 * none (a released install, or unbuilt .ts source).
 *
 * Deliberately tolerant: a malformed or unreadable stamp reports as ABSENT
 * rather than throwing. `--version` is the command you run when something is
 * already confusing; it must never be the thing that fails.
 */
export function readBuildStamp(moduleUrl: string): BuildStamp | null {
	try {
		const dir = path.dirname(fileURLToPath(moduleUrl));
		const raw = fs.readFileSync(path.join(dir, STAMP_BASENAME), "utf8");
		const s = JSON.parse(raw) as BuildStamp;
		if (typeof s.sha !== "string" || typeof s.builtFrom !== "string") return null;
		return s;
	} catch {
		return null;
	}
}

/**
 * The version suffix for a stamp: "+<sha>" clean, "+<sha>-dev-<n>" dirty.
 * Exported for tests, which assert the shape without spawning a CLI.
 */
export function stampSuffix(stamp: BuildStamp): string {
	return stamp.dirty ? `+${stamp.sha}-dev-${stamp.dev}` : `+${stamp.sha}`;
}

/**
 * Full `--version` output. One fact per line, `key value`, no decoration —
 * the Agent-First rule: another program reads this, so the first token of each
 * line is a stable key and rewording the prose is not a breaking change.
 *
 *   serve 1.1.0+8aa37d3-dev-2
 *   path /home/.../worktrees/178-version-stamp/bin/serve.mjs
 *   built-from /home/.../worktrees/178-version-stamp
 *
 * `path` is the half that answers #178 with no comparison step — it says
 * outright whether you are running the worktree's build or the main clone's.
 * It is emitted ALWAYS, including when there is no stamp at all.
 */
export function formatVersion(toolName: string, semver: string, moduleUrl: string): string {
	let self: string;
	try {
		// realpath, because ~/bin copies may be symlinks into a clone and the
		// real location is the entire point of printing it.
		self = fs.realpathSync(fileURLToPath(moduleUrl));
	} catch {
		self = fileURLToPath(moduleUrl);
	}

	const stamp = readBuildStamp(moduleUrl);
	const lines: string[] = [];

	if (stamp) {
		lines.push(`${toolName} ${semver}${stampSuffix(stamp)}`);
	} else if (self.endsWith(".ts")) {
		// Unbuilt source — the Pi extension path. Say so rather than imply a
		// build that never happened.
		lines.push(`${toolName} ${semver}+source`);
	} else {
		// Built, but no sidecar: a released/installed copy. semver alone is the
		// honest answer there.
		lines.push(`${toolName} ${semver}`);
	}

	lines.push(`path ${self}`);
	if (stamp) lines.push(`built-from ${stamp.builtFrom}`);

	return lines.join("\n");
}

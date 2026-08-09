// ---
// research/156-cwd-resolution-probe.mjs — measures the tail-scan cwd resolver (#156)
//
// Why: the session selector builds ONE project-dir slug from cwd, so a session
// whose cwd moved (worktree enter, or an ordinary `cd` into a subdir) is
// invisible. This probe checks the claim in #156 that every transcript carries
// its own cwd near the tail, and that resolving all of them is cheap enough to
// run on every selector invocation.
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");
const TAILS = [8 * 1024, 64 * 1024, 512 * 1024];

let bytesRead = 0;

function resolveLastCwd(file, size) {
	for (const window of TAILS) {
		const start = Math.max(0, size - window);
		const len = size - start;
		if (len <= 0) return null;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, start);
		fs.closeSync(fd);
		bytesRead += len;
		const lines = buf.toString("utf8").split("\n");
		// Drop a possibly-truncated first line when we did not read from byte 0.
		if (start > 0) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			const l = lines[i].trim();
			if (!l) continue;
			try {
				const e = JSON.parse(l);
				if (typeof e.cwd === "string" && e.cwd) return e.cwd;
			} catch { /* partial / non-JSON */ }
		}
		if (start === 0) return null; // whole file scanned, no cwd
	}
	return null;
}

const t0 = process.hrtime.bigint();
let files = 0, resolved = 0, mismatched = 0;
const mismatches = [];
for (const dir of fs.readdirSync(PROJECTS)) {
	const full = path.join(PROJECTS, dir);
	if (!fs.statSync(full).isDirectory()) continue;
	for (const f of fs.readdirSync(full)) {
		if (!f.endsWith(".jsonl")) continue;
		const p = path.join(full, f);
		const st = fs.statSync(p);
		files++;
		const cwd = resolveLastCwd(p, st.size);
		if (!cwd) continue;
		resolved++;
		if (cwd.replace(/[/\\]/g, "-") !== dir) {
			mismatched++;
			mismatches.push(`  MISMATCH ${f.slice(0, 8)}  dir=${dir}  cwd=${cwd}`);
		}
	}
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`files=${files}  resolved=${resolved}  mismatched=${mismatched}  read=${(bytesRead / 1e6).toFixed(1)}MB  elapsed=${ms.toFixed(0)}ms`);
for (const m of mismatches) console.log(m);

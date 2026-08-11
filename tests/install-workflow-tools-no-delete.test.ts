// install-workflow-tools: the installer must not delete anything (#235)
//
// Direction B (Duppy, 2026-08-11): the installer stops mutating anything it
// did not install, but reports stale workflow tools it finds on PATH instead
// of silently disappearing them. Drives the REAL bin/install-workflow-tools
// against a throwaway $HOME, because the property under test — "does this
// script rm anything" — cannot be verified without actually running it.
//
// Run with: bun run test install-workflow-tools-no-delete

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTALLER = path.join(REPO_ROOT, "bin", "install-workflow-tools");
const MANAGED_SCRIPTS = ["git-checkpoint", "git-overview", "pr-open", "pr-merge", "pr-reject", "pr-cleanup", "pr-threads"];

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

function freshHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "iwt-home-"));
}

function run(home: string): { code: number; out: string } {
	let code = 0;
	let out = "";
	try {
		out = execFileSync("bash", [INSTALLER], {
			encoding: "utf8",
			env: { ...process.env, HOME: home },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: any) {
		code = err?.status ?? -1;
		out = `${err?.stdout || ""}${err?.stderr || ""}`;
	}
	return { code, out };
}

console.log("install-workflow-tools: removes nothing, reports stale tools (#235)");

// 1. Seed $HOME/bin with two known-stale names and one unrelated file. The
//    unrelated file is the important assertion: it proves the installer's
//    blast radius is bounded to names it knows about, not "everything here".
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "merge"), "#!/bin/sh\necho old\n");
	fs.writeFileSync(path.join(bin, "git-ship"), "#!/bin/sh\necho old\n");
	fs.writeFileSync(path.join(bin, "my-unrelated-tool"), "#!/bin/sh\necho mine\n");

	const { code, out } = run(home);

	check(code === 0, "installer exits 0 with stale tools present", `got ${code}, out:\n${out}`);
	check(fs.existsSync(path.join(bin, "merge")), "stale 'merge' still exists after install", out);
	check(fs.existsSync(path.join(bin, "git-ship")), "stale 'git-ship' still exists after install", out);
	check(fs.existsSync(path.join(bin, "my-unrelated-tool")), "unrelated file untouched", out);
	for (const script of MANAGED_SCRIPTS) {
		check(fs.existsSync(path.join(bin, script)), `managed script '${script}' was installed`, out);
	}
}

// 2. Report fires: a stale tool present is named in the output, and its
//    presence doesn't turn a successful install into a failure.
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "merge"), "#!/bin/sh\necho old\n");

	const { code, out } = run(home);

	check(code === 0, "stale tool present → exit status still 0 (a report is not a failure)", `got ${code}`);
	check(/merge/.test(out) && /stale/i.test(out), "stale 'merge' is named in the report", out);
}

// 3. Fresh machine: empty $HOME/bin, clean install, no report lines at all.
{
	const home = freshHome();
	fs.mkdirSync(path.join(home, "bin"), { recursive: true });

	const { code, out } = run(home);

	check(code === 0, "fresh machine → exit 0", `got ${code}`);
	check(!/stale/i.test(out), "fresh machine → no stale-tool report lines", out);
}

// 4. Idempotent: running twice against the same $HOME changes nothing further
//    and produces the same result both times.
{
	const home = freshHome();
	const bin = path.join(home, "bin");
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, "post-merge-cleanup"), "#!/bin/sh\necho old\n");

	const first = run(home);
	const before = fs.readdirSync(bin).sort();
	const second = run(home);
	const after = fs.readdirSync(bin).sort();

	check(first.code === 0 && second.code === 0, "idempotent: exit 0 both runs", `${first.code}, ${second.code}`);
	check(JSON.stringify(before) === JSON.stringify(after), "idempotent: $HOME/bin contents unchanged between runs", `${before.join(",")} vs ${after.join(",")}`);
}

console.log(`\n${failures === 0 ? "✅" : "❌"} install-workflow-tools no-delete: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

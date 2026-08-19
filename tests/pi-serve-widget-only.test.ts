// --- #226 / ADR 0004: the Pi serve extension keeps the widget and nothing else ---
//
// The shell-first decision has two halves. `/merge` was the easy one: the tool
// needed nothing from the harness, so the whole extension went (see
// pi-merge-retired.test.ts). `serve` is the hard one, because the answer is
// split — the **widget** genuinely needs harness state (`ctx.ui.setWidget`, a
// session-lifetime tick subscription, per-session visibility), and the
// **command** needs nothing but a shell.
//
// So this suite pins the seam rather than a deletion. Everything that starts,
// kills, registers, or publishes a server lives in exactly one place —
// `bin/serve.ts` — and is reached as `!serve`. The extension may read (the
// widget has to know what is running) and may write session/widget state. It may
// not act on the world.
//
// Why structural: a Pi command handler cannot be invoked without a live harness,
// so the only thing a test can pin here is the shape of the surface. The import
// list is the honest subject — a handler cannot start a server it has no way to
// reach.
//
// Run with: bun run test pi-serve-widget-only

import * as fs from "node:fs";
import * as path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const EXT = path.join(REPO, "extensions", "serve.ts");
const CLI = path.join(REPO, "bin", "serve.ts");

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

// Comments carry the history of what this file used to do — including the names
// of every handler that was deleted. Strip them, or the suite fails on its own
// explanation of why they are gone.
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const extSrc = fs.readFileSync(EXT, "utf8");
const extCode = stripComments(extSrc);
const cliCode = stripComments(fs.readFileSync(CLI, "utf8"));

console.log("#226 / ADR 0004: serve keeps the widget, the command is !serve");

// ---
// 1. The extension still exists and still owns the widget. This is the half the
//    ADR's "does it need harness state?" test answers YES for, and deleting it
//    would be over-applying the decision.
// ---
console.log("\n— the widget survives, because it needs the harness");

check(/pi\.on\(\s*["'`]session_start["'`]/.test(extCode), "subscribes to session_start");
check(/ctx\.ui\.setWidget|updateWidget\(/.test(extCode), "drives the serve-ports widget");
check(/registerCommand\(\s*["'`]serve["'`]/.test(extCode),
	"still registers a `serve` command — the widget controls need a door");

// ---
// 2. The command face cannot act on the world, because it cannot reach the code
//    that does. Import-list assertions, not handler-name assertions: a handler
//    is easy to rename, an import is what actually grants the capability.
// ---
console.log("\n— the command face cannot start, stop, or publish anything");

const FORBIDDEN_IMPORTS = [
	"findFreePort",
	"settleStartedServers",
	"killServerInstance",
	"scanUnclaimedServerLike",
	"registerServer",
	"unregisterPort",
	"setRecordSubdomain",
	"verifyRecord",
	"publishSubdomain",
	"unpublishSubdomain",
	"reapOrphans",
	"parseAclFile",
];
const importBlock = extCode.slice(0, extCode.indexOf("export default"));
for (const name of FORBIDDEN_IMPORTS) {
	check(!new RegExp(`\\b${name}\\b`).test(importBlock),
		`does not import ${name}`, importBlock.split("\n").filter((l) => l.includes(name)).join("\n"));
}

// The capability itself, not just the named helpers: an extension that spawns no
// child process cannot start a server by any route it invents later.
check(!/from\s+["'`]node:child_process["'`]/.test(extCode),
	"imports nothing from node:child_process",
	extCode.split("\n").filter((l) => l.includes("child_process")).join("\n"));

// ---
// 3. The retired routes are gone from the dispatch table. Weaker than the import
//    check on its own — a route with no handler behind it is harmless — but it is
//    what a reader scanning the file sees first, so it should not lie.
// ---
console.log("\n— the retired routes are gone from the dispatch table");

for (const flag of ["--kill", "--cancel", "--off", "--unpub", "--list"]) {
	check(!extCode.includes(`"${flag}"`) && !extCode.includes(`${flag}|`),
		`no ${flag} route`, extCode.split("\n").filter((l) => l.includes(flag)).join("\n"));
}

// ---
// 4. A Pi user who types the old thing is told the new thing. A surface that
//    silently does nothing is worse than the duplication it replaced.
// ---
console.log("\n— the old invocation is answered, not ignored");

check(/!serve/.test(extSrc), "the source names `!serve` as the replacement");

// The shutdown reminder lists servers filtered to THIS REPO, so the command it
// offers has to be scoped the same way. `--kill all` is not: it iterates every
// server in the registry, so a reminder about three servers here would stop a
// preview running for something else entirely. Caught by macroscopeapp on PR #374
// against bin/serve.ts's handleKill; the scope mismatch is invisible in the
// reminder's own text, which is why it needs a pin rather than a careful reader.
check(!/--kill all/.test(extCode),
	"no `--kill all` in the extension — the reminder names the ports it listed",
	extCode.split("\n").filter((l) => l.includes("--kill")).join("\n"));
check(/--kill \$\{killTargets\}|killTargets/.test(extCode),
	"the reminder builds its kill targets from the repo-filtered list");

// ---
// 5. The capability did not vanish — it consolidated. `bin/serve.ts` is the one
//    implementation, and this check is what separates "moved" from "lost".
// ---
console.log("\n— bin/serve.ts still owns the full surface");

for (const [name, re] of [
	["kill", /killServerInstance/],
	["start", /findFreePort|settleStartedServers/],
	["registry", /registerServer/],
	["publish", /publishSubdomain/],
] as Array<[string, RegExp]>) {
	check(re.test(cliCode), `bin/serve.ts still implements ${name}`);
}

// ---

console.log(`\n${failures === 0 ? "✅" : "❌"} #226 serve: ${checks - failures} of ${checks} checks passed.`);
process.exit(failures > 0 ? 1 : 0);

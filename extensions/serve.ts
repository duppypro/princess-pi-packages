// ---
// The Pi face of `serve` — the WIDGET, and nothing else.
//
// ADR 0004 (#226) is shell-first: a workflow tool gets a Pi `/command` face only
// where it needs something the harness alone can give. `serve` splits down that
// line. The widget needs `ctx.ui.setWidget`, a session-lifetime tick
// subscription, and per-session visibility state — none of which a shell script
// can reach. Starting, killing, listing, and publishing a server need a
// filesystem, a process table, and an HTTP client, all of which bash has.
//
// So the command surface lives in `bin/serve.ts` and is invoked as `!serve`.
// This file may READ what is running (the widget has to know) and may write
// widget/session state. It may not act on the world — which is enforced by what
// it is allowed to import, not by discipline: see
// tests/pi-serve-widget-only.test.ts.
//
// What that deleted: handleStart, handleKill, handleUnpub, handleList — ~350
// lines that duplicated `bin/serve.ts` and were the reason the two faces could
// drift. `/merge` is what drift looks like when nobody is watching (ADR 0004
// § Context).
//
// Compatibility note: this extension targets Pi Coding Agent's runtime API
// (pi.registerCommand, pi.on lifecycle events, ctx.ui.setWidget) — these have
// no equivalent in other agent harnesses. Claude Code, for example, uses a
// different model entirely: markdown-based skills instead of programmatic
// command handlers, declarative hooks instead of in-process event listeners,
// and no persistent multi-line widget surface (only a single-line status bar).
// ---
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isInsideRepo } from "./lib/serve/domain.js";
import { discoverServers } from "./lib/serve/process.js";
import { getVisibility } from "./lib/serve/store.js";
import { writeConfig } from "./lib/config.js";
import { updateWidget, formatServerTable } from "./lib/serve/tui.js";
import { formatVersion } from "./lib/build-stamp.ts";

// Track widget visibility state locally (persisted across reloads via session log)
let isWidgetVisible = true;

// Active instance tracking to self-prune leaked event bus listeners across reloads
let activeInstanceId = "";

export default function serveExtension(pi: ExtensionAPI) {
	const myInstanceId = Math.random().toString(36).substring(2, 11);
	activeInstanceId = myInstanceId;

	let unsubscribeTick: (() => void) | null = null;

	// 1. Auto-discover on session start, restore visibility state, and hook into central refresher service
	pi.on("session_start", async (_event, ctx) => {
		isWidgetVisible = getVisibility(ctx);
		const servers = await discoverServers();

		updateWidget(ctx, servers, isWidgetVisible);

		// Subscribe to the centralized refresher tick event
		unsubscribeTick = pi.events.on("clock:tick:4s", async () => {
			if (activeInstanceId !== myInstanceId) {
				// Self-prune: We are a leaked, stale listener from a previous reload
				if (unsubscribeTick) unsubscribeTick();
				return;
			}

			if (!isWidgetVisible) {
				ctx.ui.setWidget("serve-ports", undefined);
				return;
			}
			const currentServers = await discoverServers();
			updateWidget(ctx, currentServers, isWidgetVisible);
		});
	});

	// 2. Display persistent active server list reminder on `/quit` / exit
	pi.on("session_shutdown", async (_event, ctx) => {
		// Clean up the global event listener to prevent event listener leaks on reload
		if (unsubscribeTick) {
			unsubscribeTick();
			unsubscribeTick = null;
		}

		const allServers = await discoverServers();
		const repoServers = allServers.filter(s => isInsideRepo(s.dir, process.cwd()));
		if (repoServers.length > 0) {
			const tableText = formatServerTable(repoServers);

			// The ports of the servers ACTUALLY LISTED above, never `--kill all`.
			// The list is filtered to this repo; `--kill all` is not — it iterates
			// every server in the registry, so a reminder about three servers here
			// would stop a preview running for something else entirely
			// (macroscopeapp on PR #374, verified against bin/serve.ts's handleKill).
			const killTargets = repoServers.map(s => s.port).join(" ");

			console.log(
				`\n\x1b[1m\x1b[33m⚠️  REMINDER: You have active background servers running in this repository:\x1b[0m\n\n` +
				tableText + `\n\n` +
				`\x1b[33mThese servers will remain active during your "pause". To stop these ones, run:\x1b[0m\n` +
				`  \x1b[1m!serve --kill ${killTargets}\x1b[0m\n`
			);
		}
	});

	// --- Command handlers: widget state, and the pointer to the real tool ---

	// The manifest is the single source for both faces' help text, so this stays
	// manifest-driven (docs/agents/tool-conventions.md) — but it renders under a
	// banner, because /serve no longer answers most of what the manifest lists.
	// Printing the full flag table with no banner would teach the retired surface.
	async function handleHelp(ctx: any): Promise<void> {
		try {
			const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

			let helpText = `\x1b[1m\x1b[36m${manifest.name}\x1b[0m (Pi widget) - ${manifest.tagline}\n\n`;
			helpText += `${WIDGET_ONLY_BANNER}\n\n`;
			helpText += `\x1b[1mWidget controls (this command):\x1b[0m\n`;
			for (const u of WIDGET_FLAGS) {
				helpText += `  /serve ${u.flags.padEnd(24)} ${u.desc}\n`;
			}
			helpText += `\n\x1b[1mEverything else (shell):\x1b[0m\n`;
			for (const e of manifest.examples) {
				const fullCmd = e.args ? `!serve ${e.args}` : "!serve";
				helpText += `  ${fullCmd.padEnd(30)} ${e.desc}\n`;
			}
			helpText += `\n  !serve --help                  the full flag table\n`;

			ctx.ui.notify(helpText, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to load command manifest: ${err}`, "error");
		}
	}

	// #134: version comes from package.json ONLY (mirrors bin/serve.ts's handleVersion
	// for the standalone CLI) — the manifest's own "version" field was a second,
	// never-bumped copy that let two different builds report identical version strings.
	//
	// Resolved from THIS file's location, not process.cwd(). The manifest read that
	// used to live here was cwd-relative, which was already wrong but failed LOUDLY
	// ("Failed to load command manifest") whenever Pi ran outside the repo. Reading
	// package.json cwd-relative would fail quietly instead: any other node project
	// has a package.json, so serve would print that project's version as its own —
	// a wrong answer where there used to be an error, which is the worse trade.
	async function handleVersion(ctx: any): Promise<void> {
		try {
			const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
			ctx.ui.notify(formatVersion("serve", pkg.version, import.meta.url), "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to read package version: ${err}`, "error");
		}
	}

	async function handleWhy(ctx: any): Promise<void> {
		try {
			const { renderWhy } = await import("./lib/manifest-help.js");
			const manifestPath = path.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
			const whyText = renderWhy(manifestPath, "!serve");
			ctx.ui.notify(whyText, "info");
		} catch (err) {
			ctx.ui.notify(`⚠️ Failed to load command manifest: ${err}`, "error");
		}
	}

	async function handleHide(ctx: any): Promise<void> {
		isWidgetVisible = false;
		writeConfig("serve", { visible: false });
		updateWidget(ctx, [], isWidgetVisible);
		ctx.ui.notify("Active server list widget hidden.", "info");
	}

	async function handleShow(ctx: any): Promise<void> {
		isWidgetVisible = true;
		writeConfig("serve", { visible: true });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible);

		if (servers.length > 0) {
			ctx.ui.notify(`Discovered and displaying ${servers.length} active servers.`, "info");
		} else {
			ctx.ui.setWidget("serve-ports", undefined);
			ctx.ui.notify("No active servers found to display.", "warning");
		}
	}

	async function handleEmojiToggle(enabled: boolean, ctx: any): Promise<void> {
		writeConfig("serve", { emojiDisabled: !enabled });
		const servers = await discoverServers();
		updateWidget(ctx, servers, isWidgetVisible);
		const statusText = enabled ? "enabled" : "disabled";
		ctx.ui.notify(`Emoji icons in widgets have been ${statusText}.`, "info");
	}

	// Anything this command no longer answers is REFUSED with the shell spelling,
	// never silently ignored (#226 step 2 — the same treatment /merge got). A
	// surface that accepts an argument and does nothing is worse than the
	// duplication it replaced: the user believes a server started.
	async function handleRetired(trimmedArgs: string, ctx: any): Promise<void> {
		ctx.ui.notify(
			`/serve no longer starts, stops, lists, or publishes servers — that is one` +
			` implementation now, in the shell (ADR 0004).\n\n` +
			`  Run: \x1b[1m!serve ${trimmedArgs}\x1b[0m\n\n` +
			`/serve still owns the widget: --hide, --show, --emoji, --no-emoji.`,
			"warning",
		);
	}

	// --- Dispatch table: every route here writes widget or session state, which is
	// the whole justification for this command still existing. Anything else falls
	// through to handleRetired.
	const routes: { test: (args: string) => boolean; handler: (args: string, ctx: any) => Promise<void> }[] = [
		{ test: (a) => a === "--help" || a === "-h", handler: (_a, ctx) => handleHelp(ctx) },
		{ test: (a) => a === "--version", handler: (_a, ctx) => handleVersion(ctx) },
		{ test: (a) => a === "--why", handler: (_a, ctx) => handleWhy(ctx) },
		{ test: (a) => a === "--hide" || a === "-H", handler: (_a, ctx) => handleHide(ctx) },
		{ test: (a) => a === "--show" || a === "-S", handler: (_a, ctx) => handleShow(ctx) },
		{ test: (a) => a === "--no-emojii" || a === "--no-emoji", handler: (_a, ctx) => handleEmojiToggle(false, ctx) },
		{ test: (a) => a === "--emojii" || a === "--emoji", handler: (_a, ctx) => handleEmojiToggle(true, ctx) },
	];

	// 3. Define the /serve command — widget controls only.
	pi.registerCommand("serve", {
		description: "Show/hide the active-server widget (start and stop servers with !serve — ADR 0004)",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const route = routes.find(r => r.test(trimmedArgs));
			if (route) {
				await route.handler(trimmedArgs, ctx);
			} else {
				await handleRetired(trimmedArgs, ctx);
			}
		}
	});
}

const WIDGET_ONLY_BANNER =
	"This command is the WIDGET only. Servers are started, stopped, listed and\n" +
	"published with \x1b[1m!serve\x1b[0m — one implementation, in the shell (ADR 0004).";

const WIDGET_FLAGS = [
	{ flags: "--hide, -H", desc: "hide the active-server widget" },
	{ flags: "--show, -S", desc: "show it again, refreshed" },
	{ flags: "--emoji / --no-emoji", desc: "toggle emoji icons in the widget" },
	{ flags: "--help, --version, --why", desc: "this text, the running version, the rationale" },
];

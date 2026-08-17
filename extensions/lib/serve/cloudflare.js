/**
 * @module cloudflare
 * @description Phase 6B (#66): per-subdomain preview automation via the Cloudflare API.
 * Replaces the retired `nginx.js` (map writes + `sudo nginx -s reload`). Instead of
 * touching /etc or sudo, serve programs the edge directly:
 *   - upserts a tunnel INGRESS rule  `<label>.princess-pi.dev -> http://127.0.0.1:<port>`
 *     through the remote-managed tunnel configuration (no local config.yml, no reload),
 *   - upserts a per-subdomain Access APPLICATION + Allow policy carrying the `.serve-acl`
 *     email allow-list (per-subdomain app = hard isolation; client A's reviewer can't reach B).
 *
 * WHAT THE ISOLATION IS AND IS NOT (#329): the allow-list isolates; the login prompt does not.
 * Cloudflare authenticates ONCE PER ACCOUNT — the identity session lives on the team domain
 * (`princess-pi.cloudflareaccess.com`, ~24h), not on the hostname — so a visitor already signed
 * in to ANY preview opens a brand-new one with no challenge, and only the per-app policy below
 * decides whether they get in. Consequence for anyone testing this code: a gate can never be
 * verified from a signed-in browser. Use `curl -sI https://<label>.princess-pi.dev/` and expect
 * a 302 to cloudflareaccess.com. See `docs/serve-standard.md` §7.6 / §8.7 / §8.8.
 *
 * WHY a whole new module and not an edit of nginx.js: the failure modes are disjoint —
 * nginx.js failed on filesystem/sudo, this fails on HTTP/token/lock. Keeping them as
 * separate files makes the 6A→6B swap legible in history (nginx.js deleted, cloudflare.js
 * added) and keeps the CF surface in one place.
 *
 * Trust/secret note: the credential lives in `~/.config/princess-pi/cf.env` (0600). A leak
 * = control of all tunnel ingress + every client's allow-list — smaller blast radius than
 * the root-sudo grant 6A deleted, but NOT "no standing privilege". Stated plainly in the
 * runbook; this module only reads the token, never logs it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { execSync } from "node:child_process";

// ---
// Config / constants
// ---
const CONFIG_DIR = path.join(os.homedir(), ".config", "princess-pi");
const CF_ENV_PATH = path.join(CONFIG_DIR, "cf.env");
const LOCK_PATH = path.join(CONFIG_DIR, "tunnel-config.lock");
const CF_API = "https://api.cloudflare.com/client/v4";
const ZONE_SUFFIX = "princess-pi.dev";

// Subdomain→port map persisted across restarts so discovery can show the public URL
// even for servers that were published after start (#119).
const SERVE_CONFIG_DIR = path.join(os.homedir(), ".config", "princess-pi-packages", "serve");
const SUBDOMAIN_MAP_PATH = path.join(SERVE_CONFIG_DIR, "subdomains.json");

export function readSubdomainMap() {
	try {
		if (fs.existsSync(SUBDOMAIN_MAP_PATH)) {
			return JSON.parse(fs.readFileSync(SUBDOMAIN_MAP_PATH, "utf8"));
		}
	} catch { /* corrupt or missing — start fresh */ }
	return {};
}

function writeSubdomainMap(port, subdomain) {
	const map = readSubdomainMap();
	const arr = map[String(port)] || [];
	if (!arr.includes(subdomain)) arr.push(subdomain);
	map[String(port)] = arr;
	fs.mkdirSync(SERVE_CONFIG_DIR, { recursive: true });
	fs.writeFileSync(SUBDOMAIN_MAP_PATH, JSON.stringify(map), "utf8");
}

function removeSubdomainFromMap(subdomain) {
	const map = readSubdomainMap();
	for (const [port, subdomains] of Object.entries(map)) {
		const arr = subdomains.filter(s => s !== subdomain);
		if (arr.length === 0) delete map[port];
		else map[port] = arr;
	}
	fs.writeFileSync(SUBDOMAIN_MAP_PATH, JSON.stringify(map), "utf8");
}

// Access apps serve owns are named `serve <label>`. Reaping touches ONLY these — an app
// serve did not create (e.g. a hand-made one) is never deleted, and its hostname is a
// reserved-label collision (refuse to publish onto it).
const APP_PREFIX = "serve ";

// Fail-closed backstop. Used ONLY when the live zone read fails: if we cannot enumerate the
// real records we must not publish onto a name that might be infra, so we refuse anything in
// this minimal set and refuse publication entirely (see checkLabelAvailable). The live zone
// is the real source of truth — a hand-maintained denylist drifts.
const FALLBACK_RESERVED = new Set(["www", "mail", "logger", "preview", "apex", "ns1", "ns2", "_dmarc", "_domainkey"]);

// Lock acquisition: how long to keep retrying, and treat-as-stale age.
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

// ---
// .serve-acl parsing (ported verbatim-in-spirit from the retired nginx.js — pure file I/O,
// no nginx/sudo). Auto-seeds a local .serve-acl from a global default (or git email), makes
// sure `.serve-acl` is globally gitignored, and returns the validated email allow-list.
// The 6A teardown left this validation dormant; 6B makes it live again as the Access source.
// ---
/**
 * @param {string} targetDir
 * @returns {string[]} validated emails (throws on missing/empty/invalid)
 */
export function parseAclFile(targetDir) {
	// 1. Ensure .serve-acl is globally ignored so a client's allow-list never gets committed.
	const homeDir = os.homedir();
	const gitIgnoreDir = path.join(homeDir, ".config", "git");
	const gitIgnorePath = path.join(gitIgnoreDir, "ignore");
	try {
		if (!fs.existsSync(gitIgnoreDir)) fs.mkdirSync(gitIgnoreDir, { recursive: true });
		let ignoreContent = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, "utf8") : "";
		if (!ignoreContent.includes(".serve-acl")) {
			const sep = ignoreContent.endsWith("\n") || ignoreContent === "" ? "" : "\n";
			fs.appendFileSync(gitIgnorePath, `${sep}.serve-acl\n`);
		}
	} catch {
		// non-fatal: if we can't write the global ignore, still proceed.
	}

	const aclPath = path.join(targetDir, ".serve-acl");

	// 2. Auto-seed .serve-acl if missing (global default file → git email → hardcoded).
	if (!fs.existsSync(aclPath)) {
		const configDir = path.join(homeDir, ".config", "princess-pi");
		const defaultAclPath = path.join(configDir, "default-acl");
		let defaultEmails = [];
		if (fs.existsSync(defaultAclPath)) {
			try {
				defaultEmails = fs.readFileSync(defaultAclPath, "utf8")
					.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
			} catch {}
		}
		if (defaultEmails.length === 0) {
			let gitEmail = "";
			try { gitEmail = execSync("git config --get user.email", { encoding: "utf8" }).trim(); } catch {}
			if (!gitEmail || !gitEmail.includes("@")) gitEmail = "david@princess-pi.dev";
			defaultEmails = [gitEmail];
			try {
				if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
				fs.writeFileSync(defaultAclPath, `# Global default ACL for /serve\n${gitEmail}\n`, "utf8");
			} catch {}
		}
		try {
			const localContent = [
				"# Local Access Control List for /serve",
				"# Emails allowed through Cloudflare Access for this sub-domain. One entry per line:",
				"#   alice@example.com   — a single address",
				"#   @example.com        — every address at a whole domain",
				...defaultEmails,
			].join("\n") + "\n";
			fs.writeFileSync(aclPath, localContent, "utf8");
		} catch (err) {
			throw new Error(`Failed to auto-seed local .serve-acl file in "${targetDir}": ${err.message}`);
		}
	}

	const content = fs.readFileSync(aclPath, "utf8");
	const emails = [];
	for (const line of content.split(/\r?\n/)) {
		const hashIdx = line.indexOf("#");
		const cleaned = (hashIdx !== -1 ? line.substring(0, hashIdx) : line).trim();
		if (!cleaned) continue;
		// A leading '@' marks a whole-domain rule (`@roguelivestock.com` = every address at
		// that domain → a Cloudflare `email_domain` Include). Kept verbatim with the '@' so
		// upsertAccessApp can tell domain from address; the domain part must have a dot and
		// no second '@'. Anything else must be a valid-shaped individual address.
		if (cleaned.startsWith("@")) {
			const domain = cleaned.slice(1);
			if (domain.includes(".") && !domain.includes("@")) emails.push(cleaned);
			else throw new Error(`Invalid domain rule found in .serve-acl: "${cleaned}"`);
		} else if (cleaned.includes("@") && cleaned.includes(".")) {
			emails.push(cleaned);
		} else {
			throw new Error(`Invalid email address found in .serve-acl: "${cleaned}"`);
		}
	}
	if (emails.length === 0) throw new Error("The .serve-acl file must contain at least one valid email address or @domain rule.");
	return emails;
}

// ---
// Subdomain → DNS label. Cloudflare hostname labels are a strict subset of what a client sub-domain can
// be (a path basename). Lowercase, non-[a-z0-9-] → '-', collapse repeats, trim leading/
// trailing '-', cap at 63 chars (DNS label limit). Deterministic so the same dir always
// maps to the same hostname across start/kill/reap.
// ---
/**
 * @param {string} subdomain
 * @returns {string} a valid single DNS label
 */
/** The public hostname `serve` publishes a sub-domain at — one place, so callers never assemble it. */
export function subdomainToHostname(subdomain) {
	return `${flattenSubdomainToLabel(subdomain)}.${ZONE_SUFFIX}`;
}

export function flattenSubdomainToLabel(subdomain) {
	let label = String(subdomain)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, ""); // a trailing '-' could reappear after the 63-char slice
	if (!label) throw new Error(`Sub-domain "${subdomain}" flattens to an empty DNS label.`);
	return label;
}

// ---
// Credential loading. cf.env is a simple KEY=VALUE file (0600). Absent/unreadable throws a
// clear, actionable error — serve.ts catches it and still starts the loopback origin (the
// preview just isn't published to the edge). We do NOT hard-fail the whole `serve` on a
// missing token.
// ---
/**
 * @param {string} [envPath] override for tests; defaults to ~/.config/princess-pi/cf.env
 * @returns {{token:string, accountId:string, zoneId:string, tunnelId:string}}
 */
export function loadCfEnv(envPath = CF_ENV_PATH) {
	let raw;
	try {
		raw = fs.readFileSync(envPath, "utf8");
	} catch (err) {
		throw new Error(
			`Cloudflare token file not found or unreadable at ${envPath} (${err.code || err.message}). ` +
			`Create it (0600) with CF_API_TOKEN / CF_ACCOUNT_ID / CF_ZONE_ID / CF_TUNNEL_ID — see the runbook 6B.0.`,
		);
	}
	const env = {};
	for (const line of raw.split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m) continue;
		env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
	}
	const token = env.CF_API_TOKEN, accountId = env.CF_ACCOUNT_ID, zoneId = env.CF_ZONE_ID, tunnelId = env.CF_TUNNEL_ID;
	const missing = ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_ZONE_ID", "CF_TUNNEL_ID"].filter((k) => !env[k]);
	if (missing.length) throw new Error(`${envPath} is missing required key(s): ${missing.join(", ")}.`);
	return { token, accountId, zoneId, tunnelId };
}

// ---
// Thin Cloudflare API fetch. Adds auth, parses the standard {success, result, errors}
// envelope, throws on transport or API error. Never logs the token.
// ---
async function cfFetch(cf, urlPath, { method = "GET", body } = {}) {
	const res = await fetch(`${CF_API}${urlPath}`, {
		method,
		headers: {
			Authorization: `Bearer ${cf.token}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json;
	try { json = await res.json(); } catch { json = null; }
	if (!res.ok || !json || json.success === false) {
		const apiErrs = json && json.errors ? json.errors.map((e) => `${e.code} ${e.message}`).join("; ") : "";
		throw new Error(`Cloudflare API ${method} ${urlPath} failed (HTTP ${res.status})${apiErrs ? ": " + apiErrs : ""}`);
	}
	return json.result;
}

// ---
// Advisory cross-process lock. The tunnel configuration PUT is a whole-config, last-writer-
// wins operation, so two concurrent `serve` invocations doing read-modify-write would
// silently drop each other's ingress rule. All writers live on this one VPS by construction
// (serve runs where the origin runs), so a cooperative lockfile mutex is sufficient.
//
// WHY a lockfile and not flock(2): Node has no native flock; a dep-free O_EXCL lockfile with
// PID + stale detection is the equivalent contract for single-host cooperating writers. The
// runbook says "advisory flock" — same guarantee, different primitive. Cross-host writers
// are explicitly out of scope.
// ---
async function acquireLock() {
	try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	for (;;) {
		try {
			const fd = fs.openSync(LOCK_PATH, "wx"); // atomic create-exclusive
			fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
			fs.closeSync(fd);
			return;
		} catch (err) {
			if (err.code !== "EEXIST") throw err;
			// Stale-lock reclaim: if the holder is long dead, steal it.
			try {
				const st = fs.statSync(LOCK_PATH);
				if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(LOCK_PATH); continue; }
			} catch {}
			if (Date.now() > deadline) throw new Error(`Timed out acquiring ${LOCK_PATH} (another serve is publishing).`);
			await sleep(80 + Math.floor(Math.random() * 120)); // jittered retry
		}
	}
}

function releaseLock() {
	try { fs.unlinkSync(LOCK_PATH); } catch {}
}

async function withLock(fn) {
	await acquireLock();
	try { return await fn(); }
	finally { releaseLock(); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---
// Is a loopback port live? Used by reap-on-start to distinguish a still-running origin from
// an orphaned edge entry left by a crash-without-kill.
// ---
function probePortOnce(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
		sock.on("error", () => resolve(false));
		sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
	});
}

// Retry before declaring a port dead (#181 §4.4).
//
// WHY: reap deletes the tunnel ingress rule for any serve-owned hostname whose port does not
// answer. A single 500 ms probe cannot tell "gone" from "restarting" — a systemd-supervised
// service tenant is down for a moment on every `systemctl restart` or deploy swap, and a
// `serve` invocation landing in that window unpublishes it. Three probes over ~1.5 s costs
// nothing on the common path (a live port answers on probe 1 and returns immediately) and
// closes the window that actually exists.
//
// NOT the fix for princess-pi-brain #9 as originally written — that issue says reap matches
// `ps aux` for `run-live-server`/`http-server`, which this reaper has never done (it has been
// port-probe-based since 8ae6fde, Phase 6B). Correct liveness for a `kind = "service"` tenant
// is a systemd question answered from its manifest `unit`; that stays a brain concern. This
// only narrows the timing window, which is the real residual risk.
//
// #306 closed the residual risk from the other side: the probe is still asked, but it is no
// longer the SOLE reason to delete anything — see classifyReapCandidate below.
async function isPortLive(port, attempts = 3, delayMs = 500) {
	for (let i = 0; i < attempts; i++) {
		if (await probePortOnce(port)) return true;
		if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
	}
	return false;
}

// ---
// Reap decision (#306) — a silent port is necessary, never sufficient.
//
// WHY: reap deletes a tunnel ingress rule and its Access app. Before #306 that fired on one
// fact — 3 TCP probes over ~1.5 s failed — which is a clock standing in for the question
// "is the thing behind this port gone?". A systemd service tenant mid-`restart`, or a
// server that takes >1.5 s to bind, was unpublished; and the loss was outward-facing, on a
// tenant other than the one running `serve`.
//
// The second fact comes from the #181 registry — the record `serve` wrote at spawn for
// every process it owns, verified against the kernel by (pid, startTicks):
//   dead / recycled  → our process is verifiably gone: this is the crash-without-kill the
//                      reaper exists for → reap.
//   live             → our process is alive and simply not answering yet (starting, or
//                      wedged — either way not "gone") → keep.
//   no record        → serve never spawned it. A service tenant published through serve,
//                      or a pre-#181 orphan. Not ours to delete on a probe → keep, and
//                      REPORT it as unverified so it is not silent; `--unpublish` is the
//                      deliberate path.
//
// Evidence is bound to the HOSTNAME as well as the port (PR #318 review). A port is reused:
// a serve-spawned preview at H1 dies on port P (record kept), a service tenant is published
// at H2 on the same P and is silent for a moment — a port-only match would let H1's death
// vouch for reaping H2. So a record is evidence for a rule only when it names that rule's
// hostname; a record with no hostname (never published, or pre-#318) vouches for nothing.
//
// Pure and exported: the decision is testable without Cloudflare, and `reapOrphans` receives
// the evidence by injection because this file must stay plain-node importable
// (run-live-server.js loads it under node; the registry module is TypeScript).
//
// @param {{port:number, hostname:string, probeLive:boolean, evidence?:Array<{port:number, hostname:string|null, verdict:"live"|"dead"|"recycled"}>}} args
// @returns {"keep-live"|"keep-starting"|"reap"|"keep-unverified"}
// ---
export function classifyReapCandidate({ port, hostname, probeLive, evidence }) {
	if (probeLive) return "keep-live";
	const records = Array.isArray(evidence)
		? evidence.filter((e) => e && e.port === port && !!e.hostname && e.hostname === hostname)
		: [];
	if (records.length === 0) return "keep-unverified";
	if (records.some((e) => e.verdict === "live")) return "keep-starting";
	return "reap"; // every record for this hostname+port is dead or recycled — our process is gone
}

// ---
// Reserved-label guard. Derived from the LIVE zone, not a hand-list: refuse any label that
// matches an existing explicit DNS record (any type) or an Access app serve does not own.
// If the zone read fails we fail closed — refuse (loopback still starts upstream).
// ---
/**
 * @returns {Promise<{ok:true} | {ok:false, reason:string}>}
 */
async function checkLabelAvailable(cf, label, activeLabels) {
	// (a) collision with a different active subdomain this run
	if (activeLabels && activeLabels.has(label)) {
		return { ok: false, reason: `label "${label}" collides with another active sub-domain this run` };
	}
	// (b) live zone records — any explicit record's first label is reserved (infra names win).
	let zoneLabels;
	try {
		const records = await cfFetch(cf, `/zones/${cf.zoneId}/dns_records?per_page=1000`);
		zoneLabels = new Set();
		for (const r of records) {
			const name = String(r.name).toLowerCase();
			// A CNAME → our tunnel (`*.cfargotunnel.com`) is serve's own turf, not infra: the
			// `*` wildcard routes there, and any per-subdomain CNAME (e.g. from `cloudflared tunnel
			// route dns`) is a preview host serve may republish onto. Such records do NOT
			// reserve the label (#66 Finding 1). Everything else — A/AAAA to the VPS, MX, TXT,
			// or a CNAME pointing elsewhere — is infra worth protecting.
			if (r.type === "CNAME" && String(r.content || "").toLowerCase().endsWith(".cfargotunnel.com")) continue;
			if (name === ZONE_SUFFIX) { zoneLabels.add("apex"); continue; }
			if (name.endsWith(`.${ZONE_SUFFIX}`)) zoneLabels.add(name.slice(0, name.length - ZONE_SUFFIX.length - 1).split(".").pop());
		}
	} catch (err) {
		// Fail closed: cannot prove the label is free → refuse.
		if (FALLBACK_RESERVED.has(label)) return { ok: false, reason: `label "${label}" is in the fail-closed reserved set (zone read failed)` };
		return { ok: false, reason: `cannot verify label "${label}" — zone DNS read failed (${err.message}); refusing to publish` };
	}
	if (zoneLabels.has(label)) return { ok: false, reason: `label "${label}" matches an existing zone DNS record` };
	// (c) an Access app serve doesn't own already fronts this hostname
	try {
		const apps = await cfFetch(cf, `/accounts/${cf.accountId}/access/apps?per_page=1000`);
		const hostname = `${label}.${ZONE_SUFFIX}`;
		const foreign = apps.find((a) => (a.domain === hostname || (a.self_hosted_domains || []).includes(hostname)) && !String(a.name || "").startsWith(APP_PREFIX));
		if (foreign) return { ok: false, reason: `label "${label}" is fronted by a non-serve Access app ("${foreign.name}")` };
	} catch {
		// Access read failure is non-fatal for the reserved check — the DNS check already ran.
	}
	return { ok: true };
}

// ---
// Tunnel ingress config: GET current, mutate the ingress array, PUT it back, verify-GET.
// The catch-all `{ service: "http_status:404" }` must always remain LAST.
// ---
function upsertIngressRule(config, hostname, port) {
	const ingress = Array.isArray(config?.ingress) ? config.ingress.filter((r) => r.hostname !== hostname) : [];
	const catchAllIdx = ingress.findIndex((r) => !r.hostname);
	const rule = { hostname, service: `http://127.0.0.1:${port}` };
	if (catchAllIdx === -1) { ingress.push(rule, { service: "http_status:404" }); }
	else { ingress.splice(catchAllIdx, 0, rule); }
	return { ...config, ingress };
}

function removeIngressRule(config, hostname) {
	const ingress = Array.isArray(config?.ingress) ? config.ingress.filter((r) => r.hostname !== hostname) : [];
	if (!ingress.some((r) => !r.hostname)) ingress.push({ service: "http_status:404" });
	return { ...config, ingress };
}

async function getTunnelConfig(cf) {
	const result = await cfFetch(cf, `/accounts/${cf.accountId}/cfd_tunnel/${cf.tunnelId}/configurations`);
	return result?.config || { ingress: [{ service: "http_status:404" }] };
}

async function putTunnelConfig(cf, config) {
	await cfFetch(cf, `/accounts/${cf.accountId}/cfd_tunnel/${cf.tunnelId}/configurations`, { method: "PUT", body: { config } });
}

// ---
// Translate validated .serve-acl entries into Cloudflare Access policy Include rules. An
// entry starting with '@' is a whole-domain rule (`email_domain`); everything else is a
// single address (`email`). Pure + exported so this security-critical mapping is unit-
// testable offline — a wrong rule here either locks out a client or lets the wrong domain in.
// ---
/**
 * @param {string[]} entries validated allow-list entries from parseAclFile
 * @returns {Array<{email:{email:string}}|{email_domain:{domain:string}}>}
 */
export function aclEntriesToInclude(entries) {
	return entries.map((entry) =>
		entry.startsWith("@")
			? { email_domain: { domain: entry.slice(1) } }
			: { email: { email: entry } },
	);
}

// ---
// Access application + Allow policy for a sub-domain's hostname.
// ---
async function findAccessApp(cf, hostname) {
	const apps = await cfFetch(cf, `/accounts/${cf.accountId}/access/apps?per_page=1000`);
	return apps.find((a) => a.domain === hostname || (a.self_hosted_domains || []).includes(hostname));
}

async function upsertAccessApp(cf, label, emails) {
	const hostname = `${label}.${ZONE_SUFFIX}`;
	const existing = await findAccessApp(cf, hostname);
	const appBody = {
		name: `${APP_PREFIX}${label}`,
		domain: hostname,
		type: "self_hosted",
		session_duration: "24h",
	};
	let appId;
	if (existing) { appId = existing.id; await cfFetch(cf, `/accounts/${cf.accountId}/access/apps/${appId}`, { method: "PUT", body: appBody }); }
	else { const created = await cfFetch(cf, `/accounts/${cf.accountId}/access/apps`, { method: "POST", body: appBody }); appId = created.id; }

	// Reconcile the Allow policy to exactly the current allow-list (create or replace).
	const policyBody = {
		name: `serve allow ${label}`,
		decision: "allow",
		include: aclEntriesToInclude(emails),
	};
	const policies = await cfFetch(cf, `/accounts/${cf.accountId}/access/apps/${appId}/policies`);
	const mine = (policies || []).find((p) => p.name === policyBody.name);
	if (mine) await cfFetch(cf, `/accounts/${cf.accountId}/access/apps/${appId}/policies/${mine.id}`, { method: "PUT", body: policyBody });
	else await cfFetch(cf, `/accounts/${cf.accountId}/access/apps/${appId}/policies`, { method: "POST", body: policyBody });
	return appId;
}

async function deleteAccessApp(cf, label) {
	const hostname = `${label}.${ZONE_SUFFIX}`;
	const existing = await findAccessApp(cf, hostname);
	if (existing && String(existing.name || "").startsWith(APP_PREFIX)) {
		await cfFetch(cf, `/accounts/${cf.accountId}/access/apps/${existing.id}`, { method: "DELETE" });
	}
}

// ---
// Public API used by serve.ts
// ---

/**
 * Publish one sub-domain to the edge: ingress rule + Access app/policy. Returns the hostname on
 * success. Throws (caller keeps the loopback origin running) on token/label/API failure.
 * @param {{subdomain:string, port:number, emails:string[], activeLabels?:Set<string>}} args
 * @returns {Promise<string>} the published hostname
 */
export async function publishSubdomain({ subdomain, port, emails, activeLabels }) {
	const cf = loadCfEnv();
	const label = flattenSubdomainToLabel(subdomain);
	const hostname = `${label}.${ZONE_SUFFIX}`;
	return withLock(async () => {
		const avail = await checkLabelAvailable(cf, label, activeLabels);
		if (!avail.ok) throw new Error(`Refusing to publish: ${avail.reason}.`);
		// Ingress: GET → mutate → PUT → verify-GET, jittered retry on mismatch.
		for (let attempt = 0; attempt < 3; attempt++) {
			const config = await getTunnelConfig(cf);
			await putTunnelConfig(cf, upsertIngressRule(config, hostname, port));
			const verify = await getTunnelConfig(cf);
			const rule = (verify.ingress || []).find((r) => r.hostname === hostname);
			const hasCatchAll = (verify.ingress || []).some((r) => !r.hostname);
			if (rule && rule.service === `http://127.0.0.1:${port}` && hasCatchAll) break;
			if (attempt === 2) throw new Error(`Ingress verify-GET did not reflect ${hostname} after 3 attempts.`);
			await sleep(120 + Math.floor(Math.random() * 200));
		}
		await upsertAccessApp(cf, label, emails);
		writeSubdomainMap(port, subdomain);
		return hostname;
	});
}

/**
 * Unpublish one sub-domain: remove its ingress rule + Access app. Idempotent.
 * @param {{subdomain:string}} args
 */
export async function unpublishSubdomain({ subdomain }) {
	const cf = loadCfEnv();
	const label = flattenSubdomainToLabel(subdomain);
	const hostname = `${label}.${ZONE_SUFFIX}`;
	return withLock(async () => {
		const config = await getTunnelConfig(cf);
		await putTunnelConfig(cf, removeIngressRule(config, hostname));
		await deleteAccessApp(cf, label);
		removeSubdomainFromMap(subdomain);
	});
}

/**
 * Update only the Access policy for a sub-domain (live `.serve-acl` edit → allow-list change).
 * Does NOT touch ingress. Used by the run-live-server watcher.
 * @param {{subdomain:string, emails:string[]}} args
 */
export async function updateSubdomainAllowlist({ subdomain, emails }) {
	const cf = loadCfEnv();
	const label = flattenSubdomainToLabel(subdomain);
	return withLock(async () => { await upsertAccessApp(cf, label, emails); });
}

/**
 * Reap-on-start: delete any serve-owned edge entry whose loopback port is dead AND whose
 * process the #181 registry says is gone (#306). Runs before publishing new state so a
 * crash-without-kill can't leave a stale allow-list live at the edge. Only touches ingress
 * rules pointing at 127.0.0.1 and Access apps named `serve <..>`. Also cleans the local
 * subdomain map for reaped ports and removes any stale tunnel lockfile.
 *
 * `evidence` is the registry read by the caller (`readRegistry().map(r => ({port, hostname:
 * r.subdomain ? subdomainToHostname(r.subdomain) : null, verdict: verifyRecord(r)}))`) —
 * injected, see classifyReapCandidate. Omit it and nothing is reaped (every silent port is
 * unverified): the fail-safe reading for a caller that has no registry to offer.
 *
 * `onUnverified(hostname, port)` is called for each serve-owned rule whose port is silent
 * but which the registry cannot vouch for — so "left published, could not verify" is said
 * out loud instead of being the silent no-op it would otherwise be. `onReaped(hostname,
 * port)` is called for each rule actually removed — AFTER the tunnel configuration PUT has
 * succeeded (PR #318 review): nothing local or at the edge is torn down until the ingress
 * change is committed, so a failed PUT leaves the evidence, the Access app and the map
 * intact for the next run. The caller uses it to retire the registry record that served as
 * evidence (this module cannot import the registry — see above).
 *
 * KNOWN GAP (deferred, follow-up issue): nothing reaps between a crash and the next serve
 * run — no periodic/TTL GC yet.
 * @param {{evidence?:Array<{port:number, verdict:"live"|"dead"|"recycled"}>, onUnverified?:(hostname:string, port:number)=>void, onReaped?:(hostname:string, port:number)=>void}} [opts]
 * @returns {Promise<string[]>} hostnames reaped
 */
export async function reapOrphans({ evidence, onUnverified, onReaped } = {}) {
	let cf;
	try { cf = loadCfEnv(); } catch { return []; } // no token → nothing to reap, stay quiet

	// Clean stale advisory lock (crash while publishing)
	try {
		if (fs.existsSync(LOCK_PATH)) {
			const st = fs.statSync(LOCK_PATH);
			if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK_PATH);
		}
	} catch { /* best-effort */ }

	return withLock(async () => {
		const reaped = [];
		const deadPorts = new Set();
		const config = await getTunnelConfig(cf);
		const ingress = Array.isArray(config.ingress) ? config.ingress : [];
		// Serve-OWNED hostnames = those fronted by a `serve <label>` Access app. Reap only
		// sweeps these — a hostname with no serve-owned app (hand-seeded ingress, a foreign
		// app) is never touched, so reap can't nuke a fixture it didn't publish (#66 Finding 2).
		let ownedHosts;
		try {
			const apps = await cfFetch(cf, `/accounts/${cf.accountId}/access/apps?per_page=1000`);
			ownedHosts = new Set();
			for (const a of apps || []) {
				if (!String(a.name || "").startsWith(APP_PREFIX)) continue;
				if (a.domain) ownedHosts.add(a.domain);
				for (const d of a.self_hosted_domains || []) ownedHosts.add(d);
			}
		} catch {
			return []; // can't prove ownership → reap nothing (fail-safe)
		}
		// Phase 1 — decide. Nothing is touched here.
		const candidates = []; // { hostname, port }
		for (const rule of ingress) {
			if (!rule.hostname || !rule.service?.startsWith("http://127.0.0.1:")) continue;
			if (!ownedHosts.has(rule.hostname)) continue; // not serve-owned → leave it alone
			const port = parseInt(rule.service.split(":").pop(), 10);
			const probeLive = await isPortLive(port);
			const verdict = classifyReapCandidate({ port, hostname: rule.hostname, probeLive, evidence });
			if (verdict === "keep-live" || verdict === "keep-starting") continue;
			if (verdict === "keep-unverified") {
				if (typeof onUnverified === "function") { try { onUnverified(rule.hostname, port); } catch {} }
				continue;
			}
			candidates.push({ hostname: rule.hostname, port });
		}
		if (candidates.length === 0) return reaped;

		// Phase 2 — commit the ingress change FIRST (PR #318 review). This is the one write
		// that actually stops traffic, and it is all-or-nothing: if it throws, no Access app
		// has been deleted, no registry record retired, no map entry dropped — the next run
		// sees exactly the state this one saw and can try again. The old order (tear down
		// per rule, PUT at the end) left a failed PUT with the ingress still live and its
		// evidence gone, i.e. an orphan that could never again be reaped automatically.
		const reapedHosts = new Set(candidates.map((c) => c.hostname));
		const next = ingress.filter((r) => !reapedHosts.has(r.hostname));
		if (!next.some((r) => !r.hostname)) next.push({ service: "http_status:404" });
		await putTunnelConfig(cf, { ...config, ingress: next });

		// Phase 3 — tear down what the committed ingress no longer references. Best-effort
		// per item: an Access-app delete that fails leaves a harmless app with no ingress
		// behind it (the next run's ownership scan still sees it; the rule it fronted is gone).
		for (const c of candidates) {
			deadPorts.add(c.port);
			const label = c.hostname.endsWith(`.${ZONE_SUFFIX}`) ? c.hostname.slice(0, -(ZONE_SUFFIX.length + 1)) : null;
			if (label) { try { await deleteAccessApp(cf, label); } catch {} }
			reaped.push(c.hostname);
			if (typeof onReaped === "function") { try { onReaped(c.hostname, c.port); } catch {} }
		}

		// Clean subdomain map — remove entries for every reaped port so --list does not
		// show a public URL for a server that no longer exists.
		if (deadPorts.size > 0) {
			const map = readSubdomainMap();
			let changed = false;
			for (const p of deadPorts) {
				if (map[String(p)]) { delete map[String(p)]; changed = true; }
			}
			if (changed) {
				fs.mkdirSync(SERVE_CONFIG_DIR, { recursive: true });
				fs.writeFileSync(SUBDOMAIN_MAP_PATH, JSON.stringify(map), "utf8");
			}
		}
		return reaped;
	});
}

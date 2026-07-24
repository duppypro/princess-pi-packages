/**
 * @module cloudflare
 * @description Phase 6B (#66): per-slug preview automation via the Cloudflare API.
 * Replaces the retired `nginx.js` (map writes + `sudo nginx -s reload`). Instead of
 * touching /etc or sudo, serve programs the edge directly:
 *   - upserts a tunnel INGRESS rule  `<label>.princess-pi.dev -> http://127.0.0.1:<port>`
 *     through the remote-managed tunnel configuration (no local config.yml, no reload),
 *   - upserts a per-slug Access APPLICATION + Allow policy carrying the `.serve-acl`
 *     email allow-list (per-slug app = hard isolation; client A's reviewer can't reach B).
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
				"# Authorized Google email accounts allowed through Cloudflare Access for this slug",
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
		if (cleaned.includes("@") && cleaned.includes(".")) emails.push(cleaned);
		else throw new Error(`Invalid email address found in .serve-acl: "${cleaned}"`);
	}
	if (emails.length === 0) throw new Error("The .serve-acl file must contain at least one valid email address.");
	return emails;
}

// ---
// Slug → DNS label. Cloudflare hostname labels are a strict subset of what a client slug can
// be (a path basename). Lowercase, non-[a-z0-9-] → '-', collapse repeats, trim leading/
// trailing '-', cap at 63 chars (DNS label limit). Deterministic so the same dir always
// maps to the same hostname across start/kill/reap.
// ---
/**
 * @param {string} slug
 * @returns {string} a valid single DNS label
 */
export function flattenSlugToLabel(slug) {
	let label = String(slug)
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/g, ""); // a trailing '-' could reappear after the 63-char slice
	if (!label) throw new Error(`Slug "${slug}" flattens to an empty DNS label.`);
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
function isPortLive(port) {
	return new Promise((resolve) => {
		const sock = net.connect({ host: "127.0.0.1", port }, () => { sock.destroy(); resolve(true); });
		sock.on("error", () => resolve(false));
		sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
	});
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
	// (a) collision with a different active slug this run
	if (activeLabels && activeLabels.has(label)) {
		return { ok: false, reason: `label "${label}" collides with another active slug this run` };
	}
	// (b) live zone records — any explicit record's first label is reserved (infra names win).
	let zoneLabels;
	try {
		const records = await cfFetch(cf, `/zones/${cf.zoneId}/dns_records?per_page=1000`);
		zoneLabels = new Set();
		for (const r of records) {
			const name = String(r.name).toLowerCase();
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
// Access application + Allow policy for a slug's hostname.
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
		include: emails.map((email) => ({ email: { email } })),
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
 * Publish one slug to the edge: ingress rule + Access app/policy. Returns the hostname on
 * success. Throws (caller keeps the loopback origin running) on token/label/API failure.
 * @param {{slug:string, port:number, emails:string[], activeLabels?:Set<string>}} args
 * @returns {Promise<string>} the published hostname
 */
export async function publishSlug({ slug, port, emails, activeLabels }) {
	const cf = loadCfEnv();
	const label = flattenSlugToLabel(slug);
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
		return hostname;
	});
}

/**
 * Unpublish one slug: remove its ingress rule + Access app. Idempotent.
 * @param {{slug:string}} args
 */
export async function unpublishSlug({ slug }) {
	const cf = loadCfEnv();
	const label = flattenSlugToLabel(slug);
	const hostname = `${label}.${ZONE_SUFFIX}`;
	return withLock(async () => {
		const config = await getTunnelConfig(cf);
		await putTunnelConfig(cf, removeIngressRule(config, hostname));
		await deleteAccessApp(cf, label);
	});
}

/**
 * Update only the Access policy for a slug (live `.serve-acl` edit → allow-list change).
 * Does NOT touch ingress. Used by the run-live-server watcher.
 * @param {{slug:string, emails:string[]}} args
 */
export async function updateSlugAllowlist({ slug, emails }) {
	const cf = loadCfEnv();
	const label = flattenSlugToLabel(slug);
	return withLock(async () => { await upsertAccessApp(cf, label, emails); });
}

/**
 * Reap-on-start: delete any serve-owned edge entry whose loopback port is dead. Runs before
 * publishing new state so a crash-without-kill can't leave a stale allow-list live at the
 * edge. Only touches ingress rules pointing at 127.0.0.1 and Access apps named `serve <..>`.
 * KNOWN GAP (deferred, follow-up issue): nothing reaps between a crash and the next serve
 * run — no periodic/TTL GC yet.
 * @returns {Promise<string[]>} hostnames reaped
 */
export async function reapOrphans() {
	let cf;
	try { cf = loadCfEnv(); } catch { return []; } // no token → nothing to reap, stay quiet
	return withLock(async () => {
		const reaped = [];
		const config = await getTunnelConfig(cf);
		const ingress = Array.isArray(config.ingress) ? config.ingress : [];
		let next = ingress;
		for (const rule of ingress) {
			if (!rule.hostname || !rule.service?.startsWith("http://127.0.0.1:")) continue;
			const port = parseInt(rule.service.split(":").pop(), 10);
			if (await isPortLive(port)) continue; // still serving — keep it
			next = next.filter((r) => r.hostname !== rule.hostname);
			const label = rule.hostname.endsWith(`.${ZONE_SUFFIX}`) ? rule.hostname.slice(0, -(ZONE_SUFFIX.length + 1)) : null;
			if (label) { try { await deleteAccessApp(cf, label); } catch {} }
			reaped.push(rule.hostname);
		}
		if (reaped.length) {
			if (!next.some((r) => !r.hostname)) next.push({ service: "http_status:404" });
			await putTunnelConfig(cf, { ...config, ingress: next });
		}
		return reaped;
	});
}

// ---
// Cloudflare/Terraform provisioning driver for /serve  (#32)
//
// /serve is a THIN wrapper: it writes the desired set of live shares into a
// Terraform tfvars file and runs `terraform apply`. Terraform (provider:
// cloudflare) creates, per share, a Tunnel ingress rule + an Access application +
// an Access policy (allow-list) bound to <label>.<machine>.preview.princess-pi.dev.
//
// WHY here and not nginx.js: this replaces the retired nginx serve-acls/ports maps
// (#38 F2). nginx.js stays until the cutover commit but is no longer on the path.
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PREVIEW_BASE = "preview.princess-pi.dev";
const MAX_LABEL = 50;

// machine/ terraform module ships inside the package: <repo>/infra/terraform/machine
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MACHINE_TF_DIR = path.resolve(__dirname, "../../../infra/terraform/machine");
const SHARES_TFVARS = path.join(MACHINE_TF_DIR, "serve-shares.auto.tfvars.json");

// --- Short, configurable machine id used as the subdomain segment + TFC workspace. ---
export function machineId() {
	const raw = process.env.PI_SERVE_MACHINE || os.hostname().split(".")[0] || "host";
	return slugify(raw) || "host";
}

// --- slug ("repo/sub/dir") -> DNS label. Lowercase, non-alnum runs -> '-', trimmed, capped. ---
export function slugify(slug) {
	return String(slug)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_LABEL)
		.replace(/-+$/g, "");
}

// --- Deterministic label, suffixing a 6-hex hash only if a DIFFERENT slug already owns it. ---
export function labelFor(slug, shares = {}) {
	const base = slugify(slug);
	const owner = Object.entries(shares).find(([, s]) => s.slug === slug);
	if (owner) return owner[0]; // already provisioned under this exact slug -> reuse its label
	const collision = Object.entries(shares).some(([label, s]) => label === base && s.slug !== slug);
	if (!collision) return base;
	const suffix = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 6);
	return `${slugify(base.slice(0, MAX_LABEL - 7))}-${suffix}`;
}

export function hostnameFor(label, machine = machineId()) {
	return `${label}.${machine}.${PREVIEW_BASE}`;
}

export function gatedUrlFor(label, machine = machineId()) {
	return `https://${hostnameFor(label, machine)}/`;
}

// --- tfvars I/O (desired-state input; gitignored, machine-local). ---
export function readShares() {
	if (!fs.existsSync(SHARES_TFVARS)) return {};
	try {
		const data = JSON.parse(fs.readFileSync(SHARES_TFVARS, "utf8"));
		return data && data.shares ? data.shares : {};
	} catch {
		return {};
	}
}

function writeShares(shares) {
	fs.mkdirSync(MACHINE_TF_DIR, { recursive: true });
	fs.writeFileSync(SHARES_TFVARS, JSON.stringify({ shares }, null, 2) + "\n", "utf8");
}

// --- Add/replace a share. Returns { label, hostname, gatedUrl }. ---
export function upsertShare({ slug, dir, port, emails, machine = machineId() }) {
	const shares = readShares();
	const label = labelFor(slug, shares);
	shares[label] = { hostname: hostnameFor(label, machine), port, dir, slug, emails };
	writeShares(shares);
	return { label, hostname: shares[label].hostname, gatedUrl: gatedUrlFor(label, machine) };
}

// --- Remove a share by slug OR by port. Returns the removed label or null. ---
export function removeShare({ slug, port }) {
	const shares = readShares();
	const entry = Object.entries(shares).find(
		([, s]) => (slug != null && s.slug === slug) || (port != null && s.port === port)
	);
	if (!entry) return null;
	delete shares[entry[0]];
	writeShares(shares);
	return entry[0];
}

export function hostnameForSlug(slug, machine = machineId()) {
	const shares = readShares();
	const found = Object.entries(shares).find(([, s]) => s.slug === slug);
	return found ? found[1].hostname : hostnameFor(slugify(slug), machine);
}

export function isTerraformAvailable() {
	try {
		execFileSync("terraform", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

// --- Run terraform against the machine module. dryRun -> `plan`, else `apply -auto-approve`.
//     Returns { ok, skipped, output }. Never throws: serving must proceed (loopback) even if
//     the public gate can't be provisioned; the caller warns loudly. ---
export function applyTerraform({ dryRun = process.env.PI_SERVE_DRY_RUN === "1" } = {}) {
	if (!isTerraformAvailable()) {
		return { ok: false, skipped: true, output: "terraform not installed" };
	}
	const action = dryRun ? "plan" : "apply";
	const args = ["-chdir=" + MACHINE_TF_DIR, action, "-input=false"];
	if (!dryRun) args.push("-auto-approve");
	try {
		const output = execFileSync("terraform", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, skipped: false, output };
	} catch (err) {
		return { ok: false, skipped: false, output: err.stderr || err.message || String(err) };
	}
}

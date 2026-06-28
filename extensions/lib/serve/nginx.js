import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const ACL_MAP_PATH = "/etc/nginx/serve-acls.map";
const PORTS_MAP_PATH = "/etc/nginx/serve-ports.map";

/**
 * Escapes a string for use in a regular expression.
 */
function escapeRegExp(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parses the local .serve-acl file in targetDir.
 * Supports entire-line and end-of-line comments starting with '#', strips whitespace.
 * Throws an error if the file is missing, empty, or has no valid emails.
 */
export function parseAclFile(targetDir) {
	const aclPath = path.join(targetDir, ".serve-acl");

	if (!fs.existsSync(aclPath)) {
		throw new Error(`A local .serve-acl file is required to serve directory "${path.basename(targetDir)}" securely.`);
	}

	const content = fs.readFileSync(aclPath, "utf8");
	const lines = content.split(/\r?\n/);
	const emails = [];

	for (const line of lines) {
		// Remove comments (entire line or end-of-line)
		let cleaned = line;
		const hashIdx = line.indexOf("#");
		if (hashIdx !== -1) {
			cleaned = line.substring(0, hashIdx);
		}

		cleaned = cleaned.trim();
		if (!cleaned) continue;

		// Basic email validation
		if (cleaned.includes("@") && cleaned.includes(".")) {
			emails.push(cleaned);
		} else {
			throw new Error(`Invalid email address found in .serve-acl: "${cleaned}"`);
		}
	}

	if (emails.length === 0) {
		throw new Error(`The .serve-acl file must contain at least one valid email address.`);
	}

	return emails;
}

/**
 * Updates /etc/nginx/serve-acls.map for the given client slug.
 * Removes existing mapping lines for this slug, and writes the new email mappings.
 */
export function updateNginxAcls(clientSlug, emails) {
	let content = "";
	if (fs.existsSync(ACL_MAP_PATH)) {
		try {
			content = fs.readFileSync(ACL_MAP_PATH, "utf8");
		} catch (err) {
			console.warn(`⚠️ Warning: Could not read ${ACL_MAP_PATH}: ${err}`);
			return;
		}
	}

	const lines = content.split(/\r?\n/);
	const updatedLines = [];
	const escapedSlug = escapeRegExp(clientSlug);
	// Regex matches: key "clientSlug"; or key 'clientSlug'; or key clientSlug;
	const slugMatcher = new RegExp(`\\s+['"]?${escapedSlug}['"]?\\s*;\\s*(\\s*#.*)?$`);

	for (const line of lines) {
		if (line.trim() && !slugMatcher.test(line)) {
			updatedLines.push(line);
		}
	}

	// Append the new mappings
	if (emails.length > 0) {
		updatedLines.push(`# --- Previews for ${clientSlug} ---`);
		for (const email of emails) {
			updatedLines.push(`"${email}" "${clientSlug}";`);
		}
	}

	try {
		fs.writeFileSync(ACL_MAP_PATH, updatedLines.join("\n") + "\n", { mode: 0o664 });
	} catch (err) {
		throw new Error(`Failed to write to ${ACL_MAP_PATH}: ${err}. Ensure the file is writable by the princess-pi group.`);
	}
}

/**
 * Updates /etc/nginx/serve-ports.map with the active port for the given client slug.
 * If port is null, removes the port mapping and cleans up the ACL maps for that slug.
 */
export function updateNginxPort(clientSlug, port) {
	// 1. Update ports map
	let content = "";
	if (fs.existsSync(PORTS_MAP_PATH)) {
		try {
			content = fs.readFileSync(PORTS_MAP_PATH, "utf8");
		} catch (err) {
			console.warn(`⚠️ Warning: Could not read ${PORTS_MAP_PATH}: ${err}`);
			return;
		}
	}

	const lines = content.split(/\r?\n/);
	const updatedLines = [];
	const escapedSlug = escapeRegExp(clientSlug);
	// Regex matches: "clientSlug" port; or clientSlug port;
	const portMatcher = new RegExp(`^\\s*['"]?${escapedSlug}['"]?\\s+\\d+\\s*;`);

	for (const line of lines) {
		if (line.trim() && !portMatcher.test(line)) {
			updatedLines.push(line);
		}
	}

	if (port !== null) {
		updatedLines.push(`"${clientSlug}" ${port};`);
	}

	try {
		fs.writeFileSync(PORTS_MAP_PATH, updatedLines.join("\n") + "\n", { mode: 0o664 });
	} catch (err) {
		throw new Error(`Failed to write to ${PORTS_MAP_PATH}: ${err}. Ensure the file is writable by the princess-pi group.`);
	}

	// 2. If stopping (port is null), clean up ACLs as well
	if (port === null) {
		updateNginxAcls(clientSlug, []);
	}
}

/**
 * Attempts to reload NGINX dynamically using sudo.
 * Returns null on success, or the error message on failure.
 */
export function reloadNginx() {
	try {
		execSync("sudo nginx -s reload", { stdio: "ignore" });
		return null;
	} catch (err) {
		return err.message || String(err);
	}
}

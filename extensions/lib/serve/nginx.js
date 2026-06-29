import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
	// 1. Ensure .serve-acl is globally ignored
	const homeDir = os.homedir();
	const gitIgnoreDir = path.join(homeDir, ".config", "git");
	const gitIgnorePath = path.join(gitIgnoreDir, "ignore");
	try {
		if (!fs.existsSync(gitIgnoreDir)) {
			fs.mkdirSync(gitIgnoreDir, { recursive: true });
		}
		let ignoreContent = "";
		if (fs.existsSync(gitIgnorePath)) {
			ignoreContent = fs.readFileSync(gitIgnorePath, "utf8");
		}
		if (!ignoreContent.includes(".serve-acl")) {
			const separator = ignoreContent.endsWith("\n") || ignoreContent === "" ? "" : "\n";
			fs.appendFileSync(gitIgnorePath, `${separator}.serve-acl\n`);
		}
	} catch (err) {
		// ignore silently if cannot write global ignore
	}

	const aclPath = path.join(targetDir, ".serve-acl");

	// 2. Auto-seed .serve-acl if missing
	if (!fs.existsSync(aclPath)) {
		const configDir = path.join(homeDir, ".config", "princess-pi");
		const defaultAclPath = path.join(configDir, "default-acl");
		
		let defaultEmails = [];
		if (fs.existsSync(defaultAclPath)) {
			try {
				defaultEmails = fs.readFileSync(defaultAclPath, "utf8")
					.split(/\r?\n/)
					.map(l => l.trim())
					.filter(l => l && !l.startsWith("#"));
			} catch (e) {}
		}

		if (defaultEmails.length === 0) {
			// Try to retrieve user email from local/global git config
			let gitEmail = "";
			try {
				gitEmail = execSync("git config --get user.email", { encoding: "utf8" }).trim();
			} catch (e) {}

			if (!gitEmail || !gitEmail.includes("@")) {
				gitEmail = "david@princess-pi.dev"; // Fallback default
			}

			defaultEmails = [gitEmail];

			// Write global default file
			try {
				if (!fs.existsSync(configDir)) {
					fs.mkdirSync(configDir, { recursive: true });
				}
				fs.writeFileSync(defaultAclPath, `# Global default ACL for /serve\n${gitEmail}\n`, "utf8");
			} catch (e) {}
		}

		// Write the local .serve-acl
		try {
			const localContent = [
				"# Local Access Control List for /serve",
				"# Authorized Google email accounts mapped to this client path",
				...defaultEmails
			].join("\n") + "\n";
			fs.writeFileSync(aclPath, localContent, "utf8");
		} catch (err) {
			throw new Error(`Failed to auto-seed local .serve-acl file in "${targetDir}": ${err.message}`);
		}
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
	const emailMap = new Map(); // Map<string, Set<string> | "all">

	// Parse current map file
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Match: "email" "value"; or email value;
		// Example: "david@princess-pi.dev" "all";
		const match = trimmed.match(/^\s*['"]?([^'"]+)['"]?\s+['"]?([^'"]+)['"]?\s*;\s*$/);
		if (match) {
			const email = match[1].trim();
			const value = match[2].trim();

			if (value === "all") {
				emailMap.set(email, "all");
			} else {
				const slugs = value.split(/\s+/).filter(Boolean);
				const slugSet = new Set(slugs);
				emailMap.set(email, slugSet);
			}
		}
	}

	// 1. Remove current clientSlug from all email records (cleanup)
	for (const [email, value] of emailMap.entries()) {
		if (value instanceof Set) {
			value.delete(clientSlug);
			if (value.size === 0) {
				emailMap.delete(email);
			}
		}
	}

	// 2. Add current clientSlug for the newly requested emails (if not "all")
	for (const email of emails) {
		const value = emailMap.get(email);
		if (value === "all") {
			// already has global access, do nothing
			continue;
		}
		if (value instanceof Set) {
			value.add(clientSlug);
		} else {
			emailMap.set(email, new Set([clientSlug]));
		}
	}

	// 3. Rebuild map file content
	const updatedLines = [
		"# Matches authorized Google emails to their allowed client slug.",
		"# Space-separated values allow multiple slug mappings without duplicate keys."
	];

	for (const [email, value] of emailMap.entries()) {
		if (value === "all") {
			updatedLines.push(`"${email}" "all";`);
		} else if (value instanceof Set && value.size > 0) {
			const slugsStr = Array.from(value).join(" ");
			updatedLines.push(`"${email}" "${slugsStr}";`);
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
		execSync("sudo /usr/sbin/nginx -s reload", { stdio: "ignore" });
		return null;
	} catch (err) {
		return err.message || String(err);
	}
}

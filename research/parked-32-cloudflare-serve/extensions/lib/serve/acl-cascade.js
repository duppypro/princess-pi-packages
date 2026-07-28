// ---
// Cascade ACL resolver for /serve  (#32)
//
// A served directory's EFFECTIVE allow-list is the UNION of every `.serve-acl`
// found walking from the served dir up to $HOME (inclusive). Parent lists cascade
// DOWN to descendants; sibling subtrees stay isolated (they share only common
// ancestors). Put your own email in ~/.serve-acl to grant yourself everything.
//
// WHY a pure resolver (homeDir injectable, no auto-seed, no map writes): it must be
// unit-testable without touching the real $HOME or any Cloudflare/Terraform state.
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ACL_FILENAME = ".serve-acl";

// --- Parse one .serve-acl's text into emails. Throws on a malformed address. ---
export function parseAclContent(content) {
	const emails = [];
	for (const rawLine of content.split(/\r?\n/)) {
		const hashIdx = rawLine.indexOf("#");
		const cleaned = (hashIdx === -1 ? rawLine : rawLine.slice(0, hashIdx)).trim();
		if (!cleaned) continue;
		if (cleaned.includes("@") && cleaned.includes(".")) {
			emails.push(cleaned);
		} else {
			throw new Error(`Invalid email address in ${ACL_FILENAME}: "${cleaned}"`);
		}
	}
	return emails;
}

// --- Emails from a single dir's .serve-acl, or [] if the file is absent. ---
export function readAclFile(dir) {
	const aclPath = path.join(dir, ACL_FILENAME);
	if (!fs.existsSync(aclPath)) return [];
	return parseAclContent(fs.readFileSync(aclPath, "utf8"));
}

// --- The dirs to inspect: targetDir, then each parent up to (and including) home. ---
export function aclSearchPath(targetDir, homeDir = os.homedir()) {
	const home = path.resolve(homeDir);
	let dir = path.resolve(targetDir);
	const chain = [];
	while (true) {
		chain.push(dir);
		if (dir === home) break;
		const parent = path.dirname(dir);
		if (parent === dir) break; // hit filesystem root without passing through home
		dir = parent;
	}
	return chain;
}

// --- Effective allow-list (union, de-duped, most-specific-first). Throws if empty. ---
export function resolveCascadeAcl(targetDir, homeDir = os.homedir()) {
	const seen = new Set();
	const emails = [];
	for (const dir of aclSearchPath(targetDir, homeDir)) {
		for (const email of readAclFile(dir)) {
			if (!seen.has(email)) {
				seen.add(email);
				emails.push(email);
			}
		}
	}
	if (emails.length === 0) {
		throw new Error(
			`No reviewers authorized for "${targetDir}". Add at least one email to a ` +
			`${ACL_FILENAME} here or in any parent up to ~/${ACL_FILENAME}.`
		);
	}
	return emails;
}

// --- Side effect (kept from the old parseAclFile): keep .serve-acl globally git-ignored. ---
export function ensureServeAclGitIgnored(homeDir = os.homedir()) {
	try {
		const gitIgnoreDir = path.join(homeDir, ".config", "git");
		const gitIgnorePath = path.join(gitIgnoreDir, "ignore");
		if (!fs.existsSync(gitIgnoreDir)) fs.mkdirSync(gitIgnoreDir, { recursive: true });
		let content = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, "utf8") : "";
		if (!content.includes(ACL_FILENAME)) {
			const sep = content === "" || content.endsWith("\n") ? "" : "\n";
			fs.appendFileSync(gitIgnorePath, `${sep}${ACL_FILENAME}\n`);
		}
	} catch {
		// best-effort; never block serving on this
	}
}

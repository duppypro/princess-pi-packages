import * as path from "node:path";
import { execSync } from "node:child_process";

export interface ServerInstance {
	port: number;
	dir: string;
	url: string;
	title: string;
	isLive?: boolean;
	// PID captured at discovery time from `ps` (single source of truth for killing — see #39).
	pid?: number;
	localUrl?: string;
	clientSlug?: string;
}

export interface KilledServerInstance extends ServerInstance {
	statusBefore: string;
	statusAfter: string;
}

// Helper to determine if a directory is inside the current repository
export function isInsideRepo(dir: string, cwd: string = process.cwd()): boolean {
	const rel = path.relative(cwd, dir);
	return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// --- #117: listing scope. "repo" = servers under the cwd subtree (the old --log view);
// "all" = every discovered server on the box (the --list-all view). Kept as a pure filter
// so both harness surfaces (CLI + Pi) and the unit tests share one definition of scope.
export type ListScope = "repo" | "all";

export function selectServers(servers: ServerInstance[], cwd: string = process.cwd(), scope: ListScope = "repo"): ServerInstance[] {
	return scope === "all" ? servers.slice() : servers.filter((s) => isInsideRepo(s.dir, cwd));
}

// Helper to construct the dynamic client slug based on Git status
export function getClientSlug(targetDir: string, cwd: string = process.cwd()): string {
	const absoluteTarget = path.resolve(cwd, targetDir);

	// Find the root git repository name if inside a git repo
	try {
		const gitRoot = execSync("git rev-parse --show-toplevel", { 
			cwd: absoluteTarget, 
			encoding: "utf8", 
			stdio: ["ignore", "pipe", "ignore"] 
		}).trim();
		const repoName = path.basename(gitRoot);
		
		const relToGitRoot = path.relative(gitRoot, absoluteTarget);
		if (!relToGitRoot) {
			return repoName;
		} else {
			const cleanRel = relToGitRoot.replace(/\\/g, "/");
			return `${repoName}/${cleanRel}`;
		}
	} catch (e) {
		// Outside a Git repository, fallback to the directory's basename
		return path.basename(absoluteTarget);
	}
}

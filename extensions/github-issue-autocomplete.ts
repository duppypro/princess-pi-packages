// Requires GitHub CLI (`gh`) and a GitHub repository checkout.
// Preloads the CWD open issues once per session, auto-scans sibling repositories,
// and supports two-stage multi-repo autocomplete with inline quoted titles.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type GitHubIssue = {
	number: number;
	title: string;
	state: string;
};

type RepositoryInfo = {
	name: string;
	dirPath: string;
	githubRepo: string | undefined; // owner/repo
};

const MAX_ISSUES = 100;
const MAX_SUGGESTIONS = 20;

// Parse GitHub Owner/Repo from Git remote URL
function parseGitHubRepo(remoteUrl: string): string | undefined {
	const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) {
		return sshMatch[1];
	}

	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	return undefined;
}

// Synchronously parse .git/config URL for ultra-fast, zero-overhead O(1) resolution
function parseGitConfig(configPath: string): string | undefined {
	try {
		const content = fs.readFileSync(configPath, "utf8");
		const match = content.match(/\[remote\s+"origin"\][^]*?url\s*=\s*(.+)/);
		if (match && match[1]) {
			const url = match[1].trim();
			return parseGitHubRepo(url);
		}
	} catch {}
	return undefined;
}

// Scan parent directory to discover all Git repositories on the same level as CWD
function discoverRepositories(): RepositoryInfo[] {
	const cwd = process.cwd();
	const parentDir = path.dirname(cwd);
	const cwdName = path.basename(cwd);
	
	const repos: RepositoryInfo[] = [];
	
	// 1. Resolve current directory repository first (primary)
	const cwdGitConfig = path.join(cwd, ".git", "config");
	let cwdGithubRepo: string | undefined = undefined;
	if (fs.existsSync(cwdGitConfig)) {
		cwdGithubRepo = parseGitConfig(cwdGitConfig);
	}
	repos.push({
		name: cwdName,
		dirPath: cwd,
		githubRepo: cwdGithubRepo
	});
	
	// 2. Scan and add sibling repositories
	try {
		const files = fs.readdirSync(parentDir);
		for (const f of files) {
			if (f === cwdName) continue; // Already added
			const fullPath = path.join(parentDir, f);
			try {
				const stat = fs.statSync(fullPath);
				if (stat.isDirectory()) {
					const configPath = path.join(fullPath, ".git", "config");
					if (fs.existsSync(configPath)) {
						const githubRepo = parseGitConfig(configPath);
						repos.push({
							name: f,
							dirPath: fullPath,
							githubRepo: githubRepo
						});
					}
				}
			} catch {}
		}
	} catch {}
	
	return repos;
}

function formatIssueItem(issue: GitHubIssue, repoName: string): AutocompleteItem {
	return {
		value: `${repoName}#${issue.number} "${issue.title}"`,
		label: `${repoName}#${issue.number}`,
		description: `[${issue.state.toLowerCase()}] ${issue.title}`,
	};
}

function filterIssues(issues: GitHubIssue[], query: string, repoName: string): AutocompleteItem[] {
	if (!query.trim()) {
		return issues.slice(0, MAX_SUGGESTIONS).map(issue => formatIssueItem(issue, repoName));
	}

	if (/^\d+$/.test(query)) {
		const numericMatches = issues
			.filter((issue) => String(issue.number).startsWith(query))
			.slice(0, MAX_SUGGESTIONS)
			.map(issue => formatIssueItem(issue, repoName));
		if (numericMatches.length > 0) {
			return numericMatches;
		}
	}

	return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(issue => formatIssueItem(issue, repoName));
}

function createIssueAutocompleteProvider(
	current: AutocompleteProvider,
	repos: RepositoryInfo[],
	fetchIssuesForRepo: (repo: RepositoryInfo) => Promise<GitHubIssue[] | undefined>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);

			// Extract token matching: optional_repo#optional_digits
			const match = textBeforeCursor.match(/(?:^|[ \t])([a-zA-Z0-9_-]+)?#([0-9]*)$/);
			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const repoName = match[1]; // e.g. "princess-pi-packages" or undefined
			const digits = match[2];   // e.g. "2" or "" (if just '#' typed)

			// We only trigger completions if '#' is present before cursor
			const hasHash = textBeforeCursor.includes("#");
			if (!hasHash) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// ---
			// MODE A: REPO SELECTION MODE (No digits typed yet)
			// ---
			if (digits === "") {
				const items: AutocompleteItem[] = repos.map((r, index) => ({
					value: `${r.name}#`,
					label: `${r.name}#`,
					description: index === 0 ? `[cwd] Current repository` : `[sibling] Sibling repository`
				}));

				const prefix = repoName ? `${repoName}#` : "#";
				return {
					items,
					prefix
				};
			}

			// ---
			// MODE B: ISSUE SELECTION MODE (Digits typed)
			// ---
			const targetRepo = repoName ? repos.find(r => r.name === repoName) : repos[0];
			if (!targetRepo || !targetRepo.githubRepo) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const issues = await fetchIssuesForRepo(targetRepo);
			if (options.signal.aborted || !issues || issues.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const suggestions = filterIssues(issues, digits, targetRepo.name);
			if (suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const prefix = repoName ? `${repoName}#${digits}` : `#${digits}`;
			return {
				items: suggestions,
				prefix
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const repos = discoverRepositories();
		if (repos.length === 0) {
			return;
		}

		const issuePromises: Record<string, Promise<GitHubIssue[] | undefined>> = {};
		let loadErrorShown = false;

		const fetchIssuesForRepo = async (repoInfo: RepositoryInfo): Promise<GitHubIssue[] | undefined> => {
			const repoKey = repoInfo.name;
			const githubRepo = repoInfo.githubRepo;
			if (!githubRepo) return undefined;

			if (!issuePromises[repoKey]) {
				issuePromises[repoKey] = (async () => {
					try {
						const result = await pi.exec(
							"gh",
							[
								"issue",
								"list",
								"--repo",
								githubRepo,
								"--state",
								"open",
								"--limit",
								String(MAX_ISSUES),
								"--json",
								"number,title,state",
							],
							{ cwd: repoInfo.dirPath, timeout: 5_000 },
						);

						if (result.code !== 0) {
							if (!loadErrorShown) {
								loadErrorShown = true;
								let details = result.stderr.trim();
								if (result.code === 127 || details.includes("not found") || details.includes("ENOENT")) {
									ctx.ui.notify(
										"github-issue-autocomplete: 'gh' CLI tool is not installed or not found in system PATH.\n" +
										"To fix this, install it via: sudo apt install gh",
										"error"
									);
								} else {
									ctx.ui.notify(`github-issue-autocomplete: failed to load issues for ${repoKey}: ${details}`, "warning");
								}
							}
							return undefined;
						}

						try {
							return JSON.parse(result.stdout) as GitHubIssue[];
						} catch {
							return undefined;
						}
					} catch (error: any) {
						return undefined;
					}
				})();
			}
			return issuePromises[repoKey];
		};

		// Prefetch issues for the CWD repo on startup
		if (repos[0] && repos[0].githubRepo) {
			void fetchIssuesForRepo(repos[0]);
		}

		ctx.ui.addAutocompleteProvider((current) => createIssueAutocompleteProvider(current, repos, fetchIssuesForRepo));
	});
}

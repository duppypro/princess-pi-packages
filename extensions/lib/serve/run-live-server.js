#!/usr/bin/env node

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as os from "node:os";

// --- Argument Parsing ---
const args = process.argv.slice(2);
let targetDir = process.cwd();

// Find target directory (first non-flag argument)
for (let i = 0; i < args.length; i++) {
	if (!args[i].startsWith("-")) {
		targetDir = path.resolve(args[i]);
		break;
	}
}

// Find port, slug, and bind address
let port = 8080;
let clientSlug = "";
// Fail-safe default: this server has no auth of its own and is always fronted by the
// nginx /live/<slug>/ gate, so it must bind loopback. We honor -a for parity with the
// static (http-server) path, but a non-loopback value is refused below (see #38).
let bind_address = "127.0.0.1";

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "-p" || arg === "--port") {
		port = parseInt(args[i + 1], 10);
	} else if (arg === "--slug") {
		clientSlug = args[i + 1];
	} else if (arg === "-a" || arg === "--address") {
		bind_address = args[i + 1];
	}
}

// --- Refuse any non-loopback bind (defense-in-depth; nginx is the only public door) ---
if (!["127.0.0.1", "::1", "localhost"].includes(bind_address)) {
	console.warn(`[serve] refusing non-loopback bind address "${bind_address}"; forcing 127.0.0.1 (#38).`);
	bind_address = "127.0.0.1";
}

const MIME_TYPES = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".txt": "text/plain",
	".md": "text/plain; charset=utf-8"
};

// SSE Client Response Connections
const activeSseClients = new Set();

// Dependency Graph: Map<absolute_dep_path, Set<absolute_dependent_path>>
const dependencyGraph = new Map();

/**
 * Normalizes absolute or relative paths to trace imports reliably.
 */
function resolveDependencyPath(parentDir, importPath) {
	if (importPath.startsWith("/") || importPath.startsWith("http://") || importPath.startsWith("https://")) {
		return null;
	}
	return path.resolve(parentDir, importPath);
}

/**
 * Parses a JS/HTML file and updates the dependency graph.
 */
function parseDependencies(filePath) {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		const fileDir = path.dirname(filePath);
		const ext = path.extname(filePath);

		// Clear previous dependencies for this file
		for (const [dep, dependents] of dependencyGraph.entries()) {
			dependents.delete(filePath);
			if (dependents.size === 0) {
				dependencyGraph.delete(dep);
			}
		}

		if (ext === ".js" || ext === ".mjs") {
			const importRegex = /(?:import\s+.*?\s+from\s+|import\s+)['"]([^'"]+)['"]/g;
			let match;
			while ((match = importRegex.exec(content)) !== null) {
				const depPath = resolveDependencyPath(fileDir, match[1]);
				if (depPath && fs.existsSync(depPath)) {
					if (!dependencyGraph.has(depPath)) {
						dependencyGraph.set(depPath, new Set());
					}
					dependencyGraph.get(depPath).add(filePath);
				}
			}
		} else if (ext === ".html") {
			const linkRegex = /<link[^>]*?href=['"]([^'"]*?\.css)['"]/g;
			const scriptRegex = /<script[^>]*?src=['"]([^'"]*?\.js)['"]/g;
			const fetchRegex = /fetch\(['"]([^'"]+?)['"]\)/g;
			const dataSrcRegex = /data-src=['"]([^'"]*?\.html)['"]/g;

			let match;
			while ((match = linkRegex.exec(content)) !== null) {
				const depPath = resolveDependencyPath(fileDir, match[1]);
				if (depPath && fs.existsSync(depPath)) {
					if (!dependencyGraph.has(depPath)) {
						dependencyGraph.set(depPath, new Set());
					}
					dependencyGraph.get(depPath).add(filePath);
				}
			}
			while ((match = scriptRegex.exec(content)) !== null) {
				const depPath = resolveDependencyPath(fileDir, match[1]);
				if (depPath && fs.existsSync(depPath)) {
					if (!dependencyGraph.has(depPath)) {
						dependencyGraph.set(depPath, new Set());
					}
					dependencyGraph.get(depPath).add(filePath);
				}
			}
			while ((match = fetchRegex.exec(content)) !== null) {
				const depPath = resolveDependencyPath(fileDir, match[1]);
				if (depPath && fs.existsSync(depPath)) {
					if (!dependencyGraph.has(depPath)) {
						dependencyGraph.set(depPath, new Set());
					}
					dependencyGraph.get(depPath).add(filePath);
				}
			}
			while ((match = dataSrcRegex.exec(content)) !== null) {
				const depPath = resolveDependencyPath(fileDir, match[1]);
				if (depPath && fs.existsSync(depPath)) {
					if (!dependencyGraph.has(depPath)) {
						dependencyGraph.set(depPath, new Set());
					}
					dependencyGraph.get(depPath).add(filePath);
				}
			}
		}
	} catch (_) {}
}

/**
 * Recursively scans directory to build initial dependency graph.
 */
function scanDirectoryForDependencies(dir) {
	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
					scanDirectoryForDependencies(fullPath);
				}
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name);
				if (ext === ".js" || ext === ".html" || ext === ".mjs") {
					parseDependencies(fullPath);
				}
			}
		}
	} catch (_) {}
}

/**
 * Determines if a file is actively used by checking its connections to any HTML file.
 */
function isFileConnectedToHtml(filePath, visited = new Set()) {
	if (visited.has(filePath)) return false;
	visited.add(filePath);

	if (path.extname(filePath) === ".html") return true;

	const dependents = dependencyGraph.get(filePath);
	if (!dependents || dependents.size === 0) return false;

	for (const dep of dependents) {
		if (isFileConnectedToHtml(dep, visited)) {
			return true;
		}
	}
	return false;
}

/**
 * Broadcasts an SSE reload signal to all active browsers.
 */
function broadcast(payload) {
	const message = `data: ${JSON.stringify(payload)}\n\n`;
	for (const client of activeSseClients) {
		client.write(message);
	}
}

// --- HTML Client Injection Script ---
const INJECTION_SCRIPT = `
<script>
if (!window.__live_reload_injected) {
	window.__live_reload_injected = true;
	(function() {
		const es = new EventSource('__live-reload');
		es.onmessage = (e) => {
			const data = JSON.parse(e.data);
			if (data.type === 'css') {
				const links = document.querySelectorAll('link[rel="stylesheet"]');
				for (const link of links) {
					const url = new URL(link.href, window.location.href);
					if (url.pathname === data.path || url.pathname.endsWith(data.path)) {
						link.href = url.pathname + '?t=' + Date.now();
						break;
					}
				}
			} else if (data.type === 'reload') {
				location.reload();
			}
		};
		es.onerror = () => {
			// Auto-reconnect natively
		};
	})();
}
</script>
`;

/**
 * Generates a styled HTML directory listing.
 */
function generateDirectoryIndex(dirPath, requestPath) {
	let html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<title>Index of ${requestPath}</title>
	<style>
		:root {
			--bg-color: #1e1e1e;
			--text-color: #d4d4d4;
			--box-bg: #2d2d2d;
			--accent-blue: #569cd6;
			--accent-green: #6a9955;
			--accent-yellow: #dcdcaa;
		}
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
			background-color: var(--bg-color);
			color: var(--text-color);
			max-width: 800px;
			margin: 40px auto;
			padding: 0 20px;
			line-height: 1.6;
		}
		h1 { color: var(--accent-blue); border-bottom: 2px solid var(--accent-blue); padding-bottom: 10px; margin-bottom: 20px; }
		.list { background: var(--box-bg); border: 1px solid #404040; border-radius: 8px; overflow: hidden; }
		a { color: var(--accent-blue); text-decoration: none; display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid #333; }
		a:last-child { border-bottom: none; }
		a:hover { background: #333; text-decoration: underline; }
		.parent-dir { color: var(--accent-green); font-weight: bold; }
		.icon { margin-right: 12px; font-size: 1.2em; }
	</style>
</head>
<body>
	<h1>Index of ${requestPath}</h1>
	<div class="list">`;

	if (requestPath !== "/" && requestPath !== "") {
		html += `<a class="parent-dir" href="../"><span class="icon">📁</span>.. (Parent Directory)</a>`;
	}

	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		
		// Sort: directories first, then files alphabetically
		entries.sort((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) return -1;
			if (!a.isDirectory() && b.isDirectory()) return 1;
			return a.name.localeCompare(b.name);
		});

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") {
				continue;
			}
			if (entry.isDirectory()) {
				html += `<a href="${entry.name}/"><span class="icon">📁</span>${entry.name}/</a>`;
			} else {
				html += `<a href="${entry.name}"><span class="icon">📄</span>${entry.name}</a>`;
			}
		}
	} catch (err) {
		html += `<p style="padding: 16px; color: var(--anchor-red)">Error reading directory: ${err.message}</p>`;
	}

	html += `</div></body></html>`;
	
	if (html.includes("</body>")) {
		html = html.replace("</body>", `${INJECTION_SCRIPT}</body>`);
	} else {
		html += INJECTION_SCRIPT;
	}

	return html;
}

// --- Server Lifecycle Setup ---

// Ensure log directory exists
const logDir = path.join(os.homedir(), ".config", "pi-serve", "logs");
if (!fs.existsSync(logDir)) {
	try {
		fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
	} catch (_) {}
}
const accessLogPath = path.join(logDir, `port-${port}-access.log`);

// =========================================================================
// AUTOMATIC LOG ROTATION CONFIGURATION
// =========================================================================
// Future Developers & LLMs: Edit the constant below to adjust the maximum size
// of an individual access log file before it is automatically rotated.
// This ensures that development log files do not grow infinitely on disk.
// Default: 5 * 1024 * 1024 bytes (5 Megabytes).
const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024; 
// =========================================================================

// Keep track of the active log file size in-memory to prevent slow disk reads (fs.stat) on every request.
let currentLogSizeBytes = 0;
try {
	if (fs.existsSync(accessLogPath)) {
		currentLogSizeBytes = fs.statSync(accessLogPath).size;
	}
} catch (_) {}

/**
 * Writes an access log entry in Apache Common Log format.
 * Implements automatic, zero-dependency, cross-platform log rotation.
 */
function logAccess(req, res, timestamp) {
	try {
		const ip = req.socket.remoteAddress || "-";
		const method = req.method || "GET";
		const url = req.url || "/";
		const httpVersion = `HTTP/${req.httpVersion}`;
		const status = res.statusCode || 200;
		
		const d = new Date(timestamp);
		const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		const pad = (n) => String(n).padStart(2, "0");
		const dateStr = `${pad(d.getDate())}/${months[d.getMonth()]}/${d.getFullYear()}:${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} +0000`; // Assuming UTC for standardized logging
		
		const logLine = `${ip} - - [${dateStr}] "${method} ${url} ${httpVersion}" ${status} -\n`;
		const lineSize = Buffer.byteLength(logLine);

		// Rotate the log file if writing this line would exceed our configured limit
		if (currentLogSizeBytes + lineSize > MAX_LOG_FILE_SIZE_BYTES) {
			try {
				const oldLogPath = accessLogPath.replace(/\.log$/, ".old.log");
				if (fs.existsSync(oldLogPath)) {
					fs.unlinkSync(oldLogPath); // Safely remove previous backup
				}
				if (fs.existsSync(accessLogPath)) {
					fs.renameSync(accessLogPath, oldLogPath); // Rotate active log to .old.log
				}
				currentLogSizeBytes = 0; // Reset byte counter for the fresh log file
			} catch (_) {}
		}

		fs.appendFile(accessLogPath, logLine, () => {
			currentLogSizeBytes += lineSize; // Track written bytes in-memory
		});
	} catch (_) {}
}

scanDirectoryForDependencies(targetDir);

const server = http.createServer((req, res) => {
	const requestStartTime = Date.now();
	
	// Intercept res.end to ensure we log after status code is definitively set
	const originalEnd = res.end;
	res.end = function(chunk, encoding, callback) {
		res.end = originalEnd;
		const result = res.end(chunk, encoding, callback);
		logAccess(req, res, requestStartTime);
		return result;
	};
	const reqUrl = req.url || "/";

	const cleanUrl = reqUrl.split("?")[0];

	// SSE Endpoint
	if (cleanUrl.endsWith("/__live-reload")) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive"
		});
		res.write(":\n\n");
		activeSseClients.add(res);

		req.on("close", () => {
			activeSseClients.delete(res);
		});
		return;
	}

	let safePath = reqUrl.split("?")[0];
	try {
		safePath = decodeURIComponent(safePath);
	} catch (_) {}

	let filePath = path.join(targetDir, safePath);

	if (!filePath.startsWith(targetDir)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
		const indexPath = path.join(filePath, "index.html");
		if (fs.existsSync(indexPath)) {
			filePath = indexPath;
		} else {
			const html = generateDirectoryIndex(filePath, safePath);
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(html);
			return;
		}
	}

	if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not Found");
		return;
	}

	const ext = path.extname(filePath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";

	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Expires", "0");

	if (ext === ".html") {
		fs.readFile(filePath, "utf8", (err, content) => {
			if (err) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
				return;
			}

			let injectedContent = content;
			if (content.includes("</body>")) {
				injectedContent = content.replace("</body>", `${INJECTION_SCRIPT}</body>`);
			} else {
				injectedContent = content + INJECTION_SCRIPT;
			}

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(injectedContent);
		});
	} else {
		res.writeHead(200, { "Content-Type": contentType });
		const stream = fs.createReadStream(filePath);
		stream.on('end', () => logAccess(req, res, requestStartTime));
		stream.pipe(res);
	}
});

// --- Debounced File Watcher ---
let debounceTimeout = null;
const changedFiles = new Set();

fs.watch(targetDir, { recursive: true }, (eventType, filename) => {
	if (!filename) return;
	const fullPath = path.join(targetDir, filename);

	if ((filename.startsWith(".") && filename !== ".serve-acl") || 
	    (filename.includes("/.") && !filename.endsWith("/.serve-acl")) || 
	    filename.includes("node_modules")) {
		return;
	}

	changedFiles.add(fullPath);

	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
	}

	debounceTimeout = setTimeout(async () => {
		const filesToProcess = Array.from(changedFiles);
		changedFiles.clear();

		let shouldReload = false;
		const cssChanges = new Set();
		let aclChanged = false;

		for (const changedPath of filesToProcess) {
			const ext = path.extname(changedPath).toLowerCase();
			const base = path.basename(changedPath);

			if (base === ".serve-acl") {
				aclChanged = true;
				continue;
			}

			if (fs.existsSync(changedPath)) {
				if (ext === ".js" || ext === ".html" || ext === ".mjs") {
					parseDependencies(changedPath);
				}
			}

			if (ext === ".css") {
				const relativePath = "/" + path.relative(targetDir, changedPath).replace(/\\/g, "/");
				if (isFileConnectedToHtml(changedPath)) {
					cssChanges.add(relativePath);
				}
			} else if (ext === ".js" || ext === ".html" || ext === ".mjs" || ext === ".json") {
				if (isFileConnectedToHtml(changedPath)) {
					shouldReload = true;
				}
			}
		}

		if (aclChanged && clientSlug) {
			try {
				// .serve-acl changed mid-session: re-resolve the cascade and re-apply (#32).
				const { resolveCascadeAcl } = await import("./acl-cascade.js");
				const { upsertShare, applyTerraform } = await import("./cloudflare.js");
				const emails = resolveCascadeAcl(targetDir);
				upsertShare({ slug: clientSlug, dir: targetDir, port, emails });
				const tf = applyTerraform();
				if (!tf.ok && !tf.skipped) console.error(`⚠️ [Live ACL] terraform apply failed: ${tf.output}`);
			} catch (err) {
				console.error(`⚠️ [Live ACL Error] Failed to update ACL dynamically: ${err.message}`);
			}
		}

		for (const cssPath of cssChanges) {
			broadcast({ type: "css", path: cssPath });
		}

		if (shouldReload) {
			broadcast({ type: "reload" });
		}
	}, 150);
});

// Start Server listening
// ---
// WHY loopback: these preview servers are meant to be reached ONLY through the nginx
// `princess-pi.dev/live/<slug>/` vhost, which auth-gates via oauth2-proxy and then proxies
// to 127.0.0.1:<port>. Binding 0.0.0.0 exposed them directly on the public IP, bypassing the
// entire auth gate (see issue #38, F1). `bind_address` is honored from -a but clamped to
// loopback above, so nginx stays the sole authenticated entry point. Defense-in-depth: host
// firewall still required.
// ---
server.listen(port, bind_address, () => {
	console.log(`Live dev server active at ${bind_address}:${port} (loopback only; reach via nginx)`);
});

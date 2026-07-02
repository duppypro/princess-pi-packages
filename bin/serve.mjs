#!/usr/bin/env node

// bin/serve.ts
import * as fs2 from "node:fs";
import * as path5 from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// extensions/lib/serve/domain.ts
import * as path from "node:path";
import { execSync } from "node:child_process";
function isInsideRepo(dir, cwd = process.cwd()) {
  const rel = path.relative(cwd, dir);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
function getClientSlug(targetDir, cwd = process.cwd()) {
  const absoluteTarget = path.resolve(cwd, targetDir);
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
    return path.basename(absoluteTarget);
  }
}

// extensions/lib/serve/process.ts
import * as https from "node:https";
import * as http from "node:http";
import * as path2 from "node:path";
import { exec } from "node:child_process";
async function resolveIp() {
  return "127.0.0.1";
}
function discoverServers() {
  return new Promise((resolve4) => {
    exec("ps aux | grep -E 'http-server|run-live-server' | grep -v grep", async (error, stdout) => {
      if (error || !stdout) {
        resolve4([]);
        return;
      }
      const servers = [];
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const ip = await resolveIp();
      for (const line of lines) {
        const portMatch = line.match(/-p\s+(\d+)/) || line.match(/--port\s+(\d+)/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1], 10);
        if (servers.some((s) => s.port === port)) continue;
        const parts = line.split(/\s+/);
        const httpServerIdx = parts.findIndex((p) => p.includes("http-server") || p.includes("run-live-server"));
        if (httpServerIdx === -1) continue;
        const parsedPid = Number.parseInt(parts[1], 10);
        const pid = Number.isNaN(parsedPid) ? void 0 : parsedPid;
        let dir = "current";
        for (let i = httpServerIdx + 1; i < parts.length; i++) {
          const part = parts[i];
          if (part.startsWith("-")) {
            if (part === "-p" || part === "-C" || part === "-K" || part === "-a") {
              i++;
            }
            continue;
          }
          if (part.length > 0 && !part.includes("npx")) {
            dir = part;
            break;
          }
        }
        const isLive = line.includes("run-live-server");
        const localUrl = `http://127.0.0.1:${port}`;
        const absoluteDir = path2.resolve(process.cwd(), dir);
        const clientSlug = getClientSlug(absoluteDir);
        const url = `https://princess-pi.dev/live/${clientSlug}/?token=duppy_live_token_777`;
        let title = "Index Page";
        try {
          title = await fetchPageTitle(localUrl);
        } catch (e) {
        }
        servers.push({ port, dir, url, localUrl, title, isLive, clientSlug, pid });
      }
      resolve4(servers);
    });
  });
}
function findPidByPort(port) {
  return new Promise((resolve4) => {
    exec(`lsof -t -i :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve4(null);
        return;
      }
      const pids = stdout.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
      if (pids.length > 0) {
        resolve4(parseInt(pids[0], 10));
      } else {
        resolve4(null);
      }
    });
  });
}
function killProcess(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    exec(`kill -9 ${pid}`);
  }
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
async function confirmProcessKilled(pid, retries = 10, delayMs = 100) {
  for (let i = 0; i < retries; i++) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return !isProcessAlive(pid);
}
async function killServerInstance(server) {
  const pid = server.pid ?? await findPidByPort(server.port);
  if (!pid) return false;
  killProcess(pid);
  return confirmProcessKilled(pid);
}
function fetchPageTitle(url) {
  return new Promise((resolve4) => {
    const isSsl = url.startsWith("https");
    const getter = isSsl ? https.get : http.get;
    const agent = isSsl ? new https.Agent({ rejectUnauthorized: false }) : void 0;
    getter(url, { agent, timeout: 500 }, (res) => {
      res.on("error", () => {
      });
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        const match = data.match(/<title>([^<]+)<\/title>/i);
        if (match && match[1]) {
          resolve4(match[1].trim());
        } else {
          resolve4(isSsl ? "Secure HTTPS Page" : "Web Page");
        }
      });
    }).on("error", () => {
      resolve4(isSsl ? "Secure HTTPS Page" : "Web Page");
    });
  });
}
function checkServerStatus(url) {
  return new Promise((resolve4) => {
    const isSsl = url.startsWith("https");
    const getter = isSsl ? https.get : http.get;
    const agent = isSsl ? new https.Agent({ rejectUnauthorized: false }) : void 0;
    const req = getter(url, { agent, timeout: 400 }, (res) => {
      res.on("error", () => {
      });
      res.resume();
      resolve4(`[+] Online (${res.statusCode} ${res.statusMessage || "OK"})`);
    });
    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        resolve4("[-] Offline (Connection Refused)");
      } else {
        resolve4(`[-] Offline (${err.code || err.message})`);
      }
    });
  });
}

// extensions/lib/serve/nginx.js
import * as fs from "node:fs";
import * as path3 from "node:path";
import * as os from "node:os";
import { execSync as execSync2 } from "node:child_process";
var ACL_MAP_PATH = "/etc/nginx/serve-acls.map";
var PORTS_MAP_PATH = "/etc/nginx/serve-ports.map";
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseAclFile(targetDir) {
  const homeDir = os.homedir();
  const gitIgnoreDir = path3.join(homeDir, ".config", "git");
  const gitIgnorePath = path3.join(gitIgnoreDir, "ignore");
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
      fs.appendFileSync(gitIgnorePath, `${separator}.serve-acl
`);
    }
  } catch (err) {
  }
  const aclPath = path3.join(targetDir, ".serve-acl");
  if (!fs.existsSync(aclPath)) {
    const configDir = path3.join(homeDir, ".config", "princess-pi");
    const defaultAclPath = path3.join(configDir, "default-acl");
    let defaultEmails = [];
    if (fs.existsSync(defaultAclPath)) {
      try {
        defaultEmails = fs.readFileSync(defaultAclPath, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      } catch (e) {
      }
    }
    if (defaultEmails.length === 0) {
      let gitEmail = "";
      try {
        gitEmail = execSync2("git config --get user.email", { encoding: "utf8" }).trim();
      } catch (e) {
      }
      if (!gitEmail || !gitEmail.includes("@")) {
        gitEmail = "david@princess-pi.dev";
      }
      defaultEmails = [gitEmail];
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true });
        }
        fs.writeFileSync(defaultAclPath, `# Global default ACL for /serve
${gitEmail}
`, "utf8");
      } catch (e) {
      }
    }
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
    let cleaned = line;
    const hashIdx = line.indexOf("#");
    if (hashIdx !== -1) {
      cleaned = line.substring(0, hashIdx);
    }
    cleaned = cleaned.trim();
    if (!cleaned) continue;
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
function updateNginxAcls(clientSlug, emails) {
  let content = "";
  if (fs.existsSync(ACL_MAP_PATH)) {
    try {
      content = fs.readFileSync(ACL_MAP_PATH, "utf8");
    } catch (err) {
      console.warn(`\u26A0\uFE0F Warning: Could not read ${ACL_MAP_PATH}: ${err}`);
      return;
    }
  }
  const lines = content.split(/\r?\n/);
  const emailMap = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
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
  for (const [email, value] of emailMap.entries()) {
    if (value instanceof Set) {
      value.delete(clientSlug);
      if (value.size === 0) {
        emailMap.delete(email);
      }
    }
  }
  for (const email of emails) {
    const value = emailMap.get(email);
    if (value === "all") {
      continue;
    }
    if (value instanceof Set) {
      value.add(clientSlug);
    } else {
      emailMap.set(email, /* @__PURE__ */ new Set([clientSlug]));
    }
  }
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
    fs.writeFileSync(ACL_MAP_PATH, updatedLines.join("\n") + "\n", { mode: 436 });
  } catch (err) {
    throw new Error(`Failed to write to ${ACL_MAP_PATH}: ${err}. Ensure the file is writable by the princess-pi group.`);
  }
}
function updateNginxPort(clientSlug, port) {
  let content = "";
  if (fs.existsSync(PORTS_MAP_PATH)) {
    try {
      content = fs.readFileSync(PORTS_MAP_PATH, "utf8");
    } catch (err) {
      console.warn(`\u26A0\uFE0F Warning: Could not read ${PORTS_MAP_PATH}: ${err}`);
      return;
    }
  }
  const lines = content.split(/\r?\n/);
  const updatedLines = [];
  const escapedSlug = escapeRegExp(clientSlug);
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
    fs.writeFileSync(PORTS_MAP_PATH, updatedLines.join("\n") + "\n", { mode: 436 });
  } catch (err) {
    throw new Error(`Failed to write to ${PORTS_MAP_PATH}: ${err}. Ensure the file is writable by the princess-pi group.`);
  }
  if (port === null) {
    updateNginxAcls(clientSlug, []);
  }
}
function reloadNginx() {
  try {
    execSync2("sudo /usr/sbin/nginx -s reload", { stdio: "ignore" });
    return null;
  } catch (err) {
    return err.message || String(err);
  }
}

// extensions/lib/serve/tui.ts
import * as path4 from "node:path";
function shortenPath(rawPath, cwd = process.cwd()) {
  let rel = rawPath;
  if (path4.isAbsolute(rawPath)) {
    rel = path4.relative(cwd, rawPath) || rawPath;
  }
  if (rel.length > 25) {
    rel = "..." + rel.slice(-22);
  }
  return rel;
}
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}
function getVisualLength(str) {
  const cleanStr = stripAnsi(str);
  let len = 0;
  for (let i = 0; i < cleanStr.length; i++) {
    const code = cleanStr.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < cleanStr.length) {
      len += 2;
      i++;
    } else if (code >= 12288 && code <= 40959) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}
function padVisual(str, targetLen) {
  const currentLen = getVisualLength(str);
  if (currentLen >= targetLen) {
    const cleanStr = stripAnsi(str);
    let accumulated = 0;
    let result = "";
    for (let i = 0; i < cleanStr.length; i++) {
      const char = cleanStr[i];
      const code = cleanStr.charCodeAt(i);
      let charWidth = 1;
      if (code >= 55296 && code <= 56319 && i + 1 < cleanStr.length) {
        charWidth = 2;
      } else if (code >= 12288 && code <= 40959) {
        charWidth = 2;
      }
      if (accumulated + charWidth > targetLen) break;
      result += char;
      accumulated += charWidth;
      if (charWidth === 2) i++;
    }
    return result + " ".repeat(targetLen - accumulated);
  }
  return str + " ".repeat(targetLen - currentLen);
}
function buildKilledSummary(killedList, cwd = process.cwd()) {
  const borderStyle = "\x1B[37m";
  const summaryParts = [];
  for (const server of killedList) {
    const beforePadded = padVisual(server.statusBefore, 47);
    const afterPadded = padVisual(server.statusAfter, 48);
    const labelStr = `${shortenPath(server.dir, cwd)} - Port ${server.port}`;
    const headerDashes = "\u2500".repeat(Math.max(1, 53 - labelStr.length));
    summaryParts.push(
      `${borderStyle}\u250C\u2500 [${labelStr}] ${headerDashes}\u2510\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mURL:\x1B[0m \x1B[4m\x1B[34m${server.url || server.localUrl}\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mBefore:\x1B[0m ${beforePadded} ${borderStyle}\u2502\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mAfter:\x1B[0m \x1B[31m${afterPadded}\x1B[0m ${borderStyle}\u2502\x1B[0m
${borderStyle}\u2514` + "\u2500".repeat(58) + `\u2518\x1B[0m`
    );
  }
  return `\u{1F6D1} Terminated ${killedList.length} server(s)!

` + summaryParts.join("\n\n");
}
function buildDiscoveredSummary(servers, cwd = process.cwd()) {
  const borderStyle = "\x1B[37m";
  const summaryParts = [];
  for (const server of servers) {
    const titlePadded = padVisual(server.title, 48);
    const logPath = `~/.pi-certs/logs/port-${server.port}-access.log`;
    const logPadded = padVisual(logPath, 49);
    const isSsl = server.url.startsWith("https");
    const typeLabel = server.isLive ? "Live" : "Static";
    const protocolLabelPlain = isSsl ? `Secure HTTPS - ${typeLabel}` : `Plain HTTP - ${typeLabel}`;
    const statusTextPlain = `200 OK (${protocolLabelPlain})`;
    const statusTextPadded = padVisual(statusTextPlain, 47);
    const coloredStatus = isSsl ? `\x1B[32m${statusTextPadded}\x1B[0m` : `\x1B[33m${statusTextPadded}\x1B[0m`;
    const labelStr = `${shortenPath(server.dir, cwd)} - Port ${server.port}`;
    const headerDashes = "\u2500".repeat(Math.max(1, 53 - labelStr.length));
    summaryParts.push(
      `${borderStyle}\u250C\u2500 [${labelStr}] ${headerDashes}\u2510\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mURL:\x1B[0m \x1B[4m\x1B[34m${server.url}\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mLogs:\x1B[0m \x1B[36m${logPadded}\x1B[0m ${borderStyle}\u2502\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mTitle:\x1B[0m ${titlePadded} ${borderStyle}\u2502\x1B[0m
${borderStyle}\u2502\x1B[0m  \x1B[1mStatus:\x1B[0m ${coloredStatus} ${borderStyle}\u2502\x1B[0m
${borderStyle}\u2514` + "\u2500".repeat(58) + `\u2518\x1B[0m`
    );
  }
  return `\u{1F680} Discovering all active servers on this machine...

` + summaryParts.join("\n\n");
}

// bin/serve.ts
async function handleLog() {
  const activeServers = await discoverServers();
  const repoServers = activeServers.filter((s) => isInsideRepo(s.dir, process.cwd()));
  if (repoServers.length === 0) {
    console.log("No servers are currently running in this repository.");
    return;
  }
  const lines = repoServers.map((s) => {
    const logPath = `~/.pi-certs/logs/port-${s.port}-access.log`;
    return `\u2022 ${shortenPath(s.dir, process.cwd())} @ ${s.url} (Logs: ${logPath})`;
  });
  console.log(`\u{1F680} Servers active in this repository:

${lines.join("\n")}`);
}
function handleWhy() {
  try {
    const scriptDir = path5.dirname(fileURLToPath(import.meta.url));
    const manifestPath = path5.join(scriptDir, "..", "docs", "manifests", "serve-cmd.json");
    const manifest = JSON.parse(fs2.readFileSync(manifestPath, "utf8"));
    const invokedAs = "./serve";
    let text = `${manifest.name} - ${manifest.tagline}

`;
    text += `${manifest.description}

`;
    text += `Why run ${invokedAs}?

`;
    const scenarios = manifest.why || [];
    for (const s of scenarios) {
      text += `  ${s.scenario}
`;
      for (const cmd of s.commands) {
        text += `    $ ${invokedAs}${cmd ? " " + cmd : ""}
`;
      }
      text += `    \u2192 ${s.result}

`;
    }
    text += `Run ${invokedAs} --help for the full flag reference.
`;
    console.log(text);
  } catch (err) {
    console.error(`\u26A0\uFE0F Failed to load command manifest: ${err}`);
    process.exitCode = 1;
  }
}
function handleHelp() {
  try {
    const scriptDir = path5.dirname(fileURLToPath(import.meta.url));
    const manifestPath = path5.join(scriptDir, "..", "docs", "manifests", "serve-cmd.json");
    const manifest = JSON.parse(fs2.readFileSync(manifestPath, "utf8"));
    const invokedAs = "./serve";
    let helpText = `${manifest.name} - ${manifest.tagline}

${manifest.description}

`;
    helpText += `Examples:
`;
    for (const e of manifest.examples) {
      const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
      helpText += `  ${fullCmd.padEnd(30)} ${e.desc}
`;
    }
    helpText += `
Usage:
`;
    for (const u of manifest.usage) helpText += `  ${invokedAs} ${u.flags.padEnd(28)} ${u.desc}
`;
    console.log(helpText);
  } catch (err) {
    console.error(`\u26A0\uFE0F Failed to load command manifest: ${err}`);
    process.exitCode = 1;
  }
}
async function handleKill(trimmedArgs) {
  const killArgs = trimmedArgs.replace(/^(--kill|--cancel|--off|-k)/, "").trim();
  const targets = killArgs.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0);
  const activeServers = await discoverServers();
  const killedList = [];
  const killAll = targets.some((t) => t.toLowerCase() === "all");
  if (targets.length === 0 || killAll) {
    const targetsToKill = killAll ? activeServers : activeServers.filter((s) => isInsideRepo(s.dir, process.cwd()));
    if (targetsToKill.length === 0) {
      const scopeLabel = killAll ? "anywhere on this machine" : "in this repository/worktree";
      console.warn(`\u26A0\uFE0F No servers are currently running ${scopeLabel} to kill.`);
      return;
    }
    for (const server of targetsToKill) {
      const statusBefore = await checkServerStatus(server.localUrl || server.url);
      const killed = await killServerInstance(server);
      if (!killed) {
        console.warn(`\u26A0\uFE0F Could NOT terminate server on port ${server.port} (PID ${server.pid ?? "unknown"} not found or still running). Skipping.`);
        continue;
      }
      const statusAfter = await checkServerStatus(server.localUrl || server.url);
      killedList.push({ port: server.port, dir: server.dir, url: server.url, localUrl: server.localUrl, clientSlug: server.clientSlug, title: server.title, statusBefore, statusAfter });
    }
  } else {
    for (const target of targets) {
      const isPort = /^\d+$/.test(target);
      const matchedServer = activeServers.find(
        (s) => isPort ? s.port === parseInt(target, 10) : s.dir.replace(/\/$/, "") === target.replace(/\/$/, "") || shortenPath(s.dir, process.cwd()) === target.replace(/\/$/, "")
      );
      if (matchedServer) {
        const statusBefore = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
        const killed = await killServerInstance(matchedServer);
        if (!killed) {
          console.warn(`\u26A0\uFE0F Could NOT terminate server on port ${matchedServer.port} (PID ${matchedServer.pid ?? "unknown"} not found or still running).`);
          continue;
        }
        const statusAfter = await checkServerStatus(matchedServer.localUrl || matchedServer.url);
        killedList.push({ port: matchedServer.port, dir: matchedServer.dir, url: matchedServer.url, localUrl: matchedServer.localUrl, clientSlug: matchedServer.clientSlug, title: matchedServer.title, statusBefore, statusAfter });
      } else {
        console.warn(`\u26A0\uFE0F Could not find any active server matching "${target}".`);
      }
    }
  }
  if (killedList.length === 0) {
    console.warn("No servers were terminated.");
    return;
  }
  for (const killed of killedList) {
    if (killed.clientSlug) {
      try {
        updateNginxPort(killed.clientSlug, null);
      } catch (err) {
        console.error(`\u26A0\uFE0F Map Cleanup Error for ${killed.clientSlug}: ${err.message}`);
      }
    }
  }
  if (killedList.length > 0) {
    const reloadErr = reloadNginx();
    if (reloadErr) {
      console.warn(`\u26A0\uFE0F Cleaned maps, but NGINX reload failed. Error: ${reloadErr}`);
    } else {
      console.log(`\u2705 Cleaned up routing entries and reloaded NGINX.`);
    }
  }
  console.log(buildKilledSummary(killedList, process.cwd()));
}
async function handleStart(trimmedArgs) {
  let dirs = trimmedArgs.split(/\s+/).map((d) => d.trim()).filter((d) => d.length > 0);
  const isStatic = dirs.includes("--static") || dirs.includes("-s");
  const force = dirs.includes("--force") || dirs.includes("-f");
  dirs = dirs.filter((d) => d !== "--static" && d !== "-s" && d !== "--force" && d !== "-f");
  if (dirs.length === 0) dirs = ["public", "docs"];
  let startPort = 8080;
  for (const rawDir of dirs) {
    const targetDir = path5.resolve(process.cwd(), rawDir);
    if (!fs2.existsSync(targetDir) || !fs2.statSync(targetDir).isDirectory()) {
      console.warn(`\u26A0\uFE0F Warning: Directory "${rawDir}" does not exist. Skipping.`);
      continue;
    }
    const activeServers = await discoverServers();
    const hasMatchingTypeServer = activeServers.some(
      (s) => path5.resolve(process.cwd(), s.dir) === targetDir && !!s.isLive === !isStatic
    );
    if (hasMatchingTypeServer) {
      console.log(`\u2139\uFE0F Note: Directory "${rawDir}" is already being served ${isStatic ? "statically" : "live-reloading"}. Skipping.`);
      continue;
    }
    const envPath = path5.join(targetDir, ".env");
    if (fs2.existsSync(envPath) && !force) {
      console.warn(`\u26A0\uFE0F Found .env file in "${rawDir}"! Skipping (pass --force to serve anyway).`);
      continue;
    }
    while (activeServers.some((s) => s.port === startPort)) startPort++;
    const port = startPort++;
    let emails;
    try {
      emails = parseAclFile(targetDir);
    } catch (err) {
      console.error(`\u26A0\uFE0F Failed to start server for "${rawDir}": ${err.message}`);
      continue;
    }
    const clientSlug = getClientSlug(targetDir);
    const __dirname = path5.dirname(fileURLToPath(import.meta.url));
    const runnerPath = path5.resolve(__dirname, "../extensions/lib/serve/run-live-server.js");
    const spawnCmd = isStatic ? "npx" : "node";
    const spawnArgs = isStatic ? ["--", "http-server", targetDir, "-p", String(port), "-a", "127.0.0.1"] : [runnerPath, targetDir, "--slug", clientSlug, "-p", String(port), "-a", "127.0.0.1"];
    const serverProcess = spawn(spawnCmd, spawnArgs, { detached: true, stdio: "ignore" });
    serverProcess.unref();
    try {
      updateNginxAcls(clientSlug, emails);
      updateNginxPort(clientSlug, port);
      const reloadErr = reloadNginx();
      if (reloadErr) {
        console.warn(`\u26A0\uFE0F Maps updated for ${clientSlug}, but NGINX reload failed. Error: ${reloadErr}`);
      } else {
        console.log(`\u2705 NGINX reloaded. Routing mapped for https://princess-pi.dev/live/${clientSlug}/`);
      }
    } catch (err) {
      console.error(`\u26A0\uFE0F Dynamic Map/ACL Error: ${err.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
  const allActiveServers = await discoverServers();
  if (allActiveServers.length === 0) {
    console.warn("No active directories are currently being served.");
    return;
  }
  console.log(buildDiscoveredSummary(allActiveServers, process.cwd()));
}
async function run() {
  await resolveIp();
  const trimmedArgs = process.argv.slice(2).join(" ").trim();
  if (trimmedArgs === "--log" || trimmedArgs === "-L") return handleLog();
  if (trimmedArgs === "--help" || trimmedArgs === "-h") return handleHelp();
  if (trimmedArgs === "--why") return handleWhy();
  if (/^(--kill|--cancel|--off|-k)(\s|$)/.test(trimmedArgs)) return handleKill(trimmedArgs);
  return handleStart(trimmedArgs);
}
run();

#!/usr/bin/env node

// bin/serve.ts
import * as fs3 from "node:fs";
import * as path6 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
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
import * as path3 from "node:path";
import { exec } from "node:child_process";

// extensions/lib/serve/cloudflare.js
import * as fs from "node:fs";
import * as path2 from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
var PREVIEW_BASE = "preview.princess-pi.dev";
var MAX_LABEL = 50;
var __dirname = path2.dirname(fileURLToPath(import.meta.url));
var MACHINE_TF_DIR = path2.resolve(__dirname, "../../../infra/terraform/machine");
var SHARES_TFVARS = path2.join(MACHINE_TF_DIR, "serve-shares.auto.tfvars.json");
function machineId() {
  const raw = process.env.PI_SERVE_MACHINE || os.hostname().split(".")[0] || "host";
  return slugify(raw) || "host";
}
function slugify(slug) {
  return String(slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_LABEL).replace(/-+$/g, "");
}
function labelFor(slug, shares = {}) {
  const base = slugify(slug);
  const owner = Object.entries(shares).find(([, s]) => s.slug === slug);
  if (owner) return owner[0];
  const collision = Object.entries(shares).some(([label, s]) => label === base && s.slug !== slug);
  if (!collision) return base;
  const suffix = crypto.createHash("sha256").update(slug).digest("hex").slice(0, 6);
  return `${slugify(base.slice(0, MAX_LABEL - 7))}-${suffix}`;
}
function hostnameFor(label, machine = machineId()) {
  return `${label}.${machine}.${PREVIEW_BASE}`;
}
function gatedUrlFor(label, machine = machineId()) {
  return `https://${hostnameFor(label, machine)}/`;
}
function readShares() {
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
function upsertShare({ slug, dir, port, emails, machine = machineId() }) {
  const shares = readShares();
  const label = labelFor(slug, shares);
  shares[label] = { hostname: hostnameFor(label, machine), port, dir, slug, emails };
  writeShares(shares);
  return { label, hostname: shares[label].hostname, gatedUrl: gatedUrlFor(label, machine) };
}
function removeShare({ slug, port }) {
  const shares = readShares();
  const entry = Object.entries(shares).find(
    ([, s]) => slug != null && s.slug === slug || port != null && s.port === port
  );
  if (!entry) return null;
  delete shares[entry[0]];
  writeShares(shares);
  return entry[0];
}
function hostnameForSlug(slug, machine = machineId()) {
  const shares = readShares();
  const found = Object.entries(shares).find(([, s]) => s.slug === slug);
  return found ? found[1].hostname : hostnameFor(slugify(slug), machine);
}
function isTerraformAvailable() {
  try {
    execFileSync("terraform", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function applyTerraform({ dryRun = process.env.PI_SERVE_DRY_RUN === "1" } = {}) {
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

// extensions/lib/serve/process.ts
async function resolveIp() {
  return "127.0.0.1";
}
function discoverServers() {
  return new Promise((resolve6) => {
    exec("ps aux | grep -E 'http-server|run-live-server' | grep -v grep", async (error, stdout) => {
      if (error || !stdout) {
        resolve6([]);
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
        const absoluteDir = path3.resolve(process.cwd(), dir);
        const clientSlug = getClientSlug(absoluteDir);
        const url = `https://${hostnameForSlug(clientSlug)}/`;
        let title = "Index Page";
        try {
          title = await fetchPageTitle(localUrl);
        } catch (e) {
        }
        servers.push({ port, dir, url, localUrl, title, isLive, clientSlug, pid });
      }
      resolve6(servers);
    });
  });
}
function findPidByPort(port) {
  return new Promise((resolve6) => {
    exec(`lsof -t -i :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve6(null);
        return;
      }
      const pids = stdout.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
      if (pids.length > 0) {
        resolve6(parseInt(pids[0], 10));
      } else {
        resolve6(null);
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
  return new Promise((resolve6) => {
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
          resolve6(match[1].trim());
        } else {
          resolve6(isSsl ? "Secure HTTPS Page" : "Web Page");
        }
      });
    }).on("error", () => {
      resolve6(isSsl ? "Secure HTTPS Page" : "Web Page");
    });
  });
}
function checkServerStatus(url) {
  return new Promise((resolve6) => {
    const isSsl = url.startsWith("https");
    const getter = isSsl ? https.get : http.get;
    const agent = isSsl ? new https.Agent({ rejectUnauthorized: false }) : void 0;
    const req = getter(url, { agent, timeout: 400 }, (res) => {
      res.on("error", () => {
      });
      res.resume();
      resolve6(`[+] Online (${res.statusCode} ${res.statusMessage || "OK"})`);
    });
    req.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        resolve6("[-] Offline (Connection Refused)");
      } else {
        resolve6(`[-] Offline (${err.code || err.message})`);
      }
    });
  });
}

// extensions/lib/serve/acl-cascade.js
import * as fs2 from "node:fs";
import * as path4 from "node:path";
import * as os2 from "node:os";
var ACL_FILENAME = ".serve-acl";
function parseAclContent(content) {
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
function readAclFile(dir) {
  const aclPath = path4.join(dir, ACL_FILENAME);
  if (!fs2.existsSync(aclPath)) return [];
  return parseAclContent(fs2.readFileSync(aclPath, "utf8"));
}
function aclSearchPath(targetDir, homeDir = os2.homedir()) {
  const home = path4.resolve(homeDir);
  let dir = path4.resolve(targetDir);
  const chain = [];
  while (true) {
    chain.push(dir);
    if (dir === home) break;
    const parent = path4.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain;
}
function resolveCascadeAcl(targetDir, homeDir = os2.homedir()) {
  const seen = /* @__PURE__ */ new Set();
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
      `No reviewers authorized for "${targetDir}". Add at least one email to a ${ACL_FILENAME} here or in any parent up to ~/${ACL_FILENAME}.`
    );
  }
  return emails;
}
function ensureServeAclGitIgnored(homeDir = os2.homedir()) {
  try {
    const gitIgnoreDir = path4.join(homeDir, ".config", "git");
    const gitIgnorePath = path4.join(gitIgnoreDir, "ignore");
    if (!fs2.existsSync(gitIgnoreDir)) fs2.mkdirSync(gitIgnoreDir, { recursive: true });
    let content = fs2.existsSync(gitIgnorePath) ? fs2.readFileSync(gitIgnorePath, "utf8") : "";
    if (!content.includes(ACL_FILENAME)) {
      const sep = content === "" || content.endsWith("\n") ? "" : "\n";
      fs2.appendFileSync(gitIgnorePath, `${sep}${ACL_FILENAME}
`);
    }
  } catch {
  }
}

// extensions/lib/serve/tui.ts
import * as path5 from "node:path";
function shortenPath(rawPath, cwd = process.cwd()) {
  let rel = rawPath;
  if (path5.isAbsolute(rawPath)) {
    rel = path5.relative(cwd, rawPath) || rawPath;
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
function handleHelp() {
  try {
    const manifestPath = path6.join(process.cwd(), "docs", "manifests", "serve-cmd.json");
    const manifest = JSON.parse(fs3.readFileSync(manifestPath, "utf8"));
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
    try {
      removeShare({ slug: killed.clientSlug, port: killed.port });
    } catch (err) {
      console.error(`\u26A0\uFE0F Share cleanup error for ${killed.clientSlug ?? killed.port}: ${err.message}`);
    }
  }
  if (killedList.length > 0) {
    const tf = applyTerraform();
    if (tf.skipped) {
      console.warn(`\u26A0\uFE0F Local servers stopped; Cloudflare gate NOT updated (terraform not installed).`);
    } else if (!tf.ok) {
      console.warn(`\u26A0\uFE0F Local servers stopped, but terraform apply failed:
${tf.output}`);
    } else {
      console.log(`\u2705 Removed Cloudflare routes for the killed shares.`);
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
  ensureServeAclGitIgnored();
  const provisioned = [];
  for (const rawDir of dirs) {
    const targetDir = path6.resolve(process.cwd(), rawDir);
    if (!fs3.existsSync(targetDir) || !fs3.statSync(targetDir).isDirectory()) {
      console.warn(`\u26A0\uFE0F Warning: Directory "${rawDir}" does not exist. Skipping.`);
      continue;
    }
    const activeServers = await discoverServers();
    const hasMatchingTypeServer = activeServers.some(
      (s) => path6.resolve(process.cwd(), s.dir) === targetDir && !!s.isLive === !isStatic
    );
    if (hasMatchingTypeServer) {
      console.log(`\u2139\uFE0F Note: Directory "${rawDir}" is already being served ${isStatic ? "statically" : "live-reloading"}. Skipping.`);
      continue;
    }
    const envPath = path6.join(targetDir, ".env");
    if (fs3.existsSync(envPath) && !force) {
      console.warn(`\u26A0\uFE0F Found .env file in "${rawDir}"! Skipping (pass --force to serve anyway).`);
      continue;
    }
    while (activeServers.some((s) => s.port === startPort)) startPort++;
    const port = startPort++;
    let emails;
    try {
      emails = resolveCascadeAcl(targetDir);
    } catch (err) {
      console.error(`\u26A0\uFE0F Failed to start server for "${rawDir}": ${err.message}`);
      continue;
    }
    const clientSlug = getClientSlug(targetDir);
    const __dirname2 = path6.dirname(fileURLToPath2(import.meta.url));
    const runnerPath = path6.resolve(__dirname2, "../extensions/lib/serve/run-live-server.js");
    const spawnCmd = isStatic ? "npx" : "node";
    const spawnArgs = isStatic ? ["--", "http-server", targetDir, "-p", String(port), "-a", "127.0.0.1"] : [runnerPath, targetDir, "--slug", clientSlug, "-p", String(port), "-a", "127.0.0.1"];
    const serverProcess = spawn(spawnCmd, spawnArgs, { detached: true, stdio: "ignore" });
    serverProcess.unref();
    try {
      const { gatedUrl } = upsertShare({ slug: clientSlug, dir: targetDir, port, emails });
      provisioned.push({ slug: clientSlug, gatedUrl, port });
    } catch (err) {
      console.error(`\u26A0\uFE0F Failed to record share for ${clientSlug}: ${err.message}`);
    }
  }
  if (provisioned.length > 0) {
    const tf = applyTerraform();
    if (tf.skipped) {
      console.warn(`\u26A0\uFE0F Cloudflare gate NOT provisioned (terraform not installed) \u2014 loopback only:`);
      for (const p of provisioned) console.warn(`   \u2022 planned ${p.gatedUrl} (local: http://127.0.0.1:${p.port}/)`);
    } else if (!tf.ok) {
      console.warn(`\u26A0\uFE0F terraform apply failed; loopback is up but the gate may be stale:
${tf.output}`);
    } else {
      console.log(`\u2705 Cloudflare gate provisioned:`);
      for (const p of provisioned) console.log(`   \u2022 ${p.gatedUrl}  (local test: http://127.0.0.1:${p.port}/)`);
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
  if (/^(--kill|--cancel|--off|-k)(\s|$)/.test(trimmedArgs)) return handleKill(trimmedArgs);
  return handleStart(trimmedArgs);
}
run();

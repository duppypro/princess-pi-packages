#!/usr/bin/env node

// bin/merge.ts
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// extensions/lib/merge/core.ts
import { execSync } from "node:child_process";
import * as fs from "node:fs";
var STEP5_SUBJECT = /^Code and Spec Approved(\s*\([^)]*\))?\s*:/;
function runMerge(argsList, logger) {
  logger.info("\u{1F504} Running merge validation checks...");
  const currentCwd = process.cwd();
  const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: currentCwd, encoding: "utf8" }).trim();
  if (currentBranch === "main") {
    throw new Error("You are already on the 'main' branch/worktree. Cannot merge main into itself.");
  }
  const currentStatus = execSync("git status --porcelain", { cwd: currentCwd, encoding: "utf8" }).trim();
  if (currentStatus !== "") {
    throw new Error(`Your current branch worktree (${currentBranch}) is not clean. Please commit or stash changes first.
${currentStatus}`);
  }
  logger.info("\u{1F4E1} Fetching origin to update remote tracking references...");
  execSync("git fetch origin", { cwd: currentCwd, stdio: "ignore" });
  const localHash = execSync("git rev-parse HEAD", { cwd: currentCwd, encoding: "utf8" }).trim();
  let targetHash = "";
  const ref = argsList[0];
  if (ref) {
    try {
      targetHash = execSync(`git rev-parse ${ref}`, { cwd: currentCwd, encoding: "utf8" }).trim();
    } catch {
      throw new Error(`The provided reference '${ref}' is not a valid Git commit or branch name.`);
    }
    try {
      execSync(`git merge-base --is-ancestor ${targetHash} HEAD`, { cwd: currentCwd });
    } catch {
      throw new Error(`The target commit '${ref}' (${targetHash.substring(0, 7)}) is not in the history of the current branch '${currentBranch}'.`);
    }
  } else {
    targetHash = localHash;
  }
  let isPushed = false;
  try {
    execSync(`git merge-base --is-ancestor ${targetHash} origin/${currentBranch}`, { cwd: currentCwd });
    isPushed = true;
  } catch {
    isPushed = false;
  }
  if (!isPushed) {
    throw new Error(`The target commit ${targetHash.substring(0, 7)} has not been pushed to 'origin/${currentBranch}'. Please push your changes first.`);
  }
  const targetCommitMsg = execSync(`git log -1 --pretty=%B ${targetHash}`, { cwd: currentCwd, encoding: "utf8" }).trim();
  if (!STEP5_SUBJECT.test(targetCommitMsg)) {
    let suggestedStep5Hash = "";
    let suggestedStep5Msg = "";
    try {
      const logLines = execSync('git log --pretty=format:"%H %s" -n 50', { cwd: currentCwd, encoding: "utf8" }).trim().split("\n");
      for (const line of logLines) {
        const spaceIdx = line.indexOf(" ");
        if (spaceIdx !== -1) {
          const hash = line.substring(0, spaceIdx).trim();
          const msg = line.substring(spaceIdx + 1).trim();
          if (STEP5_SUBJECT.test(msg)) {
            suggestedStep5Hash = hash;
            suggestedStep5Msg = msg;
            break;
          }
        }
      }
    } catch {
    }
    let errorMsg = `The target commit ${targetHash.substring(0, 7)} is not a Step 5 'Code and Spec Approved' commit.
Target commit message: "${targetCommitMsg.split("\n")[0]}"
Merges to main are only permitted for commits in the Step 5 Approved state.`;
    if (suggestedStep5Hash) {
      errorMsg += `

\u{1F4A1} Suggestion: A previous Step 5 commit was found in your history:
   Hash: \x1B[33m${suggestedStep5Hash.substring(0, 7)}\x1B[0m
   Message: "${suggestedStep5Msg}"

To merge up to that stable checkpoint, run:
   \x1B[36mmerge ${suggestedStep5Hash.substring(0, 7)}\x1B[0m`;
    }
    throw new Error(errorMsg);
  }
  const worktreeLines = execSync("git worktree list", { cwd: currentCwd, encoding: "utf8" }).trim().split("\n");
  let mainCwd = "";
  for (const line of worktreeLines) {
    if (line.includes("[main]")) {
      const idx = line.lastIndexOf("[main]");
      const beforeBranch = line.substring(0, idx).trim();
      const spaceIdx = beforeBranch.lastIndexOf(" ");
      mainCwd = spaceIdx !== -1 ? beforeBranch.substring(0, spaceIdx).trim() : beforeBranch;
    }
  }
  const haveMainWorktree = !!mainCwd && fs.existsSync(mainCwd) && mainCwd !== currentCwd;
  if (haveMainWorktree) {
    const mainStatus = execSync("git status --porcelain", { cwd: mainCwd, encoding: "utf8" }).trim();
    if (mainStatus !== "") {
      throw new Error(`The 'main' branch worktree at ${mainCwd} is not clean. Please clean or stash changes there first.
${mainStatus}`);
    }
    logger.info("\u{1F4E1} Pulling latest 'main' from origin...");
    execSync("git checkout main", { cwd: mainCwd, stdio: "ignore" });
    execSync("git pull --ff-only origin main", { cwd: mainCwd, stdio: "ignore" });
    logger.info(`\u{1F500} Merging target commit ${targetHash.substring(0, 7)} into 'main' in the main worktree...`);
    execSync(`git merge ${targetHash}`, { cwd: mainCwd, stdio: "ignore" });
    logger.info("\u{1F4E1} Pushing merged 'main' branch to origin...");
    execSync("git push origin main", { cwd: mainCwd, stdio: "ignore" });
    logger.info(`\u{1F389} Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
    logger.info(`\u{1F4AA} Ready for the next task! You are in worktree '${currentCwd}' on branch '${currentBranch}'.`);
  } else {
    logger.info("\u{1FAB5} No dedicated 'main' worktree found \u2014 using in-place single-checkout merge.");
    try {
      let hasLocalMain = true;
      try {
        execSync("git rev-parse --verify --quiet refs/heads/main", { cwd: currentCwd, stdio: "ignore" });
      } catch {
        hasLocalMain = false;
      }
      logger.info("\u{1F4E1} Checking out and updating 'main'...");
      if (hasLocalMain) {
        execSync("git checkout main", { cwd: currentCwd, stdio: "ignore" });
        execSync("git pull --ff-only origin main", { cwd: currentCwd, stdio: "ignore" });
      } else {
        execSync("git checkout -b main origin/main", { cwd: currentCwd, stdio: "ignore" });
      }
      logger.info(`\u{1F500} Merging target commit ${targetHash.substring(0, 7)} into 'main'...`);
      execSync(`git merge ${targetHash}`, { cwd: currentCwd, stdio: "ignore" });
      logger.info("\u{1F4E1} Pushing merged 'main' branch to origin...");
      execSync("git push origin main", { cwd: currentCwd, stdio: "ignore" });
    } catch (mergeErr) {
      try {
        execSync("git merge --abort", { cwd: currentCwd, stdio: "ignore" });
      } catch {
      }
      const detail = mergeErr?.message || String(mergeErr);
      throw new Error(
        `In-place merge into 'main' failed and was rolled back (you are back on '${currentBranch}').
Likely a merge conflict or a non-fast-forward 'main' (someone pushed). Fix by updating 'main' and re-running, or resolve manually.
Underlying error:
${detail}`
      );
    } finally {
      try {
        execSync(`git checkout ${currentBranch}`, { cwd: currentCwd, stdio: "ignore" });
      } catch {
      }
    }
    logger.info(`\u{1F389} Success! Merged target commit ${targetHash.substring(0, 7)} into 'main' and pushed to origin.`);
    logger.info(`\u{1F4AA} Ready for the next task! You are on branch '${currentBranch}'.`);
  }
}

// extensions/lib/merge/help.ts
import * as fs2 from "node:fs";
function renderHelp(manifestPath, invokedAs) {
  const manifestStr = fs2.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestStr);
  let helpText = `\x1B[1m\x1B[36m${manifest.name}\x1B[0m - ${manifest.tagline}

`;
  helpText += `${manifest.description}

`;
  helpText += `\x1B[1mExamples:\x1B[0m
`;
  for (const e of manifest.examples) {
    const fullCmd = e.args ? `${invokedAs} ${e.args}` : invokedAs;
    helpText += `  ${fullCmd.padEnd(30)} ${e.desc}
`;
  }
  helpText += `
\x1B[1mUsage:\x1B[0m
`;
  for (const u of manifest.usage) {
    helpText += `  ${invokedAs} ${u.flags.padEnd(28)} ${u.desc}
`;
  }
  return helpText;
}

// bin/merge.ts
function run() {
  const argsList = process.argv.slice(2).filter(Boolean);
  if (argsList.includes("-h") || argsList.includes("--help")) {
    try {
      const scriptDir = path.dirname(fileURLToPath(import.meta.url));
      const manifestPath = path.join(scriptDir, "..", "docs", "manifests", "merge-cmd.json");
      const helpText = renderHelp(manifestPath, "merge");
      console.log(helpText);
    } catch (err) {
      console.error(`\u26A0\uFE0F Failed to load merge command manifest: ${err}`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    runMerge(argsList, {
      info: (msg) => console.log(msg),
      error: (msg) => console.error(msg)
    });
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.error(`\u274C Merge Aborted:
${errMsg}`);
    process.exitCode = 1;
  }
}
run();

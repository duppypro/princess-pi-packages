import { build } from "esbuild";
import fs from "fs";
import path from "path";

// Recursively find all SKILL.md files
function findSkillFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === "node_modules" || file === ".git") continue;
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(findSkillFiles(filePath));
    } else if (file === "SKILL.md") {
      results.push(filePath);
    }
  }
  return results;
}

function validateSkills() {
  console.log("🔍 Validating SKILL.md files...");
  const skillFiles = findSkillFiles(process.cwd());
  let errors = 0;

  for (const filePath of skillFiles) {
    const content = fs.readFileSync(filePath, "utf8");
    // Extract frontmatter (between first and second ---)
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) {
      console.error(`❌ [Skill Format Error] ${filePath}: No frontmatter found.`);
      errors++;
      continue;
    }

    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    if (!nameMatch) {
      console.error(`❌ [Skill Format Error] ${filePath}: 'name' field is missing in frontmatter.`);
      errors++;
      continue;
    }

    const name = nameMatch[1].trim();
    // Validate characters: must be lowercase a-z, 0-9, and hyphens only
    const validNameRegex = /^[a-z0-9-]+$/;
    if (!validNameRegex.test(name)) {
      console.error(`❌ [Skill Format Error] ${filePath}: name "${name}" contains invalid characters (must be lowercase a-z, 0-9, hyphens only).`);
      errors++;
    }
  }

  if (errors > 0) {
    throw new Error(`${errors} skill validation error(s) found.`);
  }
  console.log(`✅ Validated ${skillFiles.length} SKILL.md file(s).`);
}

async function buildAll() {
  // Validate skills first
  validateSkills();

  console.log("🛠️  Building cross-harness CLI binaries...");

  // 1. Build serve.mjs
  await build({
    entryPoints: ["bin/serve.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: "bin/serve.mjs",
    external: ["../extensions/lib/serve/run-live-server.js"]
  });

  let serveCode = fs.readFileSync("bin/serve.mjs", "utf8");
  serveCode = serveCode.replace(/^#!\/usr\/bin\/env -S npx tsx\n/, "#!/usr/bin/env node\n");
  fs.writeFileSync("bin/serve.mjs", serveCode);
  console.log("✅ bin/serve.mjs compiled successfully.");

  // 2. Build wtft.mjs
  await build({
    entryPoints: ["bin/wtft.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: "bin/wtft.mjs"
  });

  let wtftCode = fs.readFileSync("bin/wtft.mjs", "utf8");
  wtftCode = wtftCode.replace(/^#!\/usr\/bin\/env -S node --experimental-strip-types\n/, "#!/usr/bin/env node\n");
  fs.writeFileSync("bin/wtft.mjs", wtftCode);
  console.log("✅ bin/wtft.mjs compiled successfully.");

  // 3. Build merge.mjs
  await build({
    entryPoints: ["bin/merge.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: "bin/merge.mjs"
  });

  let mergeCode = fs.readFileSync("bin/merge.mjs", "utf8");
  mergeCode = mergeCode.replace(/^#!\/usr\/bin\/env node\n/, ""); // strip if present
  mergeCode = "#!/usr/bin/env node\n" + mergeCode;
  fs.writeFileSync("bin/merge.mjs", mergeCode);
  console.log("✅ bin/merge.mjs compiled successfully.");
}

buildAll().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});

import { build } from "esbuild";
import fs from "fs";

async function buildAll() {
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
  // For wtft, we use the shared library but need to stitch it to the pure JS bin logic
  await build({
    entryPoints: ["extensions/lib/wtft-shared.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: "debug/wtft-shared.mjs"
  });

  let shared = fs.readFileSync("debug/wtft-shared.mjs", "utf8");
  let bin = fs.readFileSync("bin/wtft.mjs", "utf8");

  const parts = bin.split("// --- END INLINED LOGIC ---");
  const header = bin.split("// --- INLINED FROM extensions/lib/wtft-shared.ts ---")[0];

  let finalCode = `${header}// --- INLINED FROM extensions/lib/wtft-shared.ts ---
${shared}
// --- END INLINED LOGIC ---${parts[1]}`;

  // Strip duplicate path imports
  finalCode = finalCode.replace(/\/\/ --- INLINED FROM extensions\/lib\/wtft-shared\.ts ---\nimport \* as path from "node:path";\n/, "// --- INLINED FROM extensions/lib/wtft-shared.ts ---\n");

  fs.writeFileSync("bin/wtft.mjs", finalCode);
  fs.unlinkSync("debug/wtft-shared.mjs");
  console.log("✅ bin/wtft.mjs compiled successfully.");
}

buildAll().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});

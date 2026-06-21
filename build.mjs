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
}

buildAll().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});

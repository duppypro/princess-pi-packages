#!/usr/bin/env node
// ---
// verify-daemon-parse.mjs — compare daemon tag file cost vs fresh direct parse + dedup
//
// Usage: node debug/verify-daemon-parse.mjs --session <path/to/session.jsonl>
//
// This is the extracted --debug logic from wtft. It answers: did the daemon's
// incremental parse miss or double-count anything compared to a full fresh parse?
// ---
import { readClassifiedTagFile, parseSessionFile, deduplicateInteractions, getTagPath } from "../bin/wtft.mjs";

function main() {
  const args = process.argv.slice(2);
  let sessionPath = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--session" || args[i] === "-s") && i + 1 < args.length) {
      sessionPath = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: node debug/verify-daemon-parse.mjs --session <path/to/session.jsonl>");
      console.log("");
      console.log("Compare daemon tag-file cost vs a fresh full parse+dedup of the session.");
      console.log("Three totals printed: tag file (daemon), direct parse+dedup, raw parse (no dedup).");
      process.exit(0);
    }
  }

  if (!sessionPath) {
    console.error("Error: --session <path> is required");
    process.exit(1);
  }

  const tagPath = getTagPath(sessionPath);

  // Tag file (daemon's cached output)
  let tagInteractions = [];
  try {
    tagInteractions = readClassifiedTagFile(tagPath);
  } catch {
    console.log("Tag file not found or unreadable. Daemon may not have run yet.");
  }
  const tagCost = tagInteractions.reduce((sum, i) => sum + (i.cost || 0), 0);

  // Direct parse + dedup (fresh full re-parse)
  const rawInteractions = parseSessionFile(sessionPath);
  const dedupedRaw = deduplicateInteractions(rawInteractions);
  const directCost = dedupedRaw.reduce((sum, i) => sum + i.cost, 0);
  const rawCost = rawInteractions.reduce((sum, i) => sum + i.cost, 0);

  console.log(`Session: ${sessionPath}`);
  console.log(`Tag:     ${tagPath}`);
  console.log("");
  console.log(`  tag file (daemon):       $${tagCost.toFixed(4)}  (${tagInteractions.length} entries)`);
  console.log(`  direct parse+dedup:      $${directCost.toFixed(4)}  (${dedupedRaw.length} entries)`);
  console.log(`  raw parse (no dedup):    $${rawCost.toFixed(4)}  (${rawInteractions.length} entries)`);

  if (tagCost !== directCost) {
    console.log("");
    console.log("⚠️  MISMATCH: tag file and direct parse+dedup costs differ.");
    console.log(`   Delta: $${(directCost - tagCost).toFixed(4)}`);
    process.exit(1);
  }

  console.log("");
  console.log("✅ Tag file matches direct parse+dedup.");
}

main();

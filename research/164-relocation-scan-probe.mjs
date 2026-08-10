// ---
// Probe: cost of a full-file scan for `"type":"relocated"` across every Claude
// transcript on this machine, vs the 8 KB tail scan #156 measured.
// Why: #164 needs the SET of dirs a session ever occupied; relocation entries
// are scattered through the file, so a tail window cannot see the earliest one.
// ---
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const root = process.env.WTFT_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
const SKIP = new Set(["subagents", "tool-results", "memory", "wtft-tags"]);
const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); }
    else if (e.name.endsWith(".jsonl")) files.push(full);
  }
}
walk(root);

let bytes = 0, hits = 0, withReloc = 0;
const t0 = performance.now();
for (const f of files) {
  const st = fs.statSync(f);
  bytes += st.size;
  const text = fs.readFileSync(f, "utf8");
  let n = 0, i = 0;
  while ((i = text.indexOf('"type":"relocated"', i)) !== -1) { n++; i += 18; }
  hits += n;
  if (n) withReloc++;
}
const ms = performance.now() - t0;
console.log(JSON.stringify({
  files: files.length,
  mb: +(bytes / 1e6).toFixed(1),
  filesWithRelocated: withReloc,
  relocatedEntries: hits,
  fullScanMs: +ms.toFixed(1),
}, null, 2));

// Where do relocation entries sit? (offset as a fraction of file size)
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  const offs = [];
  let i = 0;
  while ((i = text.indexOf('"type":"relocated"', i)) !== -1) { offs.push(i); i += 18; }
  if (!offs.length) continue;
  const size = text.length;
  console.log(path.basename(f).slice(0, 8),
    "size", size,
    "first@", (offs[0] / size).toFixed(3),
    "last@", (offs[offs.length - 1] / size).toFixed(3),
    "tail8k?", offs.some(o => o >= size - 8192));
}

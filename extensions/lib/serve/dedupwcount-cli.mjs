#!/usr/bin/env node
import readline from "node:readline";
import { createDedupState, ingestLine } from "./dedupwcount.mjs";

const state = createDedupState();
const isTTY = !!process.stdout.isTTY;
let hasInlineUpdate = false;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const out = ingestLine(state, line);
  if (out.kind === "base") {
    if (isTTY && hasInlineUpdate) {
      process.stdout.write("\n");
      hasInlineUpdate = false;
    }
    process.stdout.write(`${out.text}\n`);
    return;
  }

  if (isTTY) {
    process.stdout.write(`\r${out.text}\x1b[K`);
    hasInlineUpdate = true;
  } else {
    process.stdout.write(`${out.text}\n`);
  }
});

rl.on("close", () => {
  if (isTTY && hasInlineUpdate) {
    process.stdout.write("\n");
  }
});

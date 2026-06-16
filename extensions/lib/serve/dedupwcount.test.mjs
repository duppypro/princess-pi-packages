import test from "node:test";
import assert from "node:assert/strict";
import { compressLines, createDedupState, ingestLine } from "./dedupwcount.mjs";

test("collapses identical consecutive lines with incrementing up count", () => {
  const lines = ["ping", "ping", "ping", "pong"];
  const out = compressLines(lines);
  assert.deepEqual(out, ["ping", "☝️ +1", "☝️ +2", "pong"]);
});

test("tracks numeric ranges and gap classification for number-only changes", () => {
  const lines = ["tick=3", "tick=4", "tick=6", "tick=9"];
  const out = compressLines(lines);
  assert.equal(out[1], "☝️ +1 (#1=[3-4] up, smooth)");
  assert.equal(out[2], "☝️ +2 (#1=[3-4, 6] up, gappy)");
  assert.equal(out[3], "☝️ +3 (#1=[3-4, 6, 9] up, gappy)");
});

test("supports monotonic letter streams as variable tokens", () => {
  const state = createDedupState();
  ingestLine(state, "zone A");
  const u1 = ingestLine(state, "zone B");
  const u2 = ingestLine(state, "zone C");
  assert.equal(u1.text, "☝️ +1 (@1=[A-B] up, smooth)");
  assert.equal(u2.text, "☝️ +2 (@1=[A-C] up, smooth)");
});

test("resets grouping when text pattern changes", () => {
  const lines = ["status=1", "status=2", "other=3", "other=4"];
  const out = compressLines(lines);
  assert.equal(out[2], "other=3");
  assert.equal(out[3], "☝️ +1 (#1=[3-4] up, smooth)");
});

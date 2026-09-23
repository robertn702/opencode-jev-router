import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileEvidence } from "./evidence.mjs";

const tokens = { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } };
const start = (timestamp, messageID) => ({ type: "step_start", timestamp, part: { messageID } });
const finish = (timestamp, messageID) => ({ type: "step_finish", timestamp, part: { messageID, tokens } });
const decision = (timestamp) => ({ ts: new Date(timestamp).toISOString(), input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 });

test("auxiliary calls before and between steps count, but cannot replace a missing step", () => {
  const output = [start(1000, "a"), finish(2000, "a"), start(3000, "b"), finish(4000, "b")];
  assert.equal(reconcileEvidence([decision(500), decision(1500), decision(2500), decision(3500)], output), null);
  assert.deepEqual(reconcileEvidence([decision(500), decision(1500), decision(3500)], output), { auxiliary: 1 });
  assert.deepEqual(reconcileEvidence([decision(1500), decision(2500), decision(3500)], output), { auxiliary: 1 });
  assert.equal(reconcileEvidence([decision(1500), decision(3500), decision(4500)], output), null);
  assert.equal(reconcileEvidence([decision(1500), decision(3500), { ...decision(3600), input_tokens: 5 }], output), null);
  assert.equal(reconcileEvidence([decision(500), decision(1500), decision(2500)], output), null);
  assert.equal(reconcileEvidence([decision(1500), decision(1600), decision(3500)], output), null);
  assert.deepEqual(reconcileEvidence([decision(1200), { ...decision(1500), input_tokens: 5 }, decision(3500)], output), { auxiliary: 1 });
  assert.equal(reconcileEvidence([decision(1500), { ...decision(1600), input_tokens: 5 }, decision(2500)], output), null);
  assert.equal(reconcileEvidence([decision(1200), decision(1500), decision(3500)], output), null);
  assert.equal(reconcileEvidence([decision(1500), decision(3500)], output), null);
  assert.equal(reconcileEvidence([decision(1500)], [start(1000, "a"), finish(2000, "a")]), null);
  assert.equal(reconcileEvidence([decision(1500), decision(20000)], [start(1000, "a"), finish(2000, "a")]), null);
});

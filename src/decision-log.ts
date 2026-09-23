import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, dirname } from "node:path";

import { formatDecisionEvent, type Evidence } from "./evidence.js";

/** Enqueue metadata only; disk I/O and failures never enter the request path. */
export function createDecisionLogger(path: string, onFailure: () => void = () => console.error(JSON.stringify({ event: "decision_log_failed" }))): (evidence: Evidence) => void {
  if (!isAbsolute(path)) throw new Error("decisionsLogPath must be an absolute path");
  let pending = 0;
  let queue = Promise.resolve();
  return (evidence) => {
    if (!evidence.effort || pending >= 256) return;
    try {
      const line = `${formatDecisionEvent(evidence)}\n`;
      pending += 1;
      queue = queue.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await appendFile(path, line, { mode: 0o600 });
      }).catch(() => {
        try { onFailure(); } catch { /* diagnostics must not affect the queue */ }
      }).finally(() => { pending -= 1; });
    } catch { /* formatting/queue failures must not affect generation */ }
  };
}

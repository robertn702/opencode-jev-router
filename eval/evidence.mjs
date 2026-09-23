// Match each agent step with a router decision by time and exact upstream usage.
// A provider request outside any step (such as a session title) still counts
// toward total usage, but cannot substitute for a missing step decision.
export function reconcileEvidence(events, output) {
  const starts = new Map();
  const steps = [];
  for (const item of output) {
    if (item.type === "step_start") {
      if (!item.part?.messageID || starts.has(item.part.messageID) || !Number.isFinite(item.timestamp)) return null;
      starts.set(item.part.messageID, item.timestamp);
    } else if (item.type === "step_finish") {
      const start = starts.get(item.part?.messageID);
      if (start === undefined || !Number.isFinite(item.timestamp) || item.timestamp < start) return null;
      starts.delete(item.part.messageID);
      steps.push({ start, end: item.timestamp, tokens: item.part.tokens });
    }
  }
  if (!steps.length || starts.size) return null;
  let auxiliary = 0;
  const firstContinuation = steps[1]?.start ?? steps[0].end + 10_000;
  const within = steps.map(() => []);
  for (const event of events) {
    const time = Date.parse(event.ts);
    if (!Number.isFinite(time)) return null;
    // Router log completion can precede OpenCode's step_start emission by a
    // few milliseconds; keep a small clock/serialization allowance.
    const index = steps.findIndex((step) => time >= step.start - 100 && time <= step.end);
    if (index < 0) {
      if (time >= firstContinuation) return null;
      auxiliary++;
      continue;
    }
    within[index].push(event);
  }
  for (const [index, decisions] of within.entries()) {
    const tokens = steps[index].tokens;
    if (!tokens || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output) ||
        !Number.isFinite(tokens.reasoning) || !Number.isFinite(tokens.cache?.read) || !Number.isFinite(tokens.cache?.write)) return null;
    const matching = decisions.filter((event) => event.input_tokens === tokens.input + tokens.cache.read + tokens.cache.write &&
      event.cached_input_tokens === tokens.cache.read && event.output_tokens === tokens.output + tokens.reasoning);
    if (matching.length !== 1) return null;
    if (decisions.length > 1 && index !== 0) return null;
    auxiliary += decisions.length - 1;
  }
  // The observed OpenCode run shape has one early auxiliary request. Requiring
  // that count and position prevents it replacing a missing step decision.
  // This is a shape check, not a claim to know the auxiliary request's purpose.
  return auxiliary === 1 ? { auxiliary } : null;
}

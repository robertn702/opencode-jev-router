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
  // The observed run shape has exactly one additional provider call. Its
  // completion may occur before, during, or just after the second agent step.
  if (events.length !== steps.length + 1) return null;
  const candidates = steps.map(() => []);
  for (const [eventIndex, event] of events.entries()) {
    const time = Date.parse(event.ts);
    if (!Number.isFinite(time)) return null;
    for (const [index, step] of steps.entries()) {
      // Allow a small log/step serialization difference, but never match by
      // usage alone across unrelated steps.
      if (time < step.start - 100 || time > step.end) continue;
      const tokens = step.tokens;
      if (!tokens || !Number.isFinite(tokens.input) || !Number.isFinite(tokens.output) ||
          !Number.isFinite(tokens.reasoning) || !Number.isFinite(tokens.cache?.read) || !Number.isFinite(tokens.cache?.write)) return null;
      if (event.input_tokens === tokens.input + tokens.cache.read + tokens.cache.write &&
          event.cached_input_tokens === tokens.cache.read && event.output_tokens === tokens.output + tokens.reasoning) {
        candidates[index].push(eventIndex);
      }
    }
  }
  if (candidates.some((matches) => matches.length !== 1)) return null;
  const matched = candidates.map(([index]) => index);
  if (new Set(matched).size !== steps.length || matched.some((index, i) => i > 0 && index <= matched[i - 1])) return null;
  const extraIndex = events.findIndex((_, index) => !matched.includes(index));
  const extra = events[extraIndex];
  const extraTime = Date.parse(extra.ts);
  const second = steps[1] ?? steps[0];
  const next = steps[2]?.start ?? Infinity;
  if (extraTime >= next || extraTime > second.end + 10_000) return null;
  if (steps.some(({ tokens }) => extra.input_tokens === tokens.input + tokens.cache.read + tokens.cache.write &&
      extra.cached_input_tokens === tokens.cache.read && extra.output_tokens === tokens.output + tokens.reasoning)) return null;
  // The extra call cannot be silently substituted for a missing step call;
  // every step above must have its own unique usage-and-time match.
  const agent = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const index of matched) {
    const event = events[index];
    for (const field of Object.keys(agent)) agent[field] += event[field];
  }
  return { auxiliary: 1, agent };
}

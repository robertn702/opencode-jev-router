import { createHash } from "node:crypto";
import type { Effort } from "./models.js";

const CONFIGURATION_UPDATE = "configuration_update";
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

type Update = { at: number; effort: Effort };
type ExplicitUpdate = Update & { item: unknown; fingerprint: string };
type Entry = { scope: string; hashes: string[]; updates: Update[]; explicit: Array<{ at: number; fingerprint: string }>; currentAt: number; currentInjected: boolean; expiresAt: number };
type PendingAttempt = { value: string; count: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasoningEffort(item: unknown): Effort | null {
  if (!isRecord(item) || item.type !== CONFIGURATION_UPDATE || !isRecord(item.reasoning)) return null;
  return typeof item.reasoning.effort === "string" ? item.reasoning.effort as Effort : null;
}

// This intentionally retains only fixed-size hashes and positions.  Raw input,
// tool output, cache keys, and credentials never leave the request path.
export class LineageStore {
  private entries: Entry[] = [];
  private readonly resets = new Map<string, "reset_expired" | "reset_evicted" | "reset_ambiguous">();
  private readonly pending = new Map<string, Map<string, PendingAttempt>>();

  constructor(private readonly capacity = 256, private readonly ttlMs = 600_000) {}

  prepare(input: unknown[], scopeParts: unknown[] | null, effort: Effort) {
    const now = Date.now();
    this.entries = this.entries.filter((entry) => {
      if (entry.expiresAt > now) return true;
      this.rememberReset(entry.scope, "reset_expired");
      return false;
    });
    const scope = scopeParts === null ? null : hash(scopeParts);
    const quarantined = scope !== null && this.resets.get(scope) === "reset_ambiguous";
    const content: unknown[] = [];
    const explicit: ExplicitUpdate[] = [];
    for (const item of input) {
      const selected = reasoningEffort(item);
      if (selected === null) content.push(item);
      else explicit.push({ at: content.length, effort: selected, item, fingerprint: hash(item) });
    }
    const hashes = content.map(hash);
    const candidates = scope === null || quarantined ? [] : this.entries.filter((entry) =>
      entry.scope === scope && entry.hashes.length <= hashes.length && entry.hashes.every((value, index) => value === hashes[index]) &&
      // A caller update at a known injected boundary must agree. Otherwise an
      // edited replay would silently inherit the old effort.
      entry.explicit.every((known) => explicit.some((update) => update.at === known.at && update.fingerprint === known.fingerprint)) &&
      explicit.every((update) => (update.at > entry.hashes.length || (update.at === entry.hashes.length && !entry.updates.some((known) => known.at === update.at))) || entry.explicit.some((known) => known.at === update.at && known.fingerprint === update.fingerprint) ||
        entry.updates.some((known) => known.at === update.at && hash({ type: CONFIGURATION_UPDATE, reasoning: { effort: known.effort } }) === update.fingerprint)),
    );
    const prior = candidates.sort((a, b) => b.hashes.length - a.hashes.length)[0];
    const exact = prior !== undefined && prior.hashes.length === hashes.length;
    const updates = prior?.updates.map((update) => ({ ...update })) ?? [];
    const priorEffort = updates.at(-1)?.effort ?? explicit.at(-1)?.effort ?? null;

    // A byte-for-byte logical retry replaces this request's injected update,
    // rather than adding one beside it. Explicit caller history is immutable.
    if (exact && prior.currentInjected) {
      const index = updates.findIndex((update) => update.at === prior.currentAt && update.effort === priorEffort);
      if (index >= 0) updates.splice(index, 1);
    }
    const firstNew = prior?.hashes.length ?? 0;
    let nextUser = -1;
    let lastToolOutput = -1;
    for (let index = firstNew; index < content.length; index++) {
      const item = content[index];
      if (isRecord(item) && (item.type === "message" || item.type === undefined) && item.role === "user") nextUser = index;
      if (isRecord(item) && (item.type === "function_call_output" || item.type === "custom_tool_call_output")) lastToolOutput = index;
    }
    // There is no subsequent user turn in a tool continuation. Put the update
    // after the tool result so it applies to the resumed assistant generation.
    // A later user starts a new turn even when tool output appears earlier.
    // Only a suffix with no new user is a tool continuation.
    // An exact retry has no new turn. Reuse the original request boundary;
    // appending at the tail would put the update after its user message.
    const currentAt = exact ? prior.currentAt : lastToolOutput > nextUser ? hashes.length : nextUser >= 0 ? nextUser : hashes.length;
    for (let index = updates.length - 1; index >= 0; index--) {
      if (explicit.some((update) => update.at === updates[index]!.at && update.effort === updates[index]!.effort)) updates.splice(index, 1);
    }
    const suppliedAtCurrent = explicit.some((update) => update.at === currentAt && update.effort === effort);
    const conflictingCallerUpdate = explicit.some((update) => update.at === currentAt && update.effort !== effort);
    const historyEffort = [...updates, ...explicit]
      .filter((update) => update.at <= currentAt)
      .sort((a, b) => a.at - b.at)
      .at(-1)?.effort;
    const currentInjected = !suppliedAtCurrent && !conflictingCallerUpdate && historyEffort !== effort;
    if (currentInjected) updates.push({ at: currentAt, effort });
    updates.sort((a, b) => a.at - b.at);

    const replayed = updates.filter((update) => update.at < currentAt).length;
    let status = scope === null ? "untracked" : quarantined ? "reset_ambiguous" : prior ? "preserved" :
      this.entries.some((entry) => entry.scope === scope) ? "reset_edited" : this.resets.get(scope) ?? "new";
    const byPosition = new Map<number, Update[]>();
    for (const update of updates) byPosition.set(update.at, [...(byPosition.get(update.at) ?? []), update]);
    const explicitByPosition = new Map<number, ExplicitUpdate[]>();
    for (const update of explicit) explicitByPosition.set(update.at, [...(explicitByPosition.get(update.at) ?? []), update]);
    const output: unknown[] = [];
    for (let at = 0; at <= content.length; at++) {
      // Explicit updates retain their original position. A conflicting update
      // at the selected boundary is reported as unsafe instead of emitting an
      // adjacent pair whose effective effort would be the caller's value.
      for (const update of byPosition.get(at) ?? []) output.push({ type: CONFIGURATION_UPDATE, reasoning: { effort: update.effort } });
      for (const update of explicitByPosition.get(at) ?? []) output.push(update.item);
      if (at < content.length) output.push(content[at]);
    }
    // The loop above groups explicit updates at their original semantic
    // boundary, while generated updates are reconstructed from metadata.
    const pendingKey = hash(hashes);
    const pendingValue = hash([currentAt, updates]);
    let ambiguous = quarantined;
    if (scope !== null && !ambiguous) {
      const attempts = this.pending.get(scope) ?? new Map<string, PendingAttempt>();
      const priorAttempt = attempts.get(pendingKey);
      if (priorAttempt !== undefined && priorAttempt.value !== pendingValue) {
        this.quarantine(scope);
        ambiguous = true;
        status = "reset_ambiguous";
      } else {
        attempts.set(pendingKey, { value: pendingValue, count: (priorAttempt?.count ?? 0) + 1 });
        this.pending.set(scope, attempts);
      }
    }
    const discard = (): void => {
      if (scope === null) return;
      const attempts = this.pending.get(scope);
      if (!attempts) return;
      const attempt = attempts.get(pendingKey);
      if (attempt?.value === pendingValue) {
        if (attempt.count > 1) attempt.count -= 1;
        else attempts.delete(pendingKey);
      }
      if (attempts.size === 0) this.pending.delete(scope);
    };
    return {
      input: output,
      previousEffort: priorEffort,
      status,
      replayed,
      unsafe: conflictingCallerUpdate,
      commit: (): void => {
        discard();
        if (scope === null || hashes.length > 20_000) return;
        if (this.resets.get(scope) === "reset_ambiguous") return;
        const exactEntry = this.entries.find((entry) => entry.scope === scope && entry.hashes.length === hashes.length && entry.hashes.every((value, index) => value === hashes[index]));
        const explicitMetadata = explicit.map(({ at, fingerprint }) => ({ at, fingerprint }));
        if (exactEntry && (exactEntry.currentAt !== currentAt || exactEntry.currentInjected !== currentInjected || JSON.stringify(exactEntry.updates) !== JSON.stringify(updates) || JSON.stringify(exactEntry.explicit) !== JSON.stringify(explicitMetadata))) {
          this.quarantine(scope);
          return;
        }
        this.entries = this.entries.filter((entry) => !(entry.scope === scope && entry.hashes.length === hashes.length && entry.hashes.every((value, index) => value === hashes[index])));
        this.entries.push({ scope, hashes, updates, explicit: explicit.map(({ at, fingerprint }) => ({ at, fingerprint })), currentAt, currentInjected, expiresAt: now + this.ttlMs });
        while (this.entries.length > this.capacity) {
          const evicted = this.entries.shift();
          if (evicted) this.rememberReset(evicted.scope, "reset_evicted");
        }
      },
      discard,
    };
  }

  private quarantine(scope: string): void {
    this.entries = this.entries.filter((entry) => entry.scope !== scope);
    this.pending.delete(scope);
    this.rememberReset(scope, "reset_ambiguous");
  }

  private rememberReset(scope: string, status: "reset_expired" | "reset_evicted" | "reset_ambiguous"): void {
    this.resets.delete(scope);
    this.resets.set(scope, status);
    while (this.resets.size > this.capacity) this.resets.delete(this.resets.keys().next().value!);
  }
}

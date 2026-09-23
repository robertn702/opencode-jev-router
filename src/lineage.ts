import { createHash } from "node:crypto";
import type { Effort } from "./rewrite.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Entry = { scope: string; hashes: string[]; updates: Array<{ at: number; effort: Effort }>; expires: number };

// Stores hashes and update positions, never conversation text or credentials.
export class LineageStore {
  private entries: Entry[] = [];
  constructor(private capacity = 256, private ttlMs = 600_000) {}

  prepare(input: unknown[], scopeParts: string[] | null, effort: Effort) {
    const now = Date.now();
    this.entries = this.entries.filter((entry) => entry.expires > now);
    const scope = scopeParts ? hash(scopeParts) : null;
    const hashes = input.map(hash);
    const prior = scope === null ? undefined : this.entries.filter((entry) =>
      entry.scope === scope && entry.hashes.length <= hashes.length &&
      entry.hashes.every((value, i) => hashes[i] === value),
    ).sort((a, b) => b.hashes.length - a.hashes.length)[0];
    const updates = prior ? prior.updates.map((update) => ({ ...update })) : [];
    const previous = updates.at(-1)?.effort ?? null;
    // An identical input can be a retry or a branch: replace the boundary update,
    // retaining the prefix before that boundary.
    if (updates.at(-1)?.at === input.length) updates.pop();
    if (updates.at(-1)?.effort !== effort) updates.push({ at: input.length, effort });
    const output: unknown[] = [];
    for (let i = 0; i <= input.length; i++) {
      for (const update of updates) if (update.at === i) output.push({ type: "configuration_update", reasoning: { effort: update.effort } });
      if (i < input.length) output.push(input[i]);
    }
    const status = prior ? "preserved" : scope && this.entries.some((entry) => entry.scope === scope) ? "reset" : "new";
    return {
      input: output, previousEffort: previous, status,
      replayed: updates.filter((update) => update.at < input.length).length,
      commit: () => {
        if (!scope || hashes.length > 20_000) return;
        this.entries = this.entries.filter((entry) => !(entry.scope === scope && entry.hashes.length === hashes.length && entry.hashes.every((v, i) => v === hashes[i])));
        this.entries.push({ scope, hashes, updates, expires: now + this.ttlMs });
        this.entries = this.entries.slice(-this.capacity);
      },
    };
  }
}

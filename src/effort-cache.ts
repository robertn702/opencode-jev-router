import type { Effort } from "./rewrite.js";

// Map insertion order is LRU order. Expiry is checked on access and the oldest
// entries are swept on insertion; no timer or full-map scan is needed.
export class EffortCache {
  private readonly entries = new Map<string, { effort: Effort; expiresAt: number }>();

  constructor(private readonly capacity: number, private readonly ttlMs: number) {}

  get(key: string): Effort | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.effort;
  }

  set(key: string, effort: Effort): void {
    this.entries.delete(key);
    this.entries.set(key, { effort, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }
}

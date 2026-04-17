import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

interface PersistedDismissed {
  domain: string;
  schemaVersion: 1;
  keys: Array<{ key: string; dismissedAt: number }>;
}

export interface DismissedEntry { key: string; dismissedAt: number; }

export interface DiscoveryDismissedStoreOptions {
  domain: string;
  persistPath: string;
}

export class DiscoveryDismissedStore {
  private entries = new Map<string, number>();  // key -> dismissedAt
  private domain: string;
  private persistPath: string;

  constructor(opts: DiscoveryDismissedStoreOptions) {
    this.domain = opts.domain;
    this.persistPath = opts.persistPath;
  }

  load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedDismissed;
      if (data.schemaVersion !== 1) return;
      this.entries = new Map(data.keys.map((e) => [e.key, e.dismissedAt]));
    } catch {}
  }

  private save(): void {
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const data: PersistedDismissed = {
      domain: this.domain,
      schemaVersion: 1,
      keys: [...this.entries.entries()].map(([key, dismissedAt]) => ({ key, dismissedAt })),
    };
    writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  has(key: string): boolean { return this.entries.has(key); }

  add(key: string): void {
    if (!key) return;
    if (this.entries.has(key)) return;
    this.entries.set(key, Date.now());
    this.save();
  }

  addMany(keys: string[]): void {
    let changed = false;
    const now = Date.now();
    for (const k of keys) {
      if (k && !this.entries.has(k)) { this.entries.set(k, now); changed = true; }
    }
    if (changed) this.save();
  }

  restore(key: string): boolean {
    if (this.entries.delete(key)) { this.save(); return true; }
    return false;
  }

  list(): DismissedEntry[] {
    return [...this.entries.entries()]
      .map(([key, dismissedAt]) => ({ key, dismissedAt }))
      .sort((a, b) => b.dismissedAt - a.dismissedAt);
  }

  clear(): void { this.entries.clear(); this.save(); }
}

import * as fs from 'fs';
import * as path from 'path';

// Per-domain persistent set of dismissed endpoint ids. Filter at catalog
// ingest so dismissed endpoints never re-surface. Parallel to
// discovery-dismissed but keyed by ep_<id> rather than cssPath.

interface Persisted {
  domain: string;
  schemaVersion: number;
  ids: Array<{ id: string; dismissedAt: number }>;
}

export interface DismissedEndpointEntry {
  id: string;
  dismissedAt: number;
}

export class EndpointDismissedStore {
  private domain: string;
  private filePath: string;
  private entries = new Map<string, number>(); // id → dismissedAt
  private dirty = false;

  constructor(opts: { domain: string; persistPath: string }) {
    this.domain = opts.domain;
    this.filePath = opts.persistPath;
  }

  load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Persisted;
      if (data.domain !== this.domain) return;
      this.entries = new Map(data.ids.map((e) => [e.id, e.dismissedAt]));
    } catch {
      this.entries = new Map();
    }
  }

  private persist(): void {
    if (!this.dirty) return;
    const payload: Persisted = {
      domain: this.domain,
      schemaVersion: 1,
      ids: [...this.entries.entries()].map(([id, dismissedAt]) => ({ id, dismissedAt })),
    };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
      this.dirty = false;
    } catch {}
  }

  add(id: string): void {
    this.entries.set(id, Date.now());
    this.dirty = true;
    this.persist();
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  restore(id: string): boolean {
    const ok = this.entries.delete(id);
    if (ok) { this.dirty = true; this.persist(); }
    return ok;
  }

  list(): DismissedEndpointEntry[] {
    return [...this.entries.entries()]
      .map(([id, dismissedAt]) => ({ id, dismissedAt }))
      .sort((a, b) => b.dismissedAt - a.dismissedAt);
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
    this.persist();
  }
}

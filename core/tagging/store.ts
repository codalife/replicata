import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { SCHEMA_VERSION, type PersistedTags, type Tag } from './types.js';

export interface TagStoreOptions {
  domain: string;
  persistPath: string;
}

export class TagStore {
  private tags: Tag[] = [];
  private domain: string;
  private persistPath: string;

  constructor(opts: TagStoreOptions) {
    this.domain = opts.domain;
    this.persistPath = opts.persistPath;
  }

  load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedTags;
      if (data.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `tag file schemaVersion ${data.schemaVersion} != expected ${SCHEMA_VERSION}`,
        );
      }
      this.tags = data.tags;
    } catch (err) {
      throw new Error(`failed to load tags from ${this.persistPath}: ${(err as Error).message}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const data: PersistedTags = {
      domain: this.domain,
      schemaVersion: SCHEMA_VERSION,
      tags: this.tags,
    };
    writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  add(tag: Tag): void {
    this.tags.push(tag);
    this.save();
  }

  all(): Tag[] {
    return [...this.tags];
  }

  byId(id: string): Tag | undefined {
    return this.tags.find((t) => t.id === id);
  }

  remove(id: string): boolean {
    const before = this.tags.length;
    this.tags = this.tags.filter((t) => t.id !== id);
    const removed = this.tags.length < before;
    if (removed) this.save();
    return removed;
  }

  replace(id: string, updated: Tag): boolean {
    const idx = this.tags.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    this.tags[idx] = updated;
    this.save();
    return true;
  }

  get size(): number {
    return this.tags.length;
  }
}

import { EventEmitter } from 'events';
import type { PickedElement } from '../tagging/types.js';

export type DiscoverySource = 'react-commit' | 'initial-scan' | 'mutation';
export type Presence = 'present' | 'removed';

export interface DiscoveryEvent {
  key: string;
  info: PickedElement;
  handlerKinds: string[];
  signals: string[];
  source: DiscoverySource;
  presence: Presence;
}

export interface DiscoveryCandidate {
  id: string;
  key: string;
  picked: PickedElement;
  handlerKinds: string[];
  signals: string[];
  sources: DiscoverySource[];
  presence: Presence;
  firstSeen: number;
  lastSeen: number;
  removedAt: number | null;
  mutationCount: number;
  groupId?: string | null;
}

export class DiscoveryTracker extends EventEmitter {
  private byKey = new Map<string, DiscoveryCandidate>();
  private idCounter = 0;
  private readonly max = 500;

  ingest(events: DiscoveryEvent[]): void {
    const now = Date.now();
    for (const e of events) {
      if (!e.key) continue;
      const existing = this.byKey.get(e.key);
      if (existing) {
        existing.lastSeen = now;
        existing.mutationCount++;
        existing.picked = e.info;
        if (e.handlerKinds.length > 0) {
          existing.handlerKinds = mergeUnique(existing.handlerKinds, e.handlerKinds);
        }
        if (e.signals.length > 0) {
          existing.signals = mergeUnique(existing.signals, e.signals);
        }
        if (!existing.sources.includes(e.source)) existing.sources.push(e.source);
        if (e.presence === 'removed') {
          existing.presence = 'removed';
          existing.removedAt = now;
        } else if (existing.presence === 'removed') {
          existing.presence = 'present';
          existing.removedAt = null;
        }
      } else {
        if (this.byKey.size >= this.max) this.evictOldest();
        this.byKey.set(e.key, {
          id: 'disc_' + (++this.idCounter),
          key: e.key,
          picked: e.info,
          handlerKinds: [...e.handlerKinds],
          signals: [...e.signals],
          sources: [e.source],
          presence: e.presence,
          firstSeen: now,
          lastSeen: now,
          removedAt: e.presence === 'removed' ? now : null,
          mutationCount: 1,
        });
      }
    }
    this.emit('changed');
  }

  list(): DiscoveryCandidate[] {
    return [...this.byKey.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  byId(id: string): DiscoveryCandidate | undefined {
    for (const c of this.byKey.values()) if (c.id === id) return c;
    return undefined;
  }

  dismiss(id: string): boolean {
    for (const [k, c] of this.byKey) {
      if (c.id === id) { this.byKey.delete(k); this.emit('changed'); return true; }
    }
    return false;
  }

  dismissByCssPath(cssPath: string): boolean {
    if (this.byKey.delete(cssPath)) { this.emit('changed'); return true; }
    return false;
  }

  clear(): void {
    this.byKey.clear();
    this.emit('changed');
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, c] of this.byKey) {
      if (c.lastSeen < oldestTs) { oldestTs = c.lastSeen; oldestKey = k; }
    }
    if (oldestKey) this.byKey.delete(oldestKey);
  }
}

function mergeUnique<T>(a: T[], b: T[]): T[] {
  const set = new Set<T>(a);
  for (const x of b) set.add(x);
  return [...set];
}

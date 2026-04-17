// Endpoint catalog — mirrors the Discovery/Tags UX for the network layer.
//
// Every fetch observed in the real app gets normalized (numeric / uuid
// segments → :id / :uuid) and keyed by method + normalized path. Users
// expose named endpoints from the catalog to make them replayable by
// the renderer (via replicata's /stream/:endpointId route).
//
// Non-streaming endpoints cache the last response body; streaming
// endpoints buffer chunks (via StreamBuffer, keyed by endpointId).

import { EventEmitter } from 'events';

export type EndpointKind = 'stream' | 'json' | 'other';

export interface EndpointSample {
  url: string;           // last observed raw URL (incl. query string)
  status: number;
  contentType: string;
  bytes: number;
  ts: number;            // observed time
}

export interface Endpoint {
  id: string;            // `ep_<hash>` — stable id per method+normalizedPath
  method: string;        // GET / POST / ...
  normalizedPath: string; // /backend-api/conversation/:id
  kind: EndpointKind;
  hitCount: number;
  firstSeen: number;
  lastSeen: number;
  sample: EndpointSample;
  exposedAs?: string;    // user-chosen name (unique per domain) — present iff exposed
}

// ============================================================
// URL normalization
// ============================================================

const UUID_RE = /^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{20,}$/i;
const NUM_RE = /^\d+$/;

export function normalizePath(pathname: string): string {
  const segs = pathname.split('/').map((seg) => {
    if (!seg) return seg;
    if (NUM_RE.test(seg)) return ':id';
    if (UUID_RE.test(seg)) return ':uuid';
    if (HEX_RE.test(seg)) return ':hex';
    return seg;
  });
  return segs.join('/');
}

export function endpointIdFor(method: string, normalizedPath: string): string {
  // Cheap stable hash: method + path → 8-char base36. Collisions unlikely at this scale.
  const s = method.toUpperCase() + ' ' + normalizedPath;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return 'ep_' + (h >>> 0).toString(36);
}

// Match an actual path against a normalized/templated path. Placeholder
// segments (starting with ':') accept anything; static segments must equal.
export function pathMatchesPattern(actualPath: string, pattern: string): boolean {
  const aSegs = actualPath.split('/');
  const pSegs = pattern.split('/');
  if (aSegs.length !== pSegs.length) return false;
  for (let i = 0; i < pSegs.length; i++) {
    if (pSegs[i].startsWith(':')) continue;
    if (pSegs[i] !== aSegs[i]) return false;
  }
  return true;
}

export function inferKind(contentType: string): EndpointKind {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('event-stream') || ct.includes('ndjson') || ct.includes('x-ndjson')) return 'stream';
  if (ct.includes('json')) return 'json';
  return 'other';
}

// ============================================================
// Catalog
// ============================================================

export interface ObservedRequest {
  url: string;
  method: string;
  status: number;
  contentType: string;
  bytes: number;
}

export class EndpointCatalog extends EventEmitter {
  private byId = new Map<string, Endpoint>();
  // Last non-stream response body per endpoint id. Size-capped upstream.
  private bodies = new Map<string, { body: string; contentType: string; status: number; ts: number }>();

  observe(req: ObservedRequest): Endpoint {
    const u = safeParseUrl(req.url);
    const pathname = u?.pathname ?? req.url;
    const method = (req.method || 'GET').toUpperCase();
    const now = Date.now();
    const kind = inferKind(req.contentType);
    const sample: EndpointSample = {
      url: req.url,
      status: req.status,
      contentType: req.contentType,
      bytes: req.bytes,
      ts: now,
    };

    // Step 1: if any exposed entry's pattern matches this request, attribute
    // the hit to the exposed entry (absorbs e.g. /alice/repo into the
    // user-defined :username/:repo pattern). Also catch first-seen if it
    // was hydrated from disk with empty timestamps.
    for (const ep of this.byId.values()) {
      if (!ep.exposedAs) continue;
      if (ep.method !== method) continue;
      if (!pathMatchesPattern(pathname, ep.normalizedPath)) continue;
      ep.hitCount++;
      ep.lastSeen = now;
      ep.sample = sample;
      if (ep.firstSeen === 0) ep.firstSeen = now;
      if (ep.kind !== 'stream' && kind === 'stream') ep.kind = 'stream';
      this.emit('changed');
      return ep;
    }

    // Step 2: standard dedup by id (method + auto-normalized path).
    const normalizedPath = normalizePath(pathname);
    const id = endpointIdFor(method, normalizedPath);
    let ep = this.byId.get(id);
    if (!ep) {
      ep = {
        id,
        method,
        normalizedPath,
        kind,
        hitCount: 1,
        firstSeen: now,
        lastSeen: now,
        sample,
      };
      this.byId.set(id, ep);
    } else {
      ep.hitCount++;
      ep.lastSeen = now;
      ep.sample = sample;
      if (ep.kind !== 'stream' && kind === 'stream') ep.kind = 'stream';
    }
    this.emit('changed');
    return ep;
  }

  getById(id: string): Endpoint | undefined {
    return this.byId.get(id);
  }

  list(): Endpoint[] {
    return [...this.byId.values()];
  }

  exposeAs(id: string, name: string, customPath?: string): boolean {
    const ep = this.byId.get(id);
    if (!ep) return false;
    // Enforce unique name across exposed entries.
    for (const other of this.byId.values()) {
      if (other.id !== id && other.exposedAs === name) return false;
    }
    ep.exposedAs = name;
    if (customPath && customPath !== ep.normalizedPath) {
      ep.normalizedPath = customPath;
      // Sweep: absorb other catalog entries whose path now matches the
      // user-defined pattern. Sum hit counts, keep the most recent sample.
      for (const other of [...this.byId.values()]) {
        if (other.id === id) continue;
        if (other.exposedAs) continue; // never absorb another exposed entry
        if (other.method !== ep.method) continue;
        if (!pathMatchesPattern(other.normalizedPath, customPath)) continue;
        ep.hitCount += other.hitCount;
        if (other.lastSeen > ep.lastSeen) {
          ep.lastSeen = other.lastSeen;
          ep.sample = other.sample;
        }
        if (other.firstSeen && (ep.firstSeen === 0 || other.firstSeen < ep.firstSeen)) {
          ep.firstSeen = other.firstSeen;
        }
        this.byId.delete(other.id);
      }
    }
    this.emit('changed');
    return true;
  }

  unexpose(id: string): boolean {
    const ep = this.byId.get(id);
    if (!ep || !ep.exposedAs) return false;
    delete ep.exposedAs;
    this.emit('changed');
    return true;
  }

  cacheBody(id: string, body: string, contentType: string, status: number): void {
    this.bodies.set(id, { body, contentType, status, ts: Date.now() });
    this.emit('body-cached', id);
  }

  getCachedBody(id: string): { body: string; contentType: string; status: number; ts: number } | undefined {
    return this.bodies.get(id);
  }

  onBodyCached(id: string, cb: () => void): () => void {
    const handler = (cachedId: string) => { if (cachedId === id) cb(); };
    this.on('body-cached', handler);
    return () => this.off('body-cached', handler);
  }

  findByRequest(method: string, pathname: string): Endpoint | undefined {
    const normalizedPath = normalizePath(pathname);
    const id = endpointIdFor(method, normalizedPath);
    return this.byId.get(id);
  }

  remove(id: string): boolean {
    const ok = this.byId.delete(id);
    if (ok) this.emit('changed');
    return ok;
  }

  clear(): void {
    this.byId.clear();
    this.emit('changed');
  }

  hydrate(eps: Endpoint[]): void {
    this.byId.clear();
    for (const e of eps) this.byId.set(e.id, e);
    this.emit('changed');
  }
}

function safeParseUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

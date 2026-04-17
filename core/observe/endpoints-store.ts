import * as fs from 'fs';
import * as path from 'path';
import type { Endpoint } from './endpoints.js';

// Persist only the user-exposed entries per domain. The full catalog
// (uncataloged + stats) lives in memory — rebuilds as the user re-browses.
// What matters across restarts is: the named route patterns the user chose.
//
// File shape (~/.replicata/apis/<domain>.json):
// {
//   "domain": "chatgpt.com",
//   "schemaVersion": 1,
//   "exposed": [
//     { "id": "ep_xxx", "name": "chat", "method": "POST",
//       "normalizedPath": "/backend-api/conversation" }
//   ]
// }

const SCHEMA_VERSION = 1;

interface Persisted {
  domain: string;
  schemaVersion: number;
  exposed: Array<{ id: string; name: string; method: string; normalizedPath: string }>;
}

export class EndpointStore {
  private domain: string;
  private filePath: string;

  constructor(opts: { domain: string; persistPath: string }) {
    this.domain = opts.domain;
    this.filePath = opts.persistPath;
  }

  load(): Array<{ id: string; name: string; method: string; normalizedPath: string }> {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Persisted;
      if (data.domain !== this.domain) return [];
      return data.exposed ?? [];
    } catch {
      return [];
    }
  }

  save(eps: Endpoint[]): void {
    const exposed = eps
      .filter((e) => !!e.exposedAs)
      .map((e) => ({ id: e.id, name: e.exposedAs!, method: e.method, normalizedPath: e.normalizedPath }));
    const payload: Persisted = { domain: this.domain, schemaVersion: SCHEMA_VERSION, exposed };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
    } catch {}
  }
}

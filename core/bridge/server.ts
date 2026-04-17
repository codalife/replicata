import * as http from 'http';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { StreamBuffer } from './stream-buffer.js';
import type { StreamChunk } from '../observe/network.js';
import type { TaggingApi } from '../tagging/api.js';
import type { PickedElement } from '../tagging/types.js';
import type { TargetInfo } from '../observe/targets.js';
import type { DiscoveryCandidate } from '../observe/discovery.js';
import type { DiscoveryGroup, GroupColor } from '../observe/discovery-groups.js';
import type { DismissedEntry } from '../observe/discovery-dismissed.js';
import { normalizePath as normalizePathFor, type Endpoint } from '../observe/endpoints.js';
import { NO_SCENARIO, corruptChunk, type Scenario } from './scenarios.js';

export interface TargetsApi {
  list: () => TargetInfo[];
  assignRealApp: (targetId: string) => Promise<void>;
  assignRenderer: (targetId: string) => Promise<void>;
  unassignRealApp: () => Promise<void>;
  unassignRenderer: () => Promise<void>;
  getAssignments: () => { realApp: string | null; renderer: string | null };
}

// UI assets resolution:
//   - Compiled binary: ui/ ships alongside the binary (see scripts/build-binaries.mjs).
//   - tsx / node dev: UI lives at <repo>/dist/ui/ (from tsc + vite build).
// We probe both; first hit wins.
function resolveUiDir(): string {
  const candidates: string[] = [];
  // Tarball layout: wrapper sets REPLICATA_ROOT to the install dir.
  if (process.env.REPLICATA_ROOT) {
    candidates.push(resolve(process.env.REPLICATA_ROOT, 'ui'));
  }
  // Fallbacks: execDir (if binary is at install root, rare) or dev layout.
  const execDir = dirname(process.execPath);
  candidates.push(resolve(execDir, 'ui'));
  candidates.push(resolve(execDir, '../ui'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '../../ui'));   // tsc build output
    candidates.push(resolve(here, '../ui'));      // dev run from source
  } catch { /* bundled CJS — no import.meta.url */ }
  for (const c of candidates) {
    if (existsSync(resolve(c, 'index.html'))) return c;
  }
  return candidates[0];
}

const UI_DIST_DIR = resolveUiDir();
const UI_HTML_PATH = resolve(UI_DIST_DIR, 'index.html');

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.map': 'application/json',
};

export interface DiscoveryApi {
  list: () => DiscoveryCandidate[];
  dismiss: (id: string) => boolean;
  clear: () => void;
  getById: (id: string) => DiscoveryCandidate | undefined;
  highlight: (id: string) => Promise<boolean>;
  listGroups: () => DiscoveryGroup[];
  createGroup: (name: string, color: GroupColor) => DiscoveryGroup | null;
  updateGroup: (id: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }) => DiscoveryGroup | null;
  deleteGroup: (id: string) => boolean;
  assignGroup: (discoveryId: string, groupId: string | null) => boolean;
  listDismissed: () => DismissedEntry[];
  restoreDismissed: (key: string) => boolean;
  clearDismissed: () => void;
}

export interface EndpointApi {
  list: () => Endpoint[];
  get: (id: string) => Endpoint | undefined;
  getCachedBody: (id: string) => { body: string; contentType: string; status: number; ts: number } | undefined;
  expose: (id: string, name: string, normalizedPath?: string) => boolean;
  unexpose: (id: string) => boolean;
  clear: () => void;
  dismiss: (id: string) => boolean;
  listDismissed: () => Array<{ id: string; dismissedAt: number }>;
  restoreDismissed: (id: string) => boolean;
  clearDismissed: () => void;
  onBodyCached: (id: string, cb: () => void) => () => void;
}

export interface ReplicataServerOptions {
  host: string;
  port: number;
  buffer: StreamBuffer;
  tagging: TaggingApi;
  targets: TargetsApi;
  discovery: DiscoveryApi;
  endpoints: EndpointApi;
  getScenario: () => Scenario;
  setScenario: (s: Scenario) => void;
  getMachineSnapshot: () => unknown;
}

export class ReplicataServer {
  private server: http.Server;
  private buffer: StreamBuffer;
  private tagging: TaggingApi;
  private host: string;
  private port: number;
  private lastServedStreamId: string | null = null;
  private warnings: Array<{ ts: number; msg: string }> = [];
  private lastWarningId = 0;
  private sseClients: Set<http.ServerResponse> = new Set();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private getScenario: () => Scenario;
  private setScenario: (s: Scenario) => void;
  private getMachineSnapshot: () => unknown;
  private targetsApi: TargetsApi;
  private discoveryApi: DiscoveryApi;
  private endpointsApi: EndpointApi;

  pushWarning(msg: string): void {
    const entry = { ts: Date.now(), msg };
    this.warnings.push(entry);
    this.lastWarningId++;
    if (this.warnings.length > 50) this.warnings.shift();
    this.broadcast('warning', entry);
  }

  pushState(snapshot: unknown): void {
    this.broadcast('state', snapshot);
  }

  pushEndpoints(eps: Endpoint[]): void {
    this.broadcast('endpoints', eps);
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch {}
    }
  }

  constructor(opts: ReplicataServerOptions) {
    this.buffer = opts.buffer;
    this.tagging = opts.tagging;
    this.targetsApi = opts.targets;
    this.discoveryApi = opts.discovery;
    this.endpointsApi = opts.endpoints;
    this.host = opts.host;
    this.port = opts.port;
    this.getScenario = opts.getScenario;
    this.setScenario = opts.setScenario;
    this.getMachineSnapshot = opts.getMachineSnapshot;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        this.heartbeatTimer = setInterval(() => {
          for (const res of this.sseClients) {
            try { res.write(`: hb\n\n`); } catch {}
          }
        }, 15_000);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const res of this.sseClients) { try { res.end(); } catch {} }
    this.sseClients.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  get url(): string {
    return `http://${this.host}:${this.port}`;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);

    if (url.pathname === '/stream') {
      this.handleStream(req, res);
    } else if (url.pathname.match(/^\/stream\/ep_[\w]+$/)) {
      this.handleStreamByEndpoint(url.pathname.split('/')[2], req, res);
    } else if (url.pathname === '/endpoints' && req.method === 'GET') {
      this.handleEndpointsList(res);
    } else if (url.pathname === '/endpoints' && req.method === 'DELETE') {
      this.endpointsApi.clear();
      res.writeHead(204); res.end();
    } else if (url.pathname.match(/^\/endpoints\/ep_[\w]+\/expose$/) && req.method === 'POST') {
      this.handleExposeEndpoint(url.pathname.split('/')[2], req, res);
    } else if (url.pathname.match(/^\/endpoints\/ep_[\w]+\/expose$/) && req.method === 'DELETE') {
      this.handleUnexposeEndpoint(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/endpoints\/ep_[\w]+$/) && req.method === 'DELETE') {
      const ok = this.endpointsApi.dismiss(url.pathname.split('/')[2]);
      res.writeHead(ok ? 204 : 404); res.end();
    } else if (url.pathname === '/endpoints/dismissed' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.endpointsApi.listDismissed()));
    } else if (url.pathname === '/endpoints/dismissed' && req.method === 'DELETE') {
      this.endpointsApi.clearDismissed();
      res.writeHead(204); res.end();
    } else if (url.pathname === '/endpoints/dismissed/restore' && req.method === 'POST') {
      this.handleRestoreDismissedEndpoint(req, res);
    } else if (url.pathname === '/status') {
      this.handleStatus(res);
    } else if (url.pathname === '/events' && req.method === 'GET') {
      this.handleEvents(req, res);
    } else if (url.pathname === '/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getMachineSnapshot()));
    } else if (url.pathname === '/feedback' && req.method === 'POST') {
      this.handleFeedback(req, res);
    } else if (url.pathname === '/warnings' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lastId: this.lastWarningId, items: since < this.lastWarningId ? this.warnings.slice(-(this.lastWarningId - since)) : [] }));
    } else if (url.pathname === '/streams' && req.method === 'GET') {
      this.handleStreamsList(res);
    } else if (url.pathname === '/streams' && req.method === 'DELETE') {
      this.handleStreamsClear(res);
    } else if (url.pathname.match(/^\/streams\/[\w-]+\/bytes$/) && req.method === 'GET') {
      this.handleStreamBytes(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/streams\/[\w-]+\/chunks$/) && req.method === 'GET') {
      this.handleStreamChunks(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/streams\/[\w-]+$/) && req.method === 'DELETE') {
      this.handleStreamDelete(url.pathname.split('/')[2], res);
    } else if (url.pathname === '/tag/start' && req.method === 'POST') {
      this.handleTagStart(res);
    } else if (url.pathname === '/tag/name' && req.method === 'POST') {
      this.handleTagName(req, res);
    } else if (url.pathname === '/tag/cancel' && req.method === 'POST') {
      this.handleTagCancel(res);
    } else if (url.pathname === '/tags' && req.method === 'GET') {
      this.handleTagsList(res);
    } else if (url.pathname === '/scenario' && req.method === 'GET') {
      this.handleScenarioGet(res);
    } else if (url.pathname === '/scenario' && req.method === 'POST') {
      this.handleScenarioSet(req, res);
    } else if (url.pathname === '/targets' && req.method === 'GET') {
      this.handleTargetsList(res);
    } else if (url.pathname === '/assignments' && req.method === 'GET') {
      this.handleAssignments(res);
    } else if (url.pathname === '/assign' && req.method === 'POST') {
      this.handleAssign(req, res);
    } else if (url.pathname === '/unassign' && req.method === 'POST') {
      this.handleUnassign(req, res);
    } else if (url.pathname === '/highlight/clear' && req.method === 'POST') {
      this.handleClearHighlight(res);
    } else if (url.pathname === '/discovery' && req.method === 'GET') {
      this.handleDiscoveryList(res);
    } else if (url.pathname === '/discovery' && req.method === 'DELETE') {
      this.handleDiscoveryClear(res);
    } else if (url.pathname.match(/^\/discovery\/disc_\d+\/tag$/) && req.method === 'POST') {
      this.handleDiscoveryTag(url.pathname.split('/')[2], req, res);
    } else if (url.pathname === '/discovery/dismissed' && req.method === 'GET') {
      this.handleDismissedList(res);
    } else if (url.pathname === '/discovery/dismissed' && req.method === 'DELETE') {
      this.handleDismissedClear(res);
    } else if (url.pathname === '/discovery/dismissed/restore' && req.method === 'POST') {
      this.handleDismissedRestore(req, res);
    } else if (url.pathname === '/discovery/groups' && req.method === 'GET') {
      this.handleGroupsList(res);
    } else if (url.pathname === '/discovery/groups' && req.method === 'POST') {
      this.handleGroupCreate(req, res);
    } else if (url.pathname.match(/^\/discovery\/groups\/grp_\d+$/) && req.method === 'PATCH') {
      this.handleGroupUpdate(url.pathname.split('/')[3], req, res);
    } else if (url.pathname.match(/^\/discovery\/groups\/grp_\d+$/) && req.method === 'DELETE') {
      this.handleGroupDelete(url.pathname.split('/')[3], res);
    } else if (url.pathname.match(/^\/discovery\/disc_\d+\/group$/) && req.method === 'POST') {
      this.handleDiscoveryAssignGroup(url.pathname.split('/')[2], req, res);
    } else if (url.pathname.match(/^\/discovery\/disc_\d+\/highlight$/) && req.method === 'POST') {
      this.handleDiscoveryHighlight(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/discovery\/disc_\d+$/) && req.method === 'DELETE') {
      this.handleDiscoveryDismiss(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+\/highlight$/) && req.method === 'POST') {
      this.handleHighlightTag(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+\/retag$/) && req.method === 'POST') {
      this.handleRetag(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+\/rename$/) && req.method === 'POST') {
      this.handleRename(url.pathname.split('/')[2], req, res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+\/broaden$/) && req.method === 'POST') {
      this.handleBroaden(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+\/timeline$/) && req.method === 'GET') {
      this.handleTimeline(url.pathname.split('/')[2], res);
    } else if (url.pathname.match(/^\/tag\/tag_[\w]+$/) && req.method === 'DELETE') {
      this.handleDeleteTag(url.pathname.split('/')[2], res);
    } else if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
      this.handleUi(url, res);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  }

  private handleEndpointsList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.endpointsApi.list()));
  }

  private async handleExposeEndpoint(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { name, normalizedPath } = JSON.parse(await readBody(req)) as { name: string; normalizedPath?: string };
      if (!name || !name.trim()) throw new Error('missing name');
      const ok = this.endpointsApi.expose(id, name, normalizedPath);
      if (!ok) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found or name taken' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.endpointsApi.get(id)));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleUnexposeEndpoint(id: string, res: http.ServerResponse): void {
    const ok = this.endpointsApi.unexpose(id);
    res.writeHead(ok ? 204 : 404);
    res.end();
  }

  private async handleRestoreDismissedEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { id } = JSON.parse(await readBody(req)) as { id: string };
      const ok = this.endpointsApi.restoreDismissed(id);
      res.writeHead(ok ? 204 : 404);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleStreamByEndpoint(endpointId: string, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ep = this.endpointsApi.get(endpointId);
    if (!ep) { res.writeHead(404); res.end('endpoint not found'); return; }

    if (ep.kind === 'stream') {
      const stream = this.pickServableStreamForEndpoint(ep);
      if (!stream) {
        this.waitAndServeNextForEndpoint(ep, res);
        return;
      }
      this.serveStream(res, stream);
      return;
    }

    // Non-stream endpoints: replay cached body. If nothing cached yet,
    // the endpoint might not be classified yet (first request) — wait
    // for a stream or cached body to appear.
    const cached = this.endpointsApi.getCachedBody(endpointId);
    if (cached) {
      res.writeHead(cached.status || 200, { 'Content-Type': cached.contentType || 'application/json' });
      res.end(cached.body);
      return;
    }

    // Nothing cached, endpoint might reclassify to stream. Wait.
    this.waitAndServeNextForEndpoint(ep, res);
  }

  private pickServableStreamForEndpoint(ep: Endpoint) {
    const streams = this.buffer.list();
    let candidate: typeof streams[0] | null = null;
    for (let i = streams.length - 1; i >= 0; i--) {
      const s = streams[i];
      try {
        const u = new URL(s.meta.url);
        const np = normalizePathFor(u.pathname);
        if (np !== ep.normalizedPath || s.meta.method.toUpperCase() !== ep.method) continue;
      } catch { continue; }
      // Found a matching stream. If it's still in-flight, wait for it
      // instead of falling through to an older completed one.
      if (!s.meta.done) return null;
      if (s.meta.streamId === this.lastServedStreamId) return null;
      candidate = s;
      break;
    }
    return candidate;
  }

  private async handleFeedback(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const { msg } = JSON.parse(body) as { msg: string };
      const entry = { ts: new Date().toISOString(), msg: (msg ?? '').slice(0, 5000) };
      const { homedir } = await import('os');
      const { appendFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const dir = join(homedir(), '.replicata');
      try { mkdirSync(dir, { recursive: true }); } catch {}
      try { appendFileSync(join(dir, 'feedback.jsonl'), JSON.stringify(entry) + '\n'); } catch {}
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 1000\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify(this.getMachineSnapshot())}\n\n`);
    this.sseClients.add(res);
    req.on('close', () => { this.sseClients.delete(res); });
  }

  private async handleStream(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const servable = this.pickServableStream();

    if (servable) {
      this.serveStream(res, servable);
      return;
    }

    this.waitAndServeNext(res);
  }

  private pickServableStream() {
    // Walk backwards: if the newest stream is still in-flight, wait for it.
    const latest = this.buffer.getLatest();
    if (!latest || latest.chunks.length === 0) return null;
    if (!latest.meta.done) return null;
    if (latest.meta.streamId === this.lastServedStreamId) return null;
    return latest;
  }

  private async serveStream(res: http.ServerResponse, stream: { meta: { streamId: string; done: boolean }; chunks: Array<{ data: string; msOffset: number }> }): Promise<void> {
    this.lastServedStreamId = stream.meta.streamId;

    const scenario = this.getScenario();

    if (scenario.kind === 'rate-limit') {
      res.writeHead(scenario.errorStatus ?? 429, { 'Content-Type': 'application/json' });
      res.end(scenario.errorBody ?? JSON.stringify({ error: 'rate_limited' }));
      return;
    }

    const ct = (stream.meta as any).contentType || 'text/event-stream';
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let clientClosed = false;
    res.on('close', () => { clientClosed = true; });

    const dropStart = scenario.dropStart ?? -1;
    const dropEnd = scenario.dropEnd ?? -1;
    const disconnectAt = scenario.kind === 'disconnect' ? (scenario.disconnectAt ?? -1) : -1;
    const latencyMult = scenario.kind === 'latency' ? (scenario.latencyMultiplier ?? 1) : 1;
    let malformedUsed = false;
    let prevOffset = 0;

    for (let i = 0; i < stream.chunks.length; i++) {
      if (clientClosed) return;
      if (disconnectAt >= 0 && i >= disconnectAt) break;

      const chunk = stream.chunks[i];
      const delta = (chunk.msOffset - prevOffset) * latencyMult;
      if (delta > 0) await sleep(delta);
      prevOffset = chunk.msOffset;

      if (scenario.kind === 'drop' && i >= dropStart && i <= dropEnd) continue;

      let data = chunk.data;
      if (scenario.kind === 'malformed' && !malformedUsed && data.trim().length > 4) {
        data = corruptChunk(data);
        malformedUsed = true;
      }

      res.write(data);
    }

    res.end();
  }

  private waitAndServeNext(res: http.ServerResponse): void {
    const timeout = setTimeout(() => {
      unsubscribe();
      res.end();
    }, 60_000);

    const unsubscribe = this.buffer.onStreamDone(() => {
      const servable = this.pickServableStream();
      if (!servable) return;
      clearTimeout(timeout);
      unsubscribe();
      this.serveStream(res, servable);
    });

    res.on('close', () => {
      clearTimeout(timeout);
      unsubscribe();
    });
  }

  private waitAndServeNextForEndpoint(ep: Endpoint, res: http.ServerResponse): void {
    const cleanup = () => {
      clearTimeout(timeout);
      unsubStream();
      unsubBody();
    };

    const tryServe = () => {
      const stream = this.pickServableStreamForEndpoint(ep);
      if (stream) {
        cleanup();
        this.serveStream(res, stream);
        return;
      }
      // Cached body path (endpoint might have reclassified or body arrived)
      const cached = this.endpointsApi.getCachedBody(ep.id);
      if (cached) {
        cleanup();
        res.writeHead(cached.status || 200, { 'Content-Type': cached.contentType || 'application/json' });
        res.end(cached.body);
        return;
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      res.writeHead(204);
      res.end();
    }, 60_000);

    const unsubStream = this.buffer.onStreamDone(() => tryServe());
    const unsubBody = this.endpointsApi.onBodyCached(ep.id, () => tryServe());

    res.on('close', () => cleanup());
  }

  private handleStatus(res: http.ServerResponse): void {
    const active = this.buffer.getActive();
    const latest = this.buffer.getLatest();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      streams: this.buffer.count,
      totalChunks: this.buffer.totalChunks,
      totalBytes: this.buffer.totalBytes,
      activeStream: active ? {
        streamId: active.meta.streamId,
        url: active.meta.url,
        chunks: active.chunks.length,
      } : null,
      latestStream: latest ? {
        streamId: latest.meta.streamId,
        url: latest.meta.url,
        chunks: latest.chunks.length,
        done: latest.meta.done,
      } : null,
    }));
  }

  private async handleTagStart(res: http.ServerResponse): Promise<void> {
    try {
      const picked = await this.tagging.startPicker();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(picked));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleTagCancel(res: http.ServerResponse): Promise<void> {
    await this.tagging.cancelPicker();
    res.writeHead(204);
    res.end();
  }

  private async handleTagName(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const { name, picked } = JSON.parse(body) as { name: string; picked: PickedElement };
      if (!name || !picked) {
        res.writeHead(400);
        res.end('missing name or picked');
        return;
      }
      const tag = this.tagging.createTag(name, picked);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tag));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleTagsList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.tagging.getTags()));
  }

  private async handleHighlightTag(id: string, res: http.ServerResponse): Promise<void> {
    try {
      const ok = await this.tagging.highlightTag(id);
      res.writeHead(ok ? 200 : 404);
      res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleClearHighlight(res: http.ServerResponse): Promise<void> {
    await this.tagging.clearHighlight();
    res.writeHead(204);
    res.end();
  }

  private async handleRetag(id: string, res: http.ServerResponse): Promise<void> {
    try {
      const picked = await this.tagging.startPicker();
      const updated = this.tagging.replaceLocator(id, picked);
      if (!updated) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'tag not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleDeleteTag(id: string, res: http.ServerResponse): void {
    const removed = this.tagging.removeTag(id);
    res.writeHead(removed ? 204 : 404);
    res.end();
  }

  private async handleRename(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { name } = JSON.parse(await readBody(req)) as { name: string };
      const result = this.tagging.renameTag(id, name);
      if (result.ok) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.tag));
        return;
      }
      const status = result.reason === 'not-found' ? 404 : result.reason === 'duplicate' ? 409 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.reason }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleBroaden(id: string, res: http.ServerResponse): Promise<void> {
    const updated = await this.tagging.broadenTag(id);
    if (!updated) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cannot broaden further' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
  }

  private handleTargetsList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.targetsApi.list()));
  }

  private handleAssignments(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.targetsApi.getAssignments()));
  }

  private async handleAssign(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { role, targetId } = JSON.parse(await readBody(req)) as { role: 'real-app' | 'renderer'; targetId: string };
      if (role === 'real-app') await this.targetsApi.assignRealApp(targetId);
      else if (role === 'renderer') await this.targetsApi.assignRenderer(targetId);
      else throw new Error('invalid role');
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleUnassign(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { role } = JSON.parse(await readBody(req)) as { role: 'real-app' | 'renderer' };
      if (role === 'real-app') await this.targetsApi.unassignRealApp();
      else if (role === 'renderer') await this.targetsApi.unassignRenderer();
      else throw new Error('invalid role');
      res.writeHead(204);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleScenarioGet(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.getScenario()));
  }

  private async handleScenarioSet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const scenario = JSON.parse(body) as Scenario;
      if (!scenario.kind) throw new Error('missing kind');
      this.setScenario(scenario);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scenario));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }


  private handleStreamsList(res: http.ServerResponse): void {
    const streams = this.buffer.list().map((s) => ({
      streamId: s.meta.streamId,
      url: s.meta.url,
      done: s.meta.done,
      chunks: s.chunks.length,
      bytes: s.chunks.reduce((n, c) => n + c.data.length, 0),
      startedAt: s.meta.startTime,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(streams));
  }

  private handleStreamBytes(streamId: string, res: http.ServerResponse): void {
    const stream = this.buffer.getById(streamId);
    if (!stream) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = stream.chunks.map((c) => c.data).join('');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  private handleStreamChunks(streamId: string, res: http.ServerResponse): void {
    const stream = this.buffer.getById(streamId);
    if (!stream) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stream.chunks.map(c => ({ data: c.data, ms: c.msOffset }))));
  }

  private handleStreamDelete(streamId: string, res: http.ServerResponse): void {
    const ok = this.buffer.remove(streamId);
    res.writeHead(ok ? 204 : 404);
    res.end();
  }

  private handleStreamsClear(res: http.ServerResponse): void {
    this.buffer.clear();
    res.writeHead(204);
    res.end();
  }

  private handleDismissedList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.discoveryApi.listDismissed()));
  }

  private async handleDismissedRestore(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { key } = JSON.parse(await readBody(req)) as { key: string };
      const ok = this.discoveryApi.restoreDismissed(key);
      res.writeHead(ok ? 204 : 404);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleDismissedClear(res: http.ServerResponse): void {
    this.discoveryApi.clearDismissed();
    res.writeHead(204);
    res.end();
  }

  private handleGroupsList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.discoveryApi.listGroups()));
  }

  private async handleGroupCreate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { name, color } = JSON.parse(await readBody(req)) as { name: string; color: GroupColor };
      const g = this.discoveryApi.createGroup(name, color);
      if (!g) { res.writeHead(409); res.end(JSON.stringify({ error: 'no real app assigned' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(g));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleGroupUpdate(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const patch = JSON.parse(await readBody(req)) as { name?: string; color?: GroupColor; collapsed?: boolean };
      const g = this.discoveryApi.updateGroup(id, patch);
      if (!g) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(g));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleGroupDelete(id: string, res: http.ServerResponse): void {
    const ok = this.discoveryApi.deleteGroup(id);
    res.writeHead(ok ? 204 : 404);
    res.end();
  }

  private async handleDiscoveryAssignGroup(discId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { groupId } = JSON.parse(await readBody(req)) as { groupId: string | null };
      const ok = this.discoveryApi.assignGroup(discId, groupId);
      res.writeHead(ok ? 204 : 404);
      res.end();
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleDiscoveryHighlight(id: string, res: http.ServerResponse): Promise<void> {
    try {
      const ok = await this.discoveryApi.highlight(id);
      res.writeHead(ok ? 200 : 404);
      res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleDiscoveryList(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(this.discoveryApi.list()));
  }

  private handleDiscoveryDismiss(id: string, res: http.ServerResponse): void {
    const ok = this.discoveryApi.dismiss(id);
    res.writeHead(ok ? 204 : 404);
    res.end();
  }

  private handleDiscoveryClear(res: http.ServerResponse): void {
    this.discoveryApi.clear();
    res.writeHead(204);
    res.end();
  }

  private async handleDiscoveryTag(id: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { name } = JSON.parse(await readBody(req)) as { name: string };
      if (!name || !name.trim()) throw new Error('missing name');
      const candidate = this.discoveryApi.getById(id);
      if (!candidate) { res.writeHead(404); res.end(); return; }
      const tag = this.tagging.createTag(name.trim(), candidate.picked);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tag));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private handleTimeline(id: string, res: http.ServerResponse): void {
    const tag = this.tagging.getTags().find((t) => t.id === id);
    if (!tag) {
      res.writeHead(404);
      res.end();
      return;
    }
    const timeline = this.tagging.getTimeline(tag.name);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(timeline));
  }

  private handleUi(url: URL, res: http.ServerResponse): void {
    if (url.pathname === '/ui' || url.pathname === '/ui/') {
      const html = readFileSync(UI_HTML_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }

    // Serve static assets from compiled UI output: /ui/app.js → dist/ui/app.js
    const asset = url.pathname.slice('/ui/'.length);
    if (!/^[\w.\-/]+$/.test(asset)) {
      res.writeHead(400);
      res.end('bad path');
      return;
    }

    const filePath = resolve(UI_DIST_DIR, asset);
    if (!filePath.startsWith(UI_DIST_DIR)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    try {
      const body = readFileSync(filePath);
      const ext = asset.slice(asset.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

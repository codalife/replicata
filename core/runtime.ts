import { EventEmitter } from 'events';
import type { Browser, Page } from 'playwright-core';
import { bootstrap, CdpConnectError } from './bootstrap/index.js';
import { NetworkTap, type StreamMeta, type StreamChunk } from './observe/network.js';
import { Picker } from './observe/picker.js';
import { Highlighter } from './observe/highlight.js';
import { TargetWatcher, type TargetInfo } from './observe/targets.js';
import { DiscoveryTracker, type DiscoveryCandidate, type DiscoveryEvent } from './observe/discovery.js';
import { DiscoveryGroupStore, type DiscoveryGroup, type GroupColor } from './observe/discovery-groups.js';
import { DiscoveryDismissedStore, type DismissedEntry } from './observe/discovery-dismissed.js';
import { EndpointCatalog, type Endpoint, endpointIdFor, normalizePath } from './observe/endpoints.js';
import { EndpointStore } from './observe/endpoints-store.js';
import { EndpointDismissedStore, type DismissedEndpointEntry } from './observe/endpoints-dismissed.js';
import { createActor, type Actor } from 'xstate';
import { replicataMachine, snapshotValue, type ReplicataStateSnapshot } from './machine.js';
import { StreamBuffer } from './bridge/stream-buffer.js';
import { ReplicataServer } from './bridge/server.js';
import { injectRendererBridge, pushRoutesToRenderer } from './bridge/renderer-route.js';
import { installInitScript, cleanupInitScripts } from './bridge/init-scripts.js';
import { TagStore } from './tagging/store.js';
import { TagResolver, type ResolutionResult } from './tagging/resolver.js';
import { TimelineStore, type TimelineEntry, type Source } from './tagging/timeline.js';
import { loadInjected, invokeInjected } from './injected/index.js';
import { NO_SCENARIO, type Scenario } from './bridge/scenarios.js';
import type { PickedElement, Tag } from './tagging/types.js';
import type { TaggingApi, TagWithResolution } from './tagging/api.js';
import { REPLICATA } from './config.js';
import * as path from 'path';
import * as os from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const TAGS_DIR = path.join(os.homedir(), '.replicata', 'tags');
const DISCOVERY_GROUPS_DIR = path.join(os.homedir(), '.replicata', 'discovery-groups');
const DISCOVERY_DISMISSED_DIR = path.join(os.homedir(), '.replicata', 'discovery-dismissed');
const APIS_DIR = path.join(os.homedir(), '.replicata', 'apis');
const APIS_DISMISSED_DIR = path.join(os.homedir(), '.replicata', 'endpoints-dismissed');
const ASSIGNMENTS_FILE = path.join(os.homedir(), '.replicata', 'assignments.json');

interface PersistedAssignments { realAppUrl?: string; rendererUrl?: string; }

function loadAssignments(): PersistedAssignments {
  if (!existsSync(ASSIGNMENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(ASSIGNMENTS_FILE, 'utf-8')) as PersistedAssignments; }
  catch { return {}; }
}

function saveAssignments(update: Partial<PersistedAssignments>): void {
  const current = loadAssignments();
  const next: PersistedAssignments = { ...current };
  for (const [k, v] of Object.entries(update)) {
    if (v === undefined) delete next[k as keyof PersistedAssignments];
    else next[k as keyof PersistedAssignments] = v as string;
  }
  mkdirSync(path.dirname(ASSIGNMENTS_FILE), { recursive: true });
  writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(next, null, 2), 'utf-8');
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export { CdpConnectError };

export interface RuntimeConfig {
  // No fields yet — kept for future config knobs (was: routePattern, retired
  // in Phase 4.5 in favor of per-endpoint exposure via UI).
}

export interface RuntimeEvents {
  'connecting': (attempt: number, delayMs: number) => void;
  'server-ready': (url: string) => void;
  'chrome-connected': () => void;
  'chrome-disconnected': () => void;
  'targets-changed': (targets: TargetInfo[]) => void;
  'real-app-assigned': (targetId: string, url: string) => void;
  'real-app-unassigned': () => void;
  'renderer-assigned': (targetId: string, url: string) => void;
  'renderer-unassigned': () => void;
  'stream-start': (meta: StreamMeta) => void;
  'chunk': (chunk: StreamChunk, meta: StreamMeta) => void;
  'stream-end': (meta: StreamMeta) => void;
  'tag-picked': (picked: PickedElement) => void;
  'tag-added': (tag: Tag) => void;
  'tag-removed': (id: string) => void;
  'tag-replaced': (tag: Tag) => void;
  'tag-verified': (id: string, result: ResolutionResult) => void;
  'pairs-changed': (names: string[]) => void;
  'event-forwarded': (tagName: string, type: string, fired: number) => void;
  'scenario-changed': (scenario: Scenario) => void;
  'warning': (msg: string) => void;
  'ready': () => void;
}

export class ReplicataRuntime implements TaggingApi {
  private config: RuntimeConfig;
  private events = new EventEmitter();

  // Core
  private browser?: Browser;
  private replicataUiPage?: Page;
  private targetWatcher?: TargetWatcher;
  private server?: ReplicataServer;

  // Shared stores
  private buffer = new StreamBuffer();
  private tagStore: TagStore | null = null;  // domain-scoped, created on real-app assign
  private timelines = new TimelineStore();
  private discovery = new DiscoveryTracker();
  private discoveryGroups: DiscoveryGroupStore | null = null;
  private discoveryDismissed: DiscoveryDismissedStore | null = null;
  private endpoints = new EndpointCatalog();
  private endpointStore: EndpointStore | null = null;
  private endpointsDismissed: EndpointDismissedStore | null = null;
  private machine: Actor<typeof replicataMachine> = createActor(replicataMachine);
  private scenario: Scenario = NO_SCENARIO;

  // Real-app side — all created on assign, dropped on unassign
  private realAppTargetId: string | null = null;
  private realAppPage?: Page;
  private tap?: NetworkTap;
  private picker?: Picker;
  private resolver?: TagResolver;
  private highlighter?: Highlighter;
  private resolutionByTagId = new Map<string, ResolutionResult>();
  private verifyLastRun = 0;
  private verifyScheduled: NodeJS.Timeout | null = null;
  private readonly VERIFY_MIN_INTERVAL_MS = 2000;

  // Renderer side
  private rendererTargetId: string | null = null;
  private rendererPage?: Page;
  private rendererPairs = new Set<string>();

  constructor(config: RuntimeConfig) {
    this.config = config;
  }

  on<E extends keyof RuntimeEvents>(event: E, listener: RuntimeEvents[E]): this {
    this.events.on(event, listener as (...args: any[]) => void);
    return this;
  }

  private emit<E extends keyof RuntimeEvents>(event: E, ...args: Parameters<RuntimeEvents[E]>): void {
    this.events.emit(event, ...args);
  }

  async start(): Promise<void> {
    this.machine.start();

    this.server = new ReplicataServer({
      host: REPLICATA.host,
      port: REPLICATA.port,
      buffer: this.buffer,
      tagging: this,
      targets: {
        list: () => this.listTargets(),
        assignRealApp: (id) => this.assignRealApp(id),
        assignRenderer: (id) => this.assignRenderer(id),
        unassignRealApp: () => this.unassignRealApp(),
        unassignRenderer: () => this.unassignRenderer(),
        getAssignments: () => this.getAssignments(),
      },
      endpoints: {
        list: () => this.listEndpoints(),
        get: (id) => this.getEndpoint(id),
        getCachedBody: (id) => this.getCachedBody(id),
        expose: (id, name, normalizedPath) => this.exposeEndpoint(id, name, normalizedPath),
        unexpose: (id) => this.unexposeEndpoint(id),
        clear: () => this.clearEndpoints(),
        dismiss: (id) => this.dismissEndpoint(id),
        listDismissed: () => this.listDismissedEndpoints(),
        restoreDismissed: (id) => this.restoreDismissedEndpoint(id),
        clearDismissed: () => this.clearDismissedEndpoints(),
        onBodyCached: (id, cb) => this.endpoints.onBodyCached(id, cb),
      },
      discovery: {
        list: () => this.listDiscoveryWithGroups(),
        dismiss: (id) => this.dismissAndPersist(id),
        clear: () => this.discovery.clear(),
        getById: (id) => this.discovery.byId(id),
        highlight: (id) => this.highlightDiscovery(id),
        listGroups: () => this.listGroups(),
        createGroup: (name, color) => this.createGroup(name, color),
        updateGroup: (id, patch) => this.updateGroup(id, patch),
        deleteGroup: (id) => this.deleteGroupAndDismiss(id),
        assignGroup: (discId, groupId) => this.assignDiscoveryGroup(discId, groupId),
        listDismissed: () => this.listDismissed(),
        restoreDismissed: (key) => this.restoreDismissed(key),
        clearDismissed: () => this.clearDismissed(),
      },
      getScenario: () => this.scenario,
      setScenario: (s) => { this.scenario = s; this.emit('scenario-changed', s); },
      getMachineSnapshot: () => this.getMachineSnapshot(),
    });
    await this.server.start();
    this.emit('server-ready', this.server.url);

    this.on('warning', (msg) => this.server?.pushWarning(msg));

    this.machine.subscribe(() => this.server?.pushState(this.getMachineSnapshot()));
    this.endpoints.on('changed', () => {
      this.server?.pushEndpoints(this.endpoints.list());
      // Live-update the renderer's route table when exposed set changes.
      if (this.rendererPage) {
        void pushRoutesToRenderer(this.rendererPage, this.exposedRoutes());
      }
    });
    await this.connectAndInit();

    this.emit('ready');
  }

  private reconnecting = false;

  private async connectAndInit(): Promise<void> {
    const { browser, replicataUiPage } = await bootstrap({
      replicataUiUrl: `${this.server!.url}/ui`,
      cdpPort: REPLICATA.cdpPort,
      onRetry: (attempt, delayMs) => this.emit('connecting', attempt, delayMs),
    });
    this.browser = browser;
    this.replicataUiPage = replicataUiPage;

    browser.on('disconnected', () => this.handleChromeDisconnect());

    await cleanupInitScripts(browser).catch(() => {});

    this.machine.send({ type: 'CDP_CONNECTED' });
    this.emit('chrome-connected');

    this.targetWatcher = new TargetWatcher(browser.contexts()[0], replicataUiPage);
    await this.targetWatcher.start();
    this.targetWatcher.on('changed', (targets: TargetInfo[]) => this.emit('targets-changed', targets));
    this.targetWatcher.on('destroyed', (targetId: string) => this.handleTargetDestroyed(targetId));
    this.targetWatcher.on('url-changed', (targetId: string, prev: string, next: string) => this.handleTargetUrlChanged(targetId, prev, next));

    void this.restoreAssignments();
  }

  private handleChromeDisconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.emit('warning', 'chrome disconnected — reconnecting…');
    this.machine.send({ type: 'CHROME_DISCONNECTED' });
    this.emit('chrome-disconnected');

    // Drop dead state; pages/sessions are gone
    this.browser = undefined;
    this.replicataUiPage = undefined;
    this.targetWatcher = undefined;
    this.realAppPage = undefined;
    this.realAppTargetId = null;
    this.rendererPage = undefined;
    this.rendererTargetId = null;
    this.tap = undefined;
    this.picker = undefined;
    this.resolver = undefined;
    this.highlighter = undefined;
    this.resolutionByTagId.clear();
    this.rendererPairs.clear();
    // NB: we keep persisted assignments file; restoreAssignments will re-match after reconnect
    this.emit('real-app-unassigned');
    this.emit('renderer-unassigned');

    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    try {
      await this.connectAndInit();
      this.machine.send({ type: 'CHROME_RECONNECTED' });
      this.emit('warning', 'chrome reconnected');
    } catch (err) {
      this.emit('warning', 'chrome reconnect failed: ' + (err as Error).message);
    } finally {
      this.reconnecting = false;
    }
  }

  private handleTargetDestroyed(targetId: string): void {
    if (this.realAppTargetId === targetId) {
      this.emit('warning', 'real app tab was closed — unassigning');
      void this.unassignRealApp();
    }
    if (this.rendererTargetId === targetId) {
      this.emit('warning', 'my app tab was closed — unassigning');
      void this.unassignRenderer();
    }
  }

  private handleTargetUrlChanged(targetId: string, prev: string, next: string): void {
    const prevHost = safeHost(prev);
    const nextHost = safeHost(next);
    if (this.realAppTargetId === targetId && prevHost !== nextHost) {
      this.emit('warning', `real app navigated ${prevHost} → ${nextHost} — unassigning`);
      void this.unassignRealApp();
    }
    if (this.rendererTargetId === targetId && !isLocalUrl(next)) {
      this.emit('warning', `my app left localhost (${nextHost}) — unassigning`);
      void this.unassignRenderer();
    }
  }

  private async restoreAssignments(): Promise<void> {
    const stored = loadAssignments();
    if (!stored.realAppUrl && !stored.rendererUrl) return;
    // Give CDP a moment to surface existing tabs
    await new Promise((r) => setTimeout(r, 500));
    const tabs = this.listTargets();
    if (stored.realAppUrl && !this.realAppTargetId) {
      const match = tabs.find((t) => t.url === stored.realAppUrl);
      if (match) await this.assignRealApp(match.targetId).catch(() => {});
    }
    if (stored.rendererUrl && !this.rendererTargetId) {
      const match = tabs.find((t) => t.url === stored.rendererUrl);
      if (match) await this.assignRenderer(match.targetId).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (this.verifyScheduled) clearTimeout(this.verifyScheduled);
    await this.picker?.cancel().catch(() => {});
    await this.highlighter?.dispose().catch(() => {});
    await this.targetWatcher?.stop().catch(() => {});
    if (this.server) await this.server.stop();
  }

  listTargets(): TargetInfo[] {
    const all = this.targetWatcher?.list() ?? [];
    const replicataUrl = this.server?.url;
    if (!replicataUrl) return all;
    return all.filter((t) => !t.url.startsWith(replicataUrl));
  }

  getMachineSnapshot(): ReplicataStateSnapshot {
    const snap = this.machine.getSnapshot();
    return snapshotValue(snap.value, snap.context);
  }

  getAssignments() {
    return {
      realApp: this.realAppTargetId,
      renderer: this.rendererTargetId,
      kataUi: null as string | null,  // replicataUiPage targetId; could track but unused
    };
  }

  // --- Real-app assignment ---

  async assignRealApp(targetId: string): Promise<void> {
    if (this.realAppTargetId === targetId) return;
    await this.unassignRealApp();
    this.machine.send({ type: 'ASSIGN_REAL', targetId });

    const page = await this.targetWatcher?.pageFor(targetId);
    if (!page) {
      this.machine.send({ type: 'REAL_FAILED', reason: 'tab not found' });
      throw new Error('tab not found');
    }
    // Belt-and-suspenders: UI picker filters out localhost for the real
    // role, but if the tab navigated between listing + assign, this catches
    // it. (Found by replicata-lifecycle.qnt: without this, a bound real tab can
    // sit at localhost and get persisted as such, breaking restore.)
    if (isLocalUrl(page.url())) {
      this.machine.send({ type: 'REAL_FAILED', reason: 'real app can\'t be a local URL' });
      throw new Error('real app can\'t be a local URL');
    }

    this.realAppPage = page;
    this.realAppTargetId = targetId;

    // Open TagStore scoped to this tab's domain
    const domain = new URL(page.url()).hostname;
    this.tagStore = new TagStore({
      domain,
      persistPath: path.join(TAGS_DIR, `${domain}.json`),
    });
    try { this.tagStore.load(); } catch {}

    this.discoveryGroups = new DiscoveryGroupStore({
      domain,
      persistPath: path.join(DISCOVERY_GROUPS_DIR, `${domain}.json`),
    });
    try { this.discoveryGroups.load(); } catch {}

    this.discoveryDismissed = new DiscoveryDismissedStore({
      domain,
      persistPath: path.join(DISCOVERY_DISMISSED_DIR, `${domain}.json`),
    });
    try { this.discoveryDismissed.load(); } catch {}

    if (this.tagStore) {
      for (const t of this.tagStore.all()) this.discoveryDismissed.restore(t.locator.cssPath);
    }

    // Rehydrate previously-exposed endpoints + dismissed set for this domain.
    this.endpoints.clear();
    this.endpointsDismissed = new EndpointDismissedStore({
      domain,
      persistPath: path.join(APIS_DISMISSED_DIR, `${domain}.json`),
    });
    try { this.endpointsDismissed.load(); } catch {}

    this.endpointStore = new EndpointStore({
      domain,
      persistPath: path.join(APIS_DIR, `${domain}.json`),
    });
    const persistedExposed = this.endpointStore.load();
    if (persistedExposed.length > 0) {
      this.endpoints.hydrate(persistedExposed.map((pe) => ({
        id: pe.id,
        method: pe.method,
        normalizedPath: pe.normalizedPath,
        kind: 'other' as const,
        hitCount: 0,
        firstSeen: 0,
        lastSeen: 0,
        sample: { url: pe.normalizedPath, status: 0, contentType: '', bytes: 0, ts: 0 },
        exposedAs: pe.name,
      })));
    }

    // Install observation pipeline
    this.tap = new NetworkTap(page, domain);
    this.picker = new Picker(page);
    this.resolver = new TagResolver(page);
    this.highlighter = new Highlighter(page);

    this.tap.on('stream-start', (meta) => { this.buffer.addStream(meta); this.machine.send({ type: 'REAL_STREAM_START' }); this.emit('stream-start', meta); });
    this.tap.on('chunk', (chunk, meta) => { this.buffer.addChunk(chunk); this.emit('chunk', chunk, meta); });
    this.tap.on('stream-end', (meta) => { this.buffer.markDone(meta.streamId); this.machine.send({ type: 'REAL_STREAM_END' }); this.emit('stream-end', meta); });
    this.tap.on('request', (req) => {
      try {
        const u = new URL(req.url);
        const pathname = u.pathname;
        const method = (req.method || 'GET').toUpperCase();
        const id = endpointIdFor(method, normalizePath(pathname));
        if (this.endpointsDismissed?.has(id)) return;
        this.endpoints.observe({ url: req.url, method: req.method, status: req.status, contentType: req.contentType, bytes: req.bytes });
      } catch {}
    });
    this.tap.on('response-body', (hint, body) => {
      const sep = hint.lastIndexOf('|');
      if (sep < 0) return;
      const url = hint.slice(0, sep);
      const method = hint.slice(sep + 1);
      try {
        const u = new URL(url);
        const ep = this.endpoints.findByRequest(method, u.pathname);
        if (ep) this.endpoints.cacheBody(ep.id, body, ep.sample.contentType, ep.sample.status);
      } catch {}
    });

    await this.installRealAppScripts(page);

    page.on('load', () => {
      void this.reinstallRealApp(page);
    });

    this.machine.send({ type: 'REAL_INSTALLED', url: page.url() });
    this.emit('real-app-assigned', targetId, page.url());
    saveAssignments({ realAppUrl: page.url() });
    void this.verifyAll();
  }

  private async installRealAppScripts(page: Page): Promise<void> {
    await this.tap!.start();
    await installInitScript(page, loadInjected('resolve-tag'));
    await page.exposeFunction('__replicataDomChanged', () => this.scheduleVerify()).catch(() => {});
    await installInitScript(page, loadInjected('dom-watch'));
    await page.exposeFunction('__replicataEvent', (tagName: string, type: string, detail: any) => {
      void this.forwardEvent(tagName, type, detail);
    }).catch(() => {});
    await installInitScript(page, loadInjected('event-tap'));
    await this.pushTagsToRealApp();
    await page.exposeFunction('__replicataStateSnapshot', (tagName: string, source: Source, entry: TimelineEntry) => {
      this.timelines.push(tagName, source, entry);
    }).catch(() => {});
    await installInitScript(page, loadInjected('state-tap'));
    await page.exposeFunction('__replicataDiscover', (events: DiscoveryEvent[]) => {
      const filtered = events.filter((e) =>
        !(this.discoveryDismissed?.has(e.key) ?? false),
      );
      if (filtered.length > 0) this.discovery.ingest(filtered);
    }).catch(() => {});
    await installInitScript(page, loadInjected('discovery'));
  }

  private async reinstallRealApp(page: Page): Promise<void> {
    try {
      const domain = new URL(page.url()).hostname;
      await page.evaluate(invokeInjected('fetch-tap', { domain }));
      await page.evaluate(loadInjected('resolve-tag'));
      await page.evaluate(loadInjected('dom-watch'));
      await page.evaluate(loadInjected('event-tap'));
      await page.evaluate(loadInjected('state-tap'));
      await page.evaluate(loadInjected('discovery'));
      await this.pushTagsToRealApp();
      void this.verifyAll();
    } catch (err) {
      this.emit('warning', `re-install after reload failed: ${(err as Error).message}`);
    }
  }

  private isAlreadyTagged(cssPath: string): boolean {
    if (!this.tagStore || !cssPath) return false;
    return this.tagStore.all().some((t) => t.locator.cssPath === cssPath);
  }

  async unassignRealApp(): Promise<void> {
    if (!this.realAppTargetId) return;
    if (this.verifyScheduled) { clearTimeout(this.verifyScheduled); this.verifyScheduled = null; }
    await this.picker?.cancel().catch(() => {});
    await this.highlighter?.dispose().catch(() => {});
    this.tap = undefined;
    this.picker = undefined;
    this.resolver = undefined;
    this.highlighter = undefined;
    this.realAppPage = undefined;
    this.realAppTargetId = null;
    this.resolutionByTagId.clear();
    this.discovery.clear();
    this.discoveryGroups = null;
    this.discoveryDismissed = null;
    this.endpoints.clear();
    this.endpointStore = null;
    this.endpointsDismissed = null;
    saveAssignments({ realAppUrl: undefined });
    this.machine.send({ type: 'UNASSIGN_REAL' });
    this.emit('real-app-unassigned');
  }

  // Discovery groups API
  private exposedRoutes() {
    return this.endpoints.list()
      .filter((e) => !!e.exposedAs)
      .map((e) => ({ id: e.id, method: e.method, normalizedPath: e.normalizedPath }));
  }

  listEndpoints(): Endpoint[] { return this.endpoints.list(); }
  getEndpoint(id: string): Endpoint | undefined { return this.endpoints.getById(id); }
  getCachedBody(id: string) { return this.endpoints.getCachedBody(id); }
  exposeEndpoint(id: string, name: string, normalizedPath?: string): boolean {
    const ok = this.endpoints.exposeAs(id, name.trim(), normalizedPath?.trim());
    if (ok) this.endpointStore?.save(this.endpoints.list());
    return ok;
  }
  unexposeEndpoint(id: string): boolean {
    const ok = this.endpoints.unexpose(id);
    if (ok) this.endpointStore?.save(this.endpoints.list());
    return ok;
  }
  clearEndpoints(): void {
    // Clear uncataloged only — keep exposed.
    const keep = this.endpoints.list().filter((e) => !!e.exposedAs);
    this.endpoints.hydrate(keep);
  }

  dismissEndpoint(id: string): boolean {
    const ep = this.endpoints.getById(id);
    if (!ep) return false;
    // Don't allow dismissing an exposed entry.
    if (ep.exposedAs) return false;
    this.endpointsDismissed?.add(id);
    this.endpoints.remove(id);
    return true;
  }
  listDismissedEndpoints(): DismissedEndpointEntry[] {
    return this.endpointsDismissed?.list() ?? [];
  }
  restoreDismissedEndpoint(id: string): boolean {
    return this.endpointsDismissed?.restore(id) ?? false;
  }
  clearDismissedEndpoints(): void {
    this.endpointsDismissed?.clear();
  }

  listDiscoveryWithGroups(): DiscoveryCandidate[] {
    const raw = this.discovery.list();
    if (!this.discoveryGroups) return raw;
    const store = this.discoveryGroups;
    return raw.map((c) => ({ ...c, groupId: store.groupOf(c.key) }));
  }

  listGroups(): DiscoveryGroup[] {
    return this.discoveryGroups?.listGroups() ?? [];
  }
  createGroup(name: string, color: GroupColor): DiscoveryGroup | null {
    return this.discoveryGroups?.createGroup(name, color) ?? null;
  }
  updateGroup(id: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }): DiscoveryGroup | null {
    return this.discoveryGroups?.updateGroup(id, patch) ?? null;
  }
  deleteGroup(id: string): boolean {
    return this.discoveryGroups?.deleteGroup(id) ?? false;
  }
  dismissAndPersist(discoveryId: string): boolean {
    const cand = this.discovery.byId(discoveryId);
    if (cand && this.discoveryDismissed) this.discoveryDismissed.add(cand.key);
    return this.discovery.dismiss(discoveryId);
  }

  deleteGroupAndDismiss(groupId: string): boolean {
    if (!this.discoveryGroups) return false;
    // Find all candidates currently in this group and persist their keys
    const membersKeys = this.discovery.list()
      .filter((c) => this.discoveryGroups!.groupOf(c.key) === groupId)
      .map((c) => c.key);
    if (this.discoveryDismissed && membersKeys.length > 0) {
      this.discoveryDismissed.addMany(membersKeys);
    }
    // Remove from tracker
    for (const k of membersKeys) {
      const cand = this.discovery.list().find((c) => c.key === k);
      if (cand) this.discovery.dismiss(cand.id);
    }
    return this.discoveryGroups.deleteGroup(groupId);
  }

  listDismissed(): DismissedEntry[] {
    return this.discoveryDismissed?.list() ?? [];
  }

  restoreDismissed(key: string): boolean {
    return this.discoveryDismissed?.restore(key) ?? false;
  }

  clearDismissed(): void {
    this.discoveryDismissed?.clear();
  }

  assignDiscoveryGroup(discoveryId: string, groupId: string | null): boolean {
    if (!this.discoveryGroups) return false;
    const cand = this.discovery.byId(discoveryId);
    if (!cand) return false;
    this.discoveryGroups.assignMember(cand.key, groupId);
    return true;
  }

  // --- Renderer assignment ---

  async assignRenderer(targetId: string): Promise<void> {
    if (this.rendererTargetId === targetId) return;
    await this.unassignRenderer();
    this.machine.send({ type: 'ASSIGN_MY', targetId });

    const page = await this.targetWatcher?.pageFor(targetId);
    if (!page) {
      this.machine.send({ type: 'MY_FAILED', reason: 'tab not found' });
      throw new Error('tab not found');
    }

    if (!isLocalUrl(page.url())) {
      this.machine.send({ type: 'MY_FAILED', reason: 'not a local url' });
      throw new Error('"my app" must be a local URL (localhost or 127.0.0.1)');
    }

    this.rendererPage = page;
    this.rendererTargetId = targetId;

    await this.installRendererScripts(page);

    page.on('load', () => {
      void this.reinstallRenderer(page);
    });

    this.machine.send({ type: 'MY_INSTALLED', url: page.url() });
    this.emit('renderer-assigned', targetId, page.url());
    saveAssignments({ rendererUrl: page.url() });
  }

  private async installRendererScripts(page: Page): Promise<void> {
    await injectRendererBridge(page, REPLICATA.host, REPLICATA.port, this.exposedRoutes());
    await page.exposeFunction('__replicataReportPairs', (names: string[]) => {
      this.rendererPairs = new Set(names);
      this.emit('pairs-changed', names);
    }).catch(() => {});
    await installInitScript(page, loadInjected('event-fire'));
    await page.exposeFunction('__replicataStateSnapshot', (tagName: string, source: Source, entry: TimelineEntry) => {
      this.timelines.push(tagName, source, entry);
    }).catch(() => {});
    await installInitScript(page, loadInjected('state-tap'));
  }

  private async reinstallRenderer(page: Page): Promise<void> {
    try {
      const src = invokeInjected('renderer-redirect', { host: REPLICATA.host, port: REPLICATA.port, routes: this.exposedRoutes() });
      await page.evaluate(src);
      await page.evaluate(loadInjected('event-fire'));
    } catch (err) {
      this.emit('warning', `re-install after renderer reload failed: ${(err as Error).message}`);
    }
  }

  async unassignRenderer(): Promise<void> {
    if (!this.rendererTargetId) return;
    this.rendererPage = undefined;
    this.rendererTargetId = null;
    this.rendererPairs.clear();
    saveAssignments({ rendererUrl: undefined });
    // If mid-replay, end it — the target is gone, the replay isn't
    // going anywhere. (Caught by replicata-lifecycle.qnt: without this,
    // stream=replaying + wiring=realOnly persists stale indefinitely.)
    const snap = this.machine.getSnapshot();
    const streamState = (snap.value as any)?.connected?.stream;
    if (streamState === 'replaying') this.machine.send({ type: 'REPLAY_END' });
    this.machine.send({ type: 'UNASSIGN_MY' });
    this.emit('renderer-unassigned');
  }

  // --- TaggingApi ---

  async startPicker(): Promise<PickedElement> {
    if (!this.picker) throw new Error('no real-app tab assigned');
    const picked = await this.picker.pick();
    this.emit('tag-picked', picked);
    return picked;
  }

  async cancelPicker(): Promise<void> {
    await this.picker?.cancel();
  }

  createTag(name: string, picked: PickedElement): Tag {
    if (!this.tagStore) throw new Error('no real-app tab assigned');
    const tag: Tag = {
      id: 'tag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name,
      locator: this.buildLocator(picked),
      capturedAt: Date.now(),
      preview: { tagName: picked.tagName, text: picked.text },
    };
    this.tagStore.add(tag);
    this.emit('tag-added', tag);
    void this.verifyTag(tag);
    void this.pushTagsToRealApp();
    return tag;
  }

  getTags(): TagWithResolution[] {
    if (!this.tagStore) return [];
    return this.tagStore.all().map((t) => ({
      ...t,
      resolution: this.resolutionByTagId.get(t.id),
      paired: this.rendererPairs.has(t.name),
    }));
  }

  async verifyAll(): Promise<void> {
    if (!this.tagStore) return;
    this.verifyLastRun = Date.now();
    const tags = this.tagStore.all();
    await Promise.all(tags.map((t) => this.verifyTag(t)));
  }

  private scheduleVerify(): void {
    const elapsed = Date.now() - this.verifyLastRun;
    if (elapsed >= this.VERIFY_MIN_INTERVAL_MS) {
      void this.verifyAll();
      return;
    }
    if (this.verifyScheduled) return;
    this.verifyScheduled = setTimeout(() => {
      this.verifyScheduled = null;
      void this.verifyAll();
    }, this.VERIFY_MIN_INTERVAL_MS - elapsed);
  }

  private async verifyTag(tag: Tag): Promise<void> {
    if (!this.resolver) return;
    const result = await this.resolver.resolve(tag.locator);
    this.resolutionByTagId.set(tag.id, result);
    this.emit('tag-verified', tag.id, result);
  }

  removeTag(id: string): boolean {
    if (!this.tagStore) return false;
    const removed = this.tagStore.remove(id);
    if (removed) {
      this.resolutionByTagId.delete(id);
      this.emit('tag-removed', id);
      void this.pushTagsToRealApp();
    }
    return removed;
  }

  renameTag(id: string, name: string): { ok: true; tag: Tag } | { ok: false; reason: 'not-found' | 'duplicate' | 'invalid' } {
    if (!this.tagStore) return { ok: false, reason: 'not-found' };
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reason: 'invalid' };
    const existing = this.tagStore.byId(id);
    if (!existing) return { ok: false, reason: 'not-found' };
    if (existing.name === trimmed) return { ok: true, tag: existing };
    if (this.tagStore.all().some((t) => t.id !== id && t.name === trimmed)) {
      return { ok: false, reason: 'duplicate' };
    }
    const updated: Tag = { ...existing, name: trimmed };
    this.tagStore.replace(id, updated);
    this.emit('tag-replaced', updated);
    void this.pushTagsToRealApp();
    return { ok: true, tag: updated };
  }

  replaceLocator(id: string, picked: PickedElement): Tag | null {
    if (!this.tagStore) return null;
    const existing = this.tagStore.byId(id);
    if (!existing) return null;
    const updated: Tag = {
      ...existing,
      locator: this.buildLocator(picked),
      capturedAt: Date.now(),
      preview: { tagName: picked.tagName, text: picked.text },
    };
    this.tagStore.replace(id, updated);
    this.emit('tag-replaced', updated);
    void this.verifyTag(updated);
    void this.pushTagsToRealApp();
    return updated;
  }

  async broadenTag(id: string): Promise<TagWithResolution | null> {
    if (!this.tagStore) return null;
    const existing = this.tagStore.byId(id);
    if (!existing || !existing.locator.classPath) return null;
    const segments = existing.locator.classPath.split(' > ');
    if (segments.length <= 1) return null;
    const broadened = segments.slice(1).join(' > ');
    const updated: Tag = { ...existing, locator: { ...existing.locator, classPath: broadened } };
    this.tagStore.replace(id, updated);
    await this.verifyTag(updated);
    this.emit('tag-replaced', updated);
    void this.pushTagsToRealApp();
    return {
      ...updated,
      resolution: this.resolutionByTagId.get(id),
      paired: this.rendererPairs.has(updated.name),
    };
  }

  async highlightDiscovery(id: string): Promise<boolean> {
    if (!this.highlighter) return false;
    const cand = this.discovery.byId(id);
    if (!cand) return false;
    return this.highlighter.highlight(this.buildLocator(cand.picked));
  }

  async highlightTag(id: string): Promise<boolean> {
    if (!this.highlighter || !this.tagStore) return false;
    const tag = this.tagStore.byId(id);
    if (!tag) return false;
    return this.highlighter.highlight(tag.locator);
  }

  async clearHighlight(): Promise<void> {
    await this.highlighter?.clear();
  }

  getTimeline(tagName: string) {
    return this.timelines.get(tagName);
  }

  // --- internal ---

  private async pushTagsToRealApp(): Promise<void> {
    if (!this.realAppPage || !this.tagStore) return;
    const known = this.tagStore.all().map((t) => ({ name: t.name, locator: t.locator }));
    try {
      await this.realAppPage.evaluate((tags) => {
        const fn = (window as any).__replicataSetTags;
        if (typeof fn === 'function') fn(tags);
      }, known);
    } catch {}
  }

  private async forwardEvent(tagName: string, type: string, detail: unknown): Promise<void> {
    if (!this.rendererPage) return;
    try {
      const fired = await this.rendererPage.evaluate(
        (args: { tagName: string; type: string; detail: unknown }) => {
          const fn = (window as any).__replicataFireEvent;
          return typeof fn === 'function' ? fn(args.tagName, args.type, args.detail) : 0;
        },
        { tagName, type, detail },
      );
      this.emit('event-forwarded', tagName, type, fired);
    } catch {}
  }

  private buildLocator(picked: PickedElement) {
    return {
      testId: picked.testId,
      ariaLabel: picked.ariaLabel,
      role: picked.role,
      text: picked.text || undefined,
      classPath: picked.classPath,
      nthChildPath: picked.nthChildPath,
      cssPath: picked.cssPath,
    };
  }
}

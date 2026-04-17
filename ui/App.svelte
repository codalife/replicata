<script lang="ts">
  import { onMount } from 'svelte';
  import JsonView from './JsonView.svelte';
  import Shepherd from 'shepherd.js';
  import 'shepherd.js/dist/css/shepherd.css';

  interface Status {
    streams: number;
    totalChunks: number;
    totalBytes: number;
    activeStream: { streamId: string; url: string; chunks: number } | null;
    latestStream: { streamId: string; url: string; chunks: number; done: boolean } | null;
  }

  interface PickedElement {
    cssPath: string;
    tagName: string;
    text: string;
    attrs: Record<string, string>;
    testId?: string;
    ariaLabel?: string;
    role?: string;
    classPath: string;
    nthChildPath: string;
  }

  interface ResolutionResult {
    status: 'resolved' | 'stale';
    matchedBy?: string;
    count: number;
    sample?: { text: string; tagName: string };
  }

  interface Tag {
    id: string;
    name: string;
    locator: {
      testId?: string;
      ariaLabel?: string;
      role?: string;
      text?: string;
      classPath?: string;
      nthChildPath?: string;
      cssPath: string;
    };
    capturedAt: number;
    preview: { tagName: string; text: string };
    resolution?: ResolutionResult;
    paired?: boolean;
  }

  type TagState =
    | { mode: 'idle' }
    | { mode: 'picking' }
    | { mode: 'naming'; picked: PickedElement; name: string }
    | { mode: 'saving' }
    | { mode: 'retagging'; tagId: string };

  interface TargetInfo {
    targetId: string;
    url: string;
    title: string;
    type: string;
  }

  interface Assignments {
    realApp: string | null;
    renderer: string | null;
  }

  interface StreamInfo {
    streamId: string;
    url: string;
    done: boolean;
    chunks: number;
    bytes: number;
    startedAt: number;
  }

  let targets = $state<TargetInfo[]>([]);
  let assignments = $state<Assignments>({ realApp: null, renderer: null });
  let tabsEditing = $state<boolean>(false);

  let status = $state<Status | null>(null);
  let streams = $state<StreamInfo[]>([]);
  let tags = $state<Tag[]>([]);
  let tagState = $state<TagState>({ mode: 'idle' });
  interface LogEntry { ts: string; msg: string; level: 'info' | 'error'; }
  let logs = $state<LogEntry[]>([]);
  let logExpanded = $state<boolean>(false);
  const lastLog = $derived(logs[logs.length - 1]);

  function log(msg: string, level: 'info' | 'error' = 'info') {
    logs = [...logs, { ts: new Date().toLocaleTimeString(), msg, level }];
  }
  function logError(msg: string) { log(msg, 'error'); }

  async function loadTargets() {
    try {
      const [tRes, aRes] = await Promise.all([fetch('/targets'), fetch('/assignments')]);
      if (tRes.ok) targets = await tRes.json();
      if (aRes.ok) assignments = await aRes.json();
    } catch {}
  }

  async function assign(role: 'real-app' | 'renderer', targetId: string) {
    try {
      await fetch('/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, targetId }),
      });
      await loadTargets();
    } catch (err) {
      log('assign error: ' + (err as Error).message);
    }
  }

  async function unassign(role: 'real-app' | 'renderer') {
    try {
      await fetch('/unassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      await loadTargets();
    } catch (err) {
      log('unassign error: ' + (err as Error).message);
    }
  }

  function otherAssignment(targetId: string): 'real-app' | 'renderer' | null {
    if (assignments.realApp === targetId) return 'real-app';
    if (assignments.renderer === targetId) return 'renderer';
    return null;
  }

  function targetById(id: string | null): TargetInfo | undefined {
    if (!id) return undefined;
    return targets.find((t) => t.targetId === id);
  }

  function shortUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch {
      return url;
    }
  }

  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  function isLocal(url: string): boolean {
    try {
      return LOCAL_HOSTS.has(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  const bothAssigned = $derived(!!assignments.realApp && !!assignments.renderer);

  async function pollStatus() {
    try {
      const res = await fetch('/status');
      status = await res.json();
    } catch {}
  }

  type Wiring =
    | 'unwired'
    | 'installingReal'
    | 'installingMy'
    | 'realOnly'
    | 'myOnly'
    | 'installingMyAfterReal'
    | 'installingRealAfterMy'
    | 'ready';
  interface MachineSnapshot {
    global: 'initializing' | 'connected' | 'disconnected' | 'fatal';
    wiring: Wiring | null;
    stream: 'idle' | 'buffering' | 'buffered' | 'replaying' | null;
    ready: boolean;
    context: { realAppUrl: string | null; myAppUrl: string | null; lastError: string | null };
  }
  let machineState = $state<MachineSnapshot | null>(null);
  let kataOnline = $state<boolean>(false);


  let activeTab = $state<'elements' | 'streams' | 'howto'>('elements');

  interface DiscoveryCandidate {
    id: string;
    key: string;
    picked: PickedElement;
    handlerKinds: string[];
    signals: string[];
    sources: string[];
    presence: 'present' | 'removed';
    firstSeen: number;
    lastSeen: number;
    removedAt: number | null;
    mutationCount: number;
    groupId?: string | null;
  }
  type GroupColor = 'grey' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
  interface DiscoveryGroup { id: string; name: string; color: GroupColor; collapsed: boolean; createdAt: number; }
  const GROUP_COLORS: GroupColor[] = ['grey', 'red', 'yellow', 'green', 'blue', 'purple'];

  let discoveryList = $state<DiscoveryCandidate[]>([]);
  let discoveryGroups = $state<DiscoveryGroup[]>([]);
  let dismissedList = $state<Array<{ key: string; dismissedAt: number }>>([]);
  let showDismissed = $state<boolean>(false);
  let menuOpenFor = $state<string | null>(null);  // candidate id w/ open hamburger menu
  let creatingGroupFor = $state<string | null>(null);  // candidate id in new-group-input mode
  let newGroupName = $state<string>('');
  let discoveryDraftName = $state<Record<string, string>>({});

  // ===== Endpoints (Phase 4.5) =====
  interface EndpointSample { url: string; status: number; contentType: string; bytes: number; ts: number; }
  interface EndpointEntry {
    id: string;
    method: string;
    normalizedPath: string;
    kind: 'stream' | 'json' | 'other';
    hitCount: number;
    firstSeen: number;
    lastSeen: number;
    sample: EndpointSample;
    exposedAs?: string;
  }
  let endpoints = $state<EndpointEntry[]>([]);
  let exposeDraftName = $state<Record<string, string>>({});
  let exposeDraftPath = $state<Record<string, string>>({});
  let exposeError = $state<Record<string, string>>({});
  let copiedSnippetFor = $state<string | null>(null);

  const exposedEndpoints = $derived(endpoints.filter((e) => !!e.exposedAs));
  const uncatalogedEndpoints = $derived(endpoints.filter((e) => !e.exposedAs && e.hitCount > 0));

  // ===== Dismissed endpoints =====
  interface DismissedEndpoint { id: string; dismissedAt: number; }
  let dismissedEndpoints = $state<DismissedEndpoint[]>([]);
  let showDismissedEndpoints = $state<boolean>(false);
  async function loadDismissedEndpoints() {
    try {
      const res = await fetch('/endpoints/dismissed');
      if (res.ok) dismissedEndpoints = await res.json();
    } catch {}
  }
  async function dismissEndpoint(id: string) {
    try {
      await fetch(`/endpoints/${id}`, { method: 'DELETE' });
      await Promise.all([loadEndpoints(), loadDismissedEndpoints()]);
    } catch {}
  }
  async function restoreDismissedEndpoint(id: string) {
    try {
      await fetch('/endpoints/dismissed/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await Promise.all([loadEndpoints(), loadDismissedEndpoints()]);
    } catch {}
  }
  async function clearAllDismissedEndpoints() {
    try {
      await fetch('/endpoints/dismissed', { method: 'DELETE' });
      await loadDismissedEndpoints();
    } catch {}
  }

  // ===== Inline edit for exposed endpoints =====
  let editingExposedId = $state<string | null>(null);
  let editDraftName = $state<string>('');
  let editDraftPath = $state<string>('');
  function startEditExposed(e: EndpointEntry) {
    editingExposedId = e.id;
    editDraftName = e.exposedAs ?? '';
    editDraftPath = e.normalizedPath;
  }
  function cancelEditExposed() { editingExposedId = null; }
  async function commitEditExposed(id: string) {
    const name = editDraftName.trim();
    const pathPat = editDraftPath.trim();
    if (!name || !pathPat) return;
    try {
      await fetch(`/endpoints/${id}/expose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, normalizedPath: pathPat }),
      });
      editingExposedId = null;
      await loadEndpoints();
    } catch {}
  }

  // ===== Endpoint expansion (unifies streams + cached body drill-down) =====
  let expandedEndpointIds = $state<Set<string>>(new Set());
  let explicitlyCollapsed = $state<Set<string>>(new Set());
  interface CachedBody { body: string; contentType: string; parsed?: unknown; }
  let endpointBodies = $state<Record<string, CachedBody | 'loading' | 'empty'>>({});
  async function loadEndpointBody(id: string) {
    if (endpointBodies[id] && endpointBodies[id] !== 'empty') return;
    endpointBodies[id] = 'loading';
    try {
      const res = await fetch(`/stream/${id}`);
      if (res.status === 204) {
        endpointBodies[id] = 'empty';
        return;
      }
      const ct = res.headers.get('content-type') || '';
      const body = await res.text();
      let parsed: unknown | undefined;
      if (ct.includes('json')) {
        try { parsed = JSON.parse(body); } catch {}
      }
      endpointBodies[id] = { body, contentType: ct, parsed };
    } catch {
      endpointBodies[id] = 'empty';
    }
  }
  function toggleEndpoint(id: string) {
    const s = new Set(expandedEndpointIds);
    const c = new Set(explicitlyCollapsed);
    if (s.has(id)) {
      s.delete(id); c.add(id);
    } else {
      s.add(id); c.delete(id);
      const ep = endpoints.find((x) => x.id === id);
      if (ep && ep.kind !== 'stream') void loadEndpointBody(id);
    }
    expandedEndpointIds = s;
    explicitlyCollapsed = c;
  }
  // For a given endpoint (esp. stream-kind), find matching buffered streams
  // by normalized-path comparison. Keeps stream drill-down inside the
  // endpoint row.
  function normalizeForCompare(pathname: string): string {
    return pathname.split('/').map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (/^[0-9a-f]{20,}$/i.test(seg)) return ':hex';
      return seg;
    }).join('/');
  }
  function pathMatchesPat(actualPath: string, pattern: string): boolean {
    const a = actualPath.split('/');
    const p = pattern.split('/');
    if (a.length !== p.length) return false;
    for (let i = 0; i < p.length; i++) {
      if (p[i].startsWith(':')) continue;
      if (p[i] !== a[i]) return false;
    }
    return true;
  }
  function streamsForEndpoint(e: EndpointEntry) {
    return streams.filter((s) => {
      try {
        const u = new URL(s.url);
        const pattern = e.normalizedPath;
        return pathMatchesPat(normalizeForCompare(u.pathname), pattern) || pathMatchesPat(u.pathname, pattern);
      } catch { return false; }
    });
  }

  // Auto-expand stream endpoints that have buffered streams, unless user
  // has explicitly collapsed them.
  $effect(() => {
    const next = new Set(expandedEndpointIds);
    let changed = false;
    for (const e of endpoints) {
      if (e.kind !== 'stream') continue;
      if (explicitlyCollapsed.has(e.id)) continue;
      if (next.has(e.id)) continue;
      if (streamsForEndpoint(e).length > 0) {
        next.add(e.id);
        changed = true;
      }
    }
    if (changed) expandedEndpointIds = next;
  });

  async function loadEndpoints() {
    try {
      const res = await fetch('/endpoints');
      if (res.ok) endpoints = await res.json();
    } catch {}
  }

  function defaultEndpointName(e: EndpointEntry): string {
    const segs = e.normalizedPath.split('/').filter((s) => s && !s.startsWith(':'));
    return segs[segs.length - 1] || 'endpoint';
  }

  async function exposeEndpoint(id: string) {
    const name = (exposeDraftName[id] ?? '').trim();
    if (!name) return;
    const ep = endpoints.find((e) => e.id === id);
    const pathDraft = (exposeDraftPath[id] ?? ep?.normalizedPath ?? '').trim();
    const customPath = pathDraft && pathDraft !== ep?.normalizedPath ? pathDraft : undefined;
    try {
      const res = await fetch(`/endpoints/${id}/expose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, normalizedPath: customPath }),
      });
      if (res.ok) {
        exposeError[id] = '';
        exposeDraftName[id] = '';
        exposeDraftPath[id] = '';
        await loadEndpoints();
      } else {
        const { error } = await res.json();
        exposeError[id] = error || 'failed';
      }
    } catch {
      exposeError[id] = 'network error';
    }
  }

  async function unexposeEndpoint(id: string) {
    try {
      await fetch(`/endpoints/${id}/expose`, { method: 'DELETE' });
      await loadEndpoints();
    } catch {}
  }

  function snippetFor(e: EndpointEntry): string {
    const m = e.method.toUpperCase();
    if (m === 'GET' || m === 'HEAD') {
      return `const res = await fetch("${e.normalizedPath}");\nconst data = await res.json();`;
    }
    return `const res = await fetch("${e.normalizedPath}", {\n  method: "${m}",\n  headers: { "Content-Type": "application/json" },\n  body: JSON.stringify({ /* … */ }),\n});`;
  }

  async function copySnippet(e: EndpointEntry) {
    try { await navigator.clipboard.writeText(snippetFor(e)); } catch {}
    copiedSnippetFor = e.id;
    setTimeout(() => { if (copiedSnippetFor === e.id) copiedSnippetFor = null; }, 1500);
  }

  let mswPreviewFor = $state<string | null>(null);
  let mswPreviewCode = $state<string>('');
  let mswCopied = $state<string | null>(null);

  async function generateChunksExport(e: EndpointEntry): Promise<string> {
    const matchingStreams = streamsForEndpoint(e);
    const s = matchingStreams[matchingStreams.length - 1];
    if (!s) return '// no streams captured for this endpoint';

    try {
      const res = await fetch(`/streams/${s.streamId}/chunks`);
      if (!res.ok) return '// failed to load chunks';
      const chunks = await res.json() as Array<{ data: string; ms: number }>;

      const lines: string[] = [];
      lines.push(`// captured from ${e.normalizedPath} (${e.method})`);
      lines.push(`// ${chunks.length} chunks, content-type: ${e.sample?.contentType || 'text/event-stream'}`);
      lines.push(`export const chunks = ${JSON.stringify(chunks, null, 2)};`);
      return lines.join('\n');
    } catch {
      return '// error loading chunks';
    }
  }

  async function toggleMswPreview(e: EndpointEntry) {
    if (mswPreviewFor === e.id) { mswPreviewFor = null; return; }
    mswPreviewCode = await generateChunksExport(e);
    mswPreviewFor = e.id;
  }

  async function copyMswHandler() {
    try { await navigator.clipboard.writeText(mswPreviewCode); } catch {}
    mswCopied = mswPreviewFor;
    setTimeout(() => { mswCopied = null; }, 1500);
  }

  let hideRemoved = $state<boolean>(false);
  let onlyInteractive = $state<boolean>(true);
  let discoverySearch = $state<string>('');
  const searchTokens = $derived(
    discoverySearch.toLowerCase().split(/\s+/).filter(Boolean),
  );

  function matchesSearch(c: DiscoveryCandidate, tokens: string[]): boolean {
    if (tokens.length === 0) return true;
    const hay = [
      c.picked.text,
      c.picked.tagName,
      c.picked.ariaLabel ?? '',
      c.picked.testId ?? '',
      c.picked.role ?? '',
      c.handlerKinds.join(' '),
      c.signals.join(' '),
      c.picked.classPath,
    ].join(' ').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  }

  function splitForHighlight(text: string, tokens: string[]): Array<{ text: string; match: boolean }> {
    if (!text || tokens.length === 0) return [{ text, match: false }];
    const lower = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const t of tokens) {
      if (!t) continue;
      let idx = 0;
      while ((idx = lower.indexOf(t, idx)) !== -1) {
        ranges.push([idx, idx + t.length]);
        idx += t.length;
      }
    }
    if (ranges.length === 0) return [{ text, match: false }];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    const parts: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;
    for (const [s, e] of merged) {
      if (s > cursor) parts.push({ text: text.slice(cursor, s), match: false });
      parts.push({ text: text.slice(s, e), match: true });
      cursor = e;
    }
    if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
    return parts;
  }

  async function loadDiscovery() {
    try {
      const [dRes, gRes, xRes] = await Promise.all([
        fetch('/discovery'),
        fetch('/discovery/groups'),
        fetch('/discovery/dismissed'),
      ]);
      if (dRes.ok) discoveryList = await dRes.json();
      if (gRes.ok) discoveryGroups = await gRes.json();
      if (xRes.ok) dismissedList = await xRes.json();
    } catch {}
  }

  async function restoreDismissed(key: string) {
    try {
      await fetch('/discovery/dismissed/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      await loadDiscovery();
    } catch (err) {
      logError('restore dismissed: ' + (err as Error).message);
    }
  }

  async function clearAllDismissed() {
    try {
      await fetch('/discovery/dismissed', { method: 'DELETE' });
      await loadDiscovery();
    } catch {}
  }

  function startCreateGroup(candidateId: string) {
    creatingGroupFor = candidateId;
    newGroupName = '';
  }

  function cancelCreateGroup() {
    creatingGroupFor = null;
    newGroupName = '';
  }

  async function commitCreateGroup(candidateId: string) {
    const name = newGroupName.trim();
    if (!name) { cancelCreateGroup(); return; }
    const color = GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)];
    try {
      const res = await fetch('/discovery/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const g = await res.json() as DiscoveryGroup;
      await assignGroup(candidateId, g.id);
      creatingGroupFor = null;
      newGroupName = '';
      menuOpenFor = null;
      await loadDiscovery();
    } catch (err) {
      logError('create group: ' + (err as Error).message);
    }
  }

  async function assignGroup(candidateId: string, groupId: string | null) {
    try {
      await fetch(`/discovery/${candidateId}/group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
      menuOpenFor = null;
      await loadDiscovery();
    } catch (err) {
      logError('assign group: ' + (err as Error).message);
    }
  }

  async function toggleGroupCollapsed(g: DiscoveryGroup) {
    try {
      await fetch(`/discovery/groups/${g.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collapsed: !g.collapsed }),
      });
      await loadDiscovery();
    } catch {}
  }

  let renamingGroupId = $state<string | null>(null);
  let renameGroupDraft = $state<string>('');

  function startRenameGroup(g: DiscoveryGroup) {
    renamingGroupId = g.id;
    renameGroupDraft = g.name;
  }
  function cancelRenameGroup() { renamingGroupId = null; renameGroupDraft = ''; }
  async function commitRenameGroup(g: DiscoveryGroup) {
    const name = renameGroupDraft.trim();
    if (!name || name === g.name) { cancelRenameGroup(); return; }
    await fetch(`/discovery/groups/${g.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).catch(() => {});
    renamingGroupId = null;
    renameGroupDraft = '';
    await loadDiscovery();
  }

  let pendingDeleteGroupId = $state<string | null>(null);
  let pendingDeleteGroupTimer: ReturnType<typeof setTimeout> | null = null;
  async function deleteGroup(g: DiscoveryGroup) {
    if (pendingDeleteGroupId !== g.id) {
      pendingDeleteGroupId = g.id;
      if (pendingDeleteGroupTimer) clearTimeout(pendingDeleteGroupTimer);
      pendingDeleteGroupTimer = setTimeout(() => { pendingDeleteGroupId = null; }, 3000);
      return;
    }
    if (pendingDeleteGroupTimer) clearTimeout(pendingDeleteGroupTimer);
    pendingDeleteGroupId = null;
    await fetch(`/discovery/groups/${g.id}`, { method: 'DELETE' }).catch(() => {});
    await loadDiscovery();
  }

  async function cycleGroupColor(g: DiscoveryGroup) {
    const next = GROUP_COLORS[(GROUP_COLORS.indexOf(g.color) + 1) % GROUP_COLORS.length];
    await fetch(`/discovery/groups/${g.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: next }),
    }).catch(() => {});
    await loadDiscovery();
  }

  async function dismissDiscovery(id: string) {
    try { await fetch(`/discovery/${id}`, { method: 'DELETE' }); await loadDiscovery(); } catch {}
  }
  async function clearAllDiscovery() {
    try { await fetch('/discovery', { method: 'DELETE' }); await loadDiscovery(); } catch {}
  }
  async function tagFromDiscovery(c: DiscoveryCandidate) {
    const name = (discoveryDraftName[c.id] ?? '').trim();
    if (!name) return;
    try {
      const res = await fetch(`/discovery/${c.id}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      delete discoveryDraftName[c.id];
      await Promise.all([loadDiscovery(), loadTags()]);
      log(`tag "${name}" created from discovery`);
    } catch (err) {
      logError('tag-from-discovery error: ' + (err as Error).message);
    }
  }
  function suggestName(picked: PickedElement): string {
    return (picked.attrs['aria-label'] || picked.testId || picked.text || picked.tagName)
      .slice(0, 32)
      .replace(/\s+/g, '-')
      .toLowerCase() || 'tag';
  }
  const taggedCssPaths = $derived(new Set(tags.map((t) => t.locator.cssPath)));
  const filteredDiscovery = $derived(discoveryList.filter((c) => {
    if (taggedCssPaths.has(c.picked.cssPath)) return false;
    if (hideRemoved && c.presence === 'removed') return false;
    if (onlyInteractive && c.handlerKinds.length === 0 && c.signals.filter((s) => s !== 'cursor-pointer').length === 0) return false;
    if (!matchesSearch(c, searchTokens)) return false;
    return true;
  }));

  const ungroupedCandidates = $derived(filteredDiscovery.filter((c) => !c.groupId));
  const groupedSections = $derived(discoveryGroups.map((g) => {
    const members = filteredDiscovery.filter((c) => c.groupId === g.id);
    const hasSearchHit = searchTokens.length > 0 && members.length > 0;
    return { group: g, members, expanded: !g.collapsed || hasSearchHit };
  }).filter((s) => s.members.length > 0 || searchTokens.length === 0));

  async function loadStreams() {
    try {
      const res = await fetch('/streams');
      if (res.ok) streams = await res.json();
    } catch {}
  }

  async function loadTags() {
    try {
      const res = await fetch('/tags');
      tags = await res.json();
    } catch {}
  }

  async function startPicker() {
    tagState = { mode: 'picking' };
    log('picker started — click an element in the real app');
    try {
      const res = await fetch('/tag/start', { method: 'POST' });
      if (!res.ok) throw new Error(`picker failed (${res.status})`);
      const picked: PickedElement = await res.json();
      const suggested = (picked.attrs['aria-label'] || picked.text || picked.tagName)
        .slice(0, 32)
        .replace(/\s+/g, '-')
        .toLowerCase() || 'tag';
      tagState = { mode: 'naming', picked, name: suggested };
    } catch (err) {
      log('picker error: ' + (err as Error).message);
      tagState = { mode: 'idle' };
    }
  }

  async function cancelPicker() {
    await fetch('/tag/cancel', { method: 'POST' }).catch(() => {});
    tagState = { mode: 'idle' };
    log('picker cancelled');
  }

  async function submitName() {
    if (tagState.mode !== 'naming' || !tagState.name.trim()) return;
    const { picked, name } = tagState;
    tagState = { mode: 'saving' };
    try {
      const res = await fetch('/tag/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), picked }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      await loadTags();
      log(`tag "${name}" saved`);
    } catch (err) {
      log('save error: ' + (err as Error).message);
    }
    tagState = { mode: 'idle' };
  }

  let renamingTagId = $state<string | null>(null);
  let renameDraft = $state<string>('');

  function startRename(tag: Tag) {
    renamingTagId = tag.id;
    renameDraft = tag.name;
  }

  function cancelRename() {
    renamingTagId = null;
    renameDraft = '';
  }

  async function commitRename(id: string) {
    const name = renameDraft.trim();
    if (!name) { cancelRename(); return; }
    try {
      const res = await fetch(`/tag/${id}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.status === 409) { logError(`rename: "${name}" already in use`); return; }
      if (!res.ok) throw new Error(`status ${res.status}`);
      await loadTags();
      renamingTagId = null;
      renameDraft = '';
    } catch (err) {
      logError('rename error: ' + (err as Error).message);
    }
  }

  async function retag(id: string) {
    tagState = { mode: 'retagging', tagId: id };
    log(`re-tagging — click new element in real app`);
    try {
      const res = await fetch(`/tag/${id}/retag`, { method: 'POST' });
      if (!res.ok) throw new Error(`retag failed (${res.status})`);
      await loadTags();
      log(`tag re-bound`);
    } catch (err) {
      log('retag error: ' + (err as Error).message);
    }
    tagState = { mode: 'idle' };
  }

  let pendingDeleteId = $state<string | null>(null);
  let pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;

  async function removeTag(id: string, name: string) {
    if (pendingDeleteId !== id) {
      pendingDeleteId = id;
      if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
      pendingDeleteTimer = setTimeout(() => { pendingDeleteId = null; }, 3000);
      return;
    }
    if (pendingDeleteTimer) clearTimeout(pendingDeleteTimer);
    pendingDeleteId = null;
    try {
      const res = await fetch(`/tag/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`status ${res.status}`);
      await loadTags();
      log(`tag "${name}" removed`);
    } catch (err) {
      logError('remove error: ' + (err as Error).message);
    }
  }

  async function broadenTag(id: string, name: string) {
    try {
      const res = await fetch(`/tag/${id}/broaden`, { method: 'POST' });
      if (res.status === 409) {
        log(`"${name}": cannot broaden further`);
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      await loadTags();
    } catch (err) {
      log('broaden error: ' + (err as Error).message);
    }
  }

  function canBroaden(tag: Tag): boolean {
    if (!tag.locator.classPath) return false;
    return tag.locator.classPath.split(' > ').length > 1;
  }

  async function copyAttr(name: string) {
    const snippet = `data-replicata-tag="${name}"`;
    try {
      await navigator.clipboard.writeText(snippet);
      log(`copied ${snippet}`);
    } catch (err) {
      logError('copy failed: ' + (err as Error).message);
    }
  }

  interface Signature {
    text: string;
    attrs: Record<string, string>;
    childTagsKey: string;
    visible: boolean;
    matchCount: number;
  }
  interface TimelineEntry { ts: number; sig: Signature; }
  interface Timeline { real: TimelineEntry[]; renderer: TimelineEntry[]; }

  let timelines = $state<Record<string, Timeline>>({});
  let expandedTagIds = $state<Set<string>>(new Set());

  async function loadTimeline(id: string) {
    try {
      const res = await fetch(`/tag/${id}/timeline`);
      if (res.ok) timelines[id] = await res.json();
    } catch {}
  }

  function toggleTag(id: string) {
    if (expandedTagIds.has(id)) {
      expandedTagIds.delete(id);
      expandedTagIds = new Set(expandedTagIds);
    } else {
      expandedTagIds = new Set([...expandedTagIds, id]);
      loadTimeline(id);
    }
  }

  function sigPreview(s: Signature): string {
    const parts: string[] = [];
    if (s.text) parts.push(`"${s.text.slice(0, 40)}${s.text.length > 40 ? '…' : ''}"`);
    if (s.childTagsKey) parts.push(`[${s.childTagsKey}]`);
    if (!s.visible) parts.push('hidden');
    const attrs = Object.entries(s.attrs).slice(0, 3).map(([k, v]) => `${k}=${v.slice(0, 20)}`);
    if (attrs.length) parts.push(attrs.join(' '));
    if (s.matchCount !== 1) parts.push(`×${s.matchCount}`);
    return parts.join(' ') || '(empty)';
  }

  function sigsMatch(a: Signature | undefined, b: Signature | undefined): boolean {
    if (!a || !b) return false;
    return a.text === b.text && a.childTagsKey === b.childTagsKey && a.visible === b.visible
      && JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
  }

  function latestSig(entries: TimelineEntry[]): Signature | undefined {
    return entries.length ? entries[entries.length - 1].sig : undefined;
  }

  function pairHealth(tag: Tag): 'match' | 'mismatch' | 'missing' {
    const tl = timelines[tag.id];
    if (!tl || !tl.real.length || !tl.renderer.length) return 'missing';
    return sigsMatch(latestSig(tl.real), latestSig(tl.renderer)) ? 'match' : 'mismatch';
  }

  function formatTs(ts: number): string {
    const delta = (Date.now() - ts) / 1000;
    if (delta < 60) return `${Math.floor(delta)}s ago`;
    return `${Math.floor(delta / 60)}m ago`;
  }

  interface Scenario {
    kind: 'none' | 'latency' | 'disconnect' | 'drop' | 'rate-limit' | 'malformed';
    latencyMultiplier?: number;
    disconnectAt?: number;
    dropStart?: number;
    dropEnd?: number;
    errorStatus?: number;
    errorBody?: string;
  }

  let scenario = $state<Scenario>({ kind: 'none' });

  async function loadScenario() {
    try {
      const res = await fetch('/scenario');
      if (res.ok) scenario = await res.json();
    } catch {}
  }

  async function applyScenario() {
    try {
      const res = await fetch('/scenario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scenario),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      log(`scenario: ${scenario.kind}`);
    } catch (err) {
      log('scenario error: ' + (err as Error).message);
    }
  }

  function resetScenario() {
    scenario = { kind: 'none' };
    applyScenario();
  }

  let highlightedId = $state<string | null>(null);
  async function highlightEnter(id: string) {
    highlightedId = id;
    await fetch(`/tag/${id}/highlight`, { method: 'POST' }).catch(() => {});
  }
  async function highlightLeave() {
    highlightedId = null;
    await fetch('/highlight/clear', { method: 'POST' }).catch(() => {});
  }

  function formatBytes(b: number): string {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function statusLabel(r?: ResolutionResult): string {
    if (!r) return 'checking...';
    if (r.status === 'resolved') return `${r.count} match${r.count === 1 ? '' : 'es'} via ${r.matchedBy}`;
    return 'not found on current page';
  }

  // === Streams ===
  let expandedStreamIds = $state<Set<string>>(new Set());
  let streamBodies = $state<Record<string, string>>({});
  let streamParsed = $state<Record<string, SseMessage[]>>({});
  let streamViewMode = $state<'parsed' | 'raw'>('parsed');

  async function loadStreamBody(id: string) {
    try {
      const res = await fetch(`/streams/${id}/bytes`);
      if (!res.ok) return;
      const text = await res.text();
      if (streamBodies[id] === text) return;
      streamBodies[id] = text;
      streamParsed[id] = parseSse(text);
    } catch {}
  }

  function toggleStream(id: string) {
    if (expandedStreamIds.has(id)) {
      expandedStreamIds.delete(id);
      expandedStreamIds = new Set(expandedStreamIds);
    } else {
      expandedStreamIds = new Set([...expandedStreamIds, id]);
      loadStreamBody(id);
    }
  }

  async function deleteStream(id: string) {
    try {
      await fetch(`/streams/${id}`, { method: 'DELETE' });
      expandedStreamIds.delete(id);
      expandedStreamIds = new Set(expandedStreamIds);
      delete streamBodies[id];
      delete streamParsed[id];
      await loadStreams();
    } catch (err) {
      log('delete stream error: ' + (err as Error).message);
    }
  }

  async function clearAllStreams() {
    if (!confirm('Delete all buffered streams?')) return;
    try {
      await fetch('/streams', { method: 'DELETE' });
      expandedStreamIds = new Set();
      streamBodies = {};
      streamParsed = {};
      await loadStreams();
    } catch (err) {
      log('clear streams error: ' + (err as Error).message);
    }
  }

  interface SseMessage {
    event?: string;
    data: string;
    raw: string;
    parsed?: unknown;
  }

  function parseSse(body: string): SseMessage[] {
    const msgs: SseMessage[] = [];
    for (const block of body.split(/\n\n+/)) {
      if (!block.trim()) continue;
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
      const data = dataLines.join('\n');
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {}
      msgs.push({ event, data, raw: block, parsed });
    }
    return msgs;
  }

  const streamHeader = $derived(
    !status
      ? '○ waiting'
      : status.activeStream
      ? `● streaming (${status.activeStream.chunks} chunks)`
      : status.latestStream
      ? `○ idle · last ${status.latestStream.chunks} chunks`
      : '○ waiting',
  );
  const isActive = $derived(!!status?.activeStream);

  const discoveryByCssPath = $derived(new Map(discoveryList.map((c) => [c.picked.cssPath, c])));

  // ===== Guided tours (recipes) =====
  let shepherdTour: any = null;
  const TOUR_DONE_KEY = 'kataTourComplete';

  interface TourStep {
    id: string;
    title: string;
    text: string;
    attachTo?: { element: string; on: 'top' | 'bottom' | 'left' | 'right' };
    beforeShow?: () => void | Promise<void>;
    final?: boolean;
  }

  function stepDone(id: string): boolean {
    const w = machineState?.wiring;
    const s = machineState?.stream;
    const realPresent = w === 'realOnly' || w === 'installingMyAfterReal' || w === 'ready';
    const myPresent = w === 'myOnly' || w === 'installingRealAfterMy' || w === 'ready';
    const streamed = s === 'buffering' || s === 'buffered' || s === 'replaying';
    switch (id) {
      case 'setup-real': return realPresent;
      case 'setup-my': return myPresent;
      case 'pick-interactive': return tags.length > 0;
      case 'stream-seen': return streamed;
      case 'paired': return tags.some((t) => t.paired);
      default: return false;
    }
  }

  const SETUP_PREFLIGHT: TourStep = {
    id: 'setup-preflight',
    title: 'Before you connect',
    text: 'Use <b>the Chrome window Replicata launched</b> (not your regular Chrome). In that window, open the real app, sign in, and solve any Cloudflare / CAPTCHA challenge. Replicata can\'t bypass these — you do it once, the session persists.',
  };
  const SETUP_REAL: TourStep = {
    id: 'setup-real',
    title: 'Connect the real app',
    text: 'Assign the tab streaming real responses in the Connection panel above. Skip if already connected.',
    attachTo: { element: '[data-tour="connection"]', on: 'bottom' },
  };
  const SETUP_MY: TourStep = {
    id: 'setup-my',
    title: 'Connect your app',
    text: 'Assign your localhost tab (localhost / 127.0.0.1 / 0.0.0.0). Skip if already connected.',
    attachTo: { element: '[data-tour="connection"]', on: 'bottom' },
  };

  const MIRROR_INPUT_STEPS: TourStep[] = [
    SETUP_PREFLIGHT,
    SETUP_REAL,
    SETUP_MY,
    {
      id: 'pick-interactive',
      title: 'Pick an element to mirror',
      text: 'Two ways:<br>(a) click <b>+ Tag element</b> and pick it live in the real app, or<br>(b) scroll the <b>Discovered</b> list below — Replicata cataloged candidates automatically. Use the search if it\'s long.',
      beforeShow: () => { activeTab = 'elements'; },
      attachTo: { element: '[data-tour="tag-btn"]', on: 'bottom' },
    },
    {
      id: 'copy-attr',
      title: 'Copy the attribute',
      text: 'Your new tag appears in the list. Click <b>copy attr</b> on it — Replicata copies <code>data-replicata-tag="&lt;name&gt;"</code> to your clipboard.',
      attachTo: { element: '[data-tour="copy-attr"]', on: 'bottom' },
    },
    {
      id: 'paste-attr',
      title: 'Paste it in your code',
      text: 'Put the attribute on the matching element in your source. Example:<pre class="tour-code">&lt;input\n  data-replicata-tag=<span class="hl">"message-input"</span>\n  value={text}\n  onChange={(e) =&gt; setText(e.target.value)}\n/&gt;</pre><small class="tour-note">Replicata pairs by the tag name. On reload it auto-wires; events from the real-app element fire your <code>onChange</code>.</small>',
    },
    {
      id: 'mirror-done',
      title: 'Trigger the event',
      text: 'Interact with the real element — type, click, whatever. Replicata dispatches the same event on yours: <code>onChange</code> / <code>onClick</code> fires normally.',
      final: true,
    },
  ];

  const MIRROR_RESPONSE_STEPS: TourStep[] = [
    SETUP_PREFLIGHT,
    SETUP_REAL,
    SETUP_MY,
    {
      id: 'stream-seen',
      title: 'Trigger a request in the real app',
      text: 'Do whatever fires a request (send a chat message, refresh a feed). Open the <b>Network</b> tab — Replicata catalogs every endpoint as you hit it.',
      beforeShow: () => { activeTab = 'streams'; },
    },
    {
      id: 'expose-endpoint',
      title: 'Expose the endpoint',
      text: 'Find the request in the <b>Discovered</b> list. Give it a short name (e.g. <code>chat</code>, <code>messages</code>) and click <b>expose</b>. Replicata will now serve its real responses to your app.',
    },
    {
      id: 'consume-fetch',
      title: 'Copy the snippet',
      text: 'Click <b>copy snippet</b> on the exposed row. Paste the <code>fetch()</code> call into your renderer — same path, same method. Replicata rewrites the URL transparently.',
    },
    {
      id: 'consume-done',
      title: 'Render as usual',
      text: 'Your code sees a normal <code>Response</code>. Parse SSE / JSON exactly as in prod. Real chunk timing, real framing, real edge cases.',
      final: true,
    },
  ];

  function startTour(steps: TourStep[]) {
    if (shepherdTour) return;
    const tourName = steps === MIRROR_INPUT_STEPS ? 'mirror-input' : steps === MIRROR_RESPONSE_STEPS ? 'mirror-response' : 'unknown';
    // Don't run tours behind the lock screen — target elements aren't in
    // the DOM and the whole UX assumes an unlocked app.
    // Filter out setup steps that are already satisfied. Keeps the rest so
    // the user can re-assign tabs mid-tour if they want. Preflight warning
    // is also skipped if the user has already successfully connected real
    // at least once (by proxy of realPresent being true now or before).
    const w = machineState?.wiring;
    const realPresent = w === 'realOnly' || w === 'installingMyAfterReal' || w === 'ready';
    const effective = steps.filter((s) => {
      if (s.id === 'setup-preflight') return !realPresent;
      if (s.id === 'setup-real' || s.id === 'setup-my') return !stepDone(s.id);
      return true;
    });
    if (effective.length === 0) return;
    const t = new Shepherd.Tour({
      useModalOverlay: true,
      defaultStepOptions: {
        cancelIcon: { enabled: true },
        scrollTo: { behavior: 'smooth', block: 'center' },
        classes: 'kata-tour',
      },
    });
    const skipBtn = { text: 'Skip', secondary: true, action: () => t.cancel() };
    for (const s of effective) {
      t.addStep({
        id: s.id,
        title: s.title,
        text: s.text,
        attachTo: s.attachTo,
        beforeShowPromise: s.beforeShow
          ? () => Promise.resolve(s.beforeShow!()).then(() => new Promise((rs) => setTimeout(rs, 120)))
          : undefined,
        buttons: s.final
          ? [{ text: 'Got it', action: () => t.complete() }]
          : [skipBtn, { text: 'Next', action: () => t.next() }],
      });
    }
    const markDone = () => { localStorage.setItem(TOUR_DONE_KEY, '1'); shepherdTour = null; };
    t.on('complete', () => { markDone(); });
    t.on('cancel',   () => { track('tour_skipped',   { tour: tourName }); markDone(); });
    shepherdTour = t;
    t.start();
  }

  function startMirrorInput() { startTour(MIRROR_INPUT_STEPS); }
  function startMirrorResponse() { startTour(MIRROR_RESPONSE_STEPS); }

  // Auto-start the mirror-input tour once, the first time we see the app
  // unlocked. Skipped behind the lock screen.
  let tourAutoStarted = false;
  $effect(() => {
    if (tourAutoStarted) return;
    if (localStorage.getItem(TOUR_DONE_KEY)) { tourAutoStarted = true; return; }
    tourAutoStarted = true;
    activeTab = 'howto';
    setTimeout(() => startMirrorInput(), 500);
  });

  let feedbackDraft = $state<string>('');
  let feedbackSending = $state<boolean>(false);
  let feedbackSent = $state<boolean>(false);
  async function submitFeedback() {
    const msg = feedbackDraft.trim();
    if (!msg) return;
    feedbackSending = true;
    try {
      await fetch('/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg }) });
      feedbackDraft = '';
      feedbackSent = true;
      setTimeout(() => { feedbackSent = false; }, 4000);
    } catch {}
    feedbackSending = false;
  }

  $effect(() => {
    if (!shepherdTour || !shepherdTour.isActive()) return;
    const current = shepherdTour.getCurrentStep();
    if (!current) return;
    if (stepDone(current.id)) shepherdTour.next();
  });


  interface RecipeStep {
    done: boolean;
    title: string;
    hint: string;
    action?: { label: string; run: () => void; disabled?: boolean };
  }
  const recipeSteps = $derived.by((): RecipeStep[] => {
    const w = machineState?.wiring;
    const s = machineState?.stream;
    const realPresent = w === 'realOnly' || w === 'installingMyAfterReal' || w === 'ready';
    const myPresent = w === 'myOnly' || w === 'installingRealAfterMy' || w === 'ready';
    const ready = machineState?.ready === true;
    const streamed = s === 'buffering' || s === 'buffered' || s === 'replaying';
    const hasTag = tags.length > 0;
    const anyPaired = tags.some((t) => t.paired);
    const firstUnpaired = tags.find((t) => !t.paired);
    const canPick = realPresent && tagState.mode === 'idle';
    return [
      { done: realPresent, title: '1. Connect the real app', hint: 'Pick its tab in the Connection summary above.' },
      { done: myPresent,   title: '2. Connect your app',    hint: 'Pick your localhost tab. Must be localhost / 127.0.0.1.' },
      { done: ready,       title: '3. Wired up',            hint: 'Both tabs connected — fetch wrappers installed on each side.' },
      { done: streamed,    title: '4. See a stream',        hint: 'Trigger a streaming response in the real app (e.g. send a message).' },
      {
        done: hasTag,
        title: '5. Tag an element',
        hint: realPresent ? 'Click to start the CDP picker on the real app.' : 'Connect the real app first.',
        action: { label: hasTag ? '+ Tag another' : '+ Tag element', run: startPicker, disabled: !canPick },
      },
      {
        done: anyPaired,
        title: '6. Mirror it in your app',
        hint: firstUnpaired
          ? `Copy the attr and paste it on the matching element in your app.`
          : hasTag ? 'All tags paired.' : 'Tag an element first.',
        action: firstUnpaired
          ? { label: `copy data-replicata-tag="${firstUnpaired.name}"`, run: () => copyAttr(firstUnpaired.name) }
          : undefined,
      },
    ];
  });

  const totalsText = $derived(
    !status
      ? ''
      : `${status.streams} stream${status.streams === 1 ? '' : 's'} · ${status.totalChunks} chunks · ${formatBytes(status.totalBytes)}`,
  );

  onMount(() => {
    log('replicata ui ready');
    pollStatus();
    loadTags();
    loadScenario();
    loadTargets();
    loadStreams();
    loadDiscovery();
    loadEndpoints();
    loadDismissedEndpoints();
    const es = new EventSource('/events');
    es.addEventListener('state', (e) => {
      try { machineState = JSON.parse((e as MessageEvent).data); kataOnline = true; } catch {}
    });
    es.addEventListener('endpoints', (e) => {
      try { endpoints = JSON.parse((e as MessageEvent).data); } catch {}
      loadDismissedEndpoints();
    });
    es.addEventListener('warning', (e) => {
      try { const w = JSON.parse((e as MessageEvent).data) as { ts: number; msg: string }; logError(w.msg); } catch {}
    });
    es.onopen = () => { kataOnline = true; };
    es.onerror = () => { kataOnline = false; };

    const statusId = setInterval(pollStatus, 500);
    const streamsId = setInterval(loadStreams, 1000);
    const discId = setInterval(loadDiscovery, 1500);
    const tagsId = setInterval(loadTags, 1500);
    const targetsId = setInterval(loadTargets, 1500);
    const tlId = setInterval(() => {
      for (const tag of tags) loadTimeline(tag.id);
    }, 1500);
    const bodyId = setInterval(() => {
      for (const id of expandedStreamIds) {
        const s = streams.find((x) => x.streamId === id);
        if (s && !s.done) loadStreamBody(id);
      }
    }, 1000);
    return () => { es.close(); clearInterval(statusId); clearInterval(streamsId); clearInterval(tagsId); clearInterval(targetsId); clearInterval(tlId); clearInterval(bodyId); clearInterval(discId); };
  });
</script>

<div class="header">
  <h1>replicata</h1>
  <span class="pip" class:offline={!kataOnline} class:online={kataOnline} title="server heartbeat">{kataOnline ? 'live' : 'offline'}</span>
  {#if machineState}
    <div class="health">
      <span class="pip global-{machineState.global}" title="cdp + chrome">{machineState.global}</span>
      {#if machineState.wiring}
        <span class="pip wiring-{machineState.wiring}" class:ready={machineState.ready} title="wiring">{machineState.wiring}</span>
      {/if}
      {#if machineState.stream}
        <span class="pip pip-stream-{machineState.stream}" title="stream">stream: {machineState.stream}</span>
      {/if}
    </div>
  {/if}
</div>

{#snippet hl(text: string)}{#each splitForHighlight(text ?? '', searchTokens) as p}{#if p.match}<mark class="hl">{p.text}</mark>{:else}{p.text}{/if}{/each}{/snippet}

<!-- ZONE 1: CONNECTION -->
<div class="panel zone-connection" data-tour="connection">
  {#if bothAssigned && !tabsEditing}
    {@const rt = targetById(assignments.realApp)}
    {@const mt = targetById(assignments.renderer)}
    <div class="connection-summary">
      <span class="chip real">real</span>
      <span class="summary-url">{rt ? shortUrl(rt.url) : '?'}</span>
      <span class="summary-sep">·</span>
      <span class="chip renderer">my app</span>
      <span class="summary-url">{mt ? shortUrl(mt.url) : '?'}</span>
      <span class="spacer"></span>
      <button class="action" onclick={() => (tabsEditing = true)}>edit</button>
    </div>
  {:else}
    <div class="row">
      <div class="label">Connection</div>
      {#if bothAssigned}
        <button class="action" onclick={() => (tabsEditing = false)}>done</button>
      {/if}
    </div>

    {#if assignments.realApp || assignments.renderer}
      <div class="assigned">
        {#if assignments.realApp}
          {@const t = targetById(assignments.realApp)}
          <div class="tab assigned-real">
            <span class="chip real">real app</span>
            <div class="tab-meta">
              <div class="tab-title">{t?.title ?? '(tab lost)'}</div>
              <div class="tab-url">{t ? shortUrl(t.url) : assignments.realApp}</div>
            </div>
            <button class="action" onclick={() => unassign('real-app')}>unassign</button>
          </div>
        {/if}
        {#if assignments.renderer}
          {@const t = targetById(assignments.renderer)}
          <div class="tab assigned-renderer">
            <span class="chip renderer">my app</span>
            <div class="tab-meta">
              <div class="tab-title">{t?.title ?? '(tab lost)'}</div>
              <div class="tab-url">{t ? shortUrl(t.url) : assignments.renderer}</div>
            </div>
            <button class="action" onclick={() => unassign('renderer')}>unassign</button>
          </div>
        {/if}
      </div>
    {/if}

    {#if !assignments.realApp || !assignments.renderer}
      <div class="tabs">
        {#each targets.filter((t) => !otherAssignment(t.targetId)) as t (t.targetId)}
          <div class="tab">
            <div class="tab-meta">
              <div class="tab-title">{t.title || '(untitled)'}</div>
              <div class="tab-url">{shortUrl(t.url)}</div>
            </div>
            <div class="tab-actions">
              {#if !assignments.realApp}
                <button class="action" onclick={() => assign('real-app', t.targetId)}>→ real app</button>
              {/if}
              {#if !assignments.renderer && isLocal(t.url)}
                <button class="action" onclick={() => assign('renderer', t.targetId)}>→ my app</button>
              {/if}
            </div>
          </div>
        {:else}
          <div class="hint">no unassigned tabs — open the page you want to practice on</div>
        {/each}
      </div>
      <div class="hint">
        {#if !assignments.realApp && !assignments.renderer}assign real app + my app (localhost) to begin
        {:else if !assignments.realApp}assign a real app to enable tagging + event forwarding
        {:else}assign "my app" — a localhost tab — to enable event forwarding + replay{/if}
      </div>
    {/if}
  {/if}
</div>

<!-- SCENARIO (acts on the pipe) -->
<div class="panel scenario-panel">
  <div class="row">
    <div class="label">Scenario ({scenario.kind})</div>
    {#if scenario.kind !== 'none'}
      <button class="cancel" onclick={resetScenario}>Clear</button>
    {/if}
  </div>
  <div class="scenario-grid">
    <select bind:value={scenario.kind}>
      <option value="none">none</option>
      <option value="latency">latency</option>
      <option value="disconnect">disconnect</option>
      <option value="drop">drop chunks</option>
      <option value="rate-limit">rate-limit</option>
      <option value="malformed">malformed</option>
    </select>
    {#if scenario.kind === 'latency'}
      <label>×<input type="number" min="1" max="20" step="0.5" bind:value={scenario.latencyMultiplier} placeholder="2" /></label>
    {:else if scenario.kind === 'disconnect'}
      <label>after chunk <input type="number" min="0" bind:value={scenario.disconnectAt} placeholder="5" /></label>
    {:else if scenario.kind === 'drop'}
      <label>from <input type="number" min="0" bind:value={scenario.dropStart} placeholder="3" /></label>
      <label>to <input type="number" min="0" bind:value={scenario.dropEnd} placeholder="5" /></label>
    {:else if scenario.kind === 'rate-limit'}
      <label>status <input type="number" min="400" max="599" bind:value={scenario.errorStatus} placeholder="429" /></label>
    {/if}
    <button onclick={applyScenario}>Apply</button>
  </div>
  <div class="scenario-hint">applies on next fetch of /stream (replay latest buffered stream)</div>
</div>

<div class="panel workspace-panel">
  <div class="workspace-tabs">
    <button class="ws-tab" class:active={activeTab === 'elements'} onclick={() => (activeTab = 'elements')}>Elements ({tags.length + filteredDiscovery.length})</button>
    <button class="ws-tab" class:active={activeTab === 'streams'} onclick={() => (activeTab = 'streams')}>Network ({endpoints.length})</button>
    <button class="ws-tab" class:active={activeTab === 'howto'} onclick={() => (activeTab = 'howto')}>How To</button>
    <span class="spacer"></span>
    {#if activeTab === 'elements'}
      {#if tagState.mode === 'idle'}
        <button data-tour="tag-btn" onclick={startPicker}>+ Tag element</button>
      {:else if tagState.mode === 'picking' || tagState.mode === 'retagging'}
        <button class="cancel" onclick={cancelPicker}>Cancel pick</button>
      {/if}
      <input class="disc-search" placeholder="search text, role, handler…" bind:value={discoverySearch} />
      <label class="disc-filter"><input type="checkbox" bind:checked={onlyInteractive} /> interactive</label>
      <label class="disc-filter"><input type="checkbox" bind:checked={hideRemoved} /> hide removed</label>
      <label class="disc-filter"><input type="checkbox" bind:checked={showDismissed} /> show dismissed ({dismissedList.length})</label>
      {#if showDismissed && dismissedList.length > 0}
        <button class="action" onclick={clearAllDismissed}>clear dismissed</button>
      {:else if discoveryList.length > 0}
        <button class="action" onclick={clearAllDiscovery}>clear all</button>
      {/if}
    {:else if activeTab === 'streams'}
      <span class="value" class:active={isActive} class:idle={!isActive}>{streamHeader}</span>
      {#if streams.length > 0}
        <button class="action" onclick={clearAllStreams}>clear all</button>
      {/if}
    {/if}
  </div>

  {#if activeTab === 'elements'}
    <div class="workspace-body">

      {#if tagState.mode === 'picking'}
        <div class="hint">Click an element in the real app window.</div>
      {:else if tagState.mode === 'retagging'}
        <div class="hint">Click the new element to re-bind this tag.</div>
      {:else if tagState.mode === 'naming'}
        <div class="preview">
          <span class="tag-name">&lt;{tagState.picked.tagName}&gt;</span>
          {#if tagState.picked.text}<span class="tag-text">{tagState.picked.text}</span>{/if}
          <div class="cssPath">{tagState.picked.cssPath}</div>
        </div>
        <div class="row">
          <input
            bind:value={tagState.name}
            onkeydown={(e) => { if (e.key === 'Enter') submitName(); if (e.key === 'Escape') cancelPicker(); }}
            placeholder="tag name"
          />
          <button onclick={submitName} disabled={!tagState.name.trim()}>Save</button>
          <button class="cancel" onclick={cancelPicker}>Cancel</button>
        </div>
      {:else if tagState.mode === 'saving'}
        <div class="hint">saving…</div>
      {/if}

      {#if tags.length > 0}
        <ul class="taglist">
          {#each tags as tag (tag.id)}
            {@const expanded = expandedTagIds.has(tag.id)}
            {@const health = pairHealth(tag)}
            <li class="tag-item" class:stale={tag.resolution?.status === 'stale'} class:expanded>
              <div
                class="tag-header"
                class:highlighted={highlightedId === tag.id}
                onmouseenter={() => highlightEnter(tag.id)}
                onmouseleave={highlightLeave}
                onclick={() => toggleTag(tag.id)}
                role="button"
                tabindex="0"
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleTag(tag.id); }}
              >
                <span class="caret">{expanded ? '▾' : '▸'}</span>
                <span class="health-dot {health}" title="pair: {health}"></span>
                {#if renamingTagId === tag.id}
                  <input
                    class="rename-input"
                    bind:value={renameDraft}
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitRename(tag.id);
                      if (e.key === 'Escape') cancelRename();
                    }}
                    onblur={() => commitRename(tag.id)}
                    autofocus
                  />
                {:else}
                  <span class="tag-badge" ondblclick={(e) => { e.stopPropagation(); startRename(tag); }} title="double-click to rename">{tag.name}</span>
                {/if}
                {#if tag.resolution && tag.resolution.count > 1}
                  <span class="count" title={statusLabel(tag.resolution)}>×{tag.resolution.count}</span>
                {/if}
                {#if tag.paired}
                  <span class="pair paired" title="renderer has data-replicata-tag='{tag.name}'">↔</span>
                {:else}
                  <button
                    class="pair unpaired"
                    data-tour="copy-attr"
                    title="copy data-replicata-tag='{tag.name}'"
                    onclick={(e) => { e.stopPropagation(); copyAttr(tag.name); }}
                  >
                    copy attr
                  </button>
                {/if}
                <span class="tag-name">&lt;{tag.preview.tagName}&gt;</span>
                {#if tag.preview.text}<span class="tag-text">{tag.preview.text}</span>{/if}
                <span class="spacer"></span>
                {#if canBroaden(tag)}
                  <button class="action" title="drop leftmost ancestor from classPath" onclick={(e) => { e.stopPropagation(); broadenTag(tag.id, tag.name); }}>broaden</button>
                {/if}
                <button class="action" title="rename" onclick={(e) => { e.stopPropagation(); startRename(tag); }}>rename</button>
                <button class="action" onclick={(e) => { e.stopPropagation(); retag(tag.id); }}>re-tag</button>
                <button
                  class="action del"
                  class:pending={pendingDeleteId === tag.id}
                  title={pendingDeleteId === tag.id ? 'click again to confirm' : 'remove tag'}
                  onclick={(e) => { e.stopPropagation(); removeTag(tag.id, tag.name); }}
                >{pendingDeleteId === tag.id ? 'confirm?' : '×'}</button>
              </div>

              {#if discoveryByCssPath.get(tag.locator.cssPath)}
                {@const disc = discoveryByCssPath.get(tag.locator.cssPath)!}
                {#if disc.handlerKinds.length > 0 || disc.signals.length > 0 || disc.picked.ariaLabel || disc.picked.role || disc.picked.testId}
                  <div class="tag-meta">
                    {#if disc.picked.ariaLabel}<span class="disc-chip aria" title="aria-label">{disc.picked.ariaLabel}</span>{/if}
                    {#if disc.picked.role}<span class="disc-chip role" title="role">{disc.picked.role}</span>{/if}
                    {#if disc.picked.testId}<span class="disc-chip testid" title="data-testid">{disc.picked.testId}</span>{/if}
                    {#each disc.handlerKinds as h}<span class="kind handler">{h}</span>{/each}
                    {#each disc.signals as s}<span class="kind signal">{s}</span>{/each}
                  </div>
                {/if}
              {/if}

              {#if expanded}
                {@const tl = timelines[tag.id] ?? { real: [], renderer: [] }}
                {@const rLatest = latestSig(tl.real)}
                {@const eLatest = latestSig(tl.renderer)}
                <div class="timeline-row" class:mismatch={!!(rLatest && eLatest) && !sigsMatch(rLatest, eLatest)}>
                  <div class="tl-col">
                    <div class="tl-label">real app</div>
                    {#if tl.real.length === 0}
                      <div class="tl-empty">no snapshots yet</div>
                    {:else}
                      {#each tl.real.slice().reverse().slice(0, 5) as entry}
                        <div class="tl-entry">
                          <span class="tl-ts">{formatTs(entry.ts)}</span>
                          <span class="tl-sig">{sigPreview(entry.sig)}</span>
                        </div>
                      {/each}
                    {/if}
                  </div>
                  <div class="tl-col">
                    <div class="tl-label">my app</div>
                    {#if tl.renderer.length === 0}
                      <div class="tl-empty">no snapshots yet (pair the tag?)</div>
                    {:else}
                      {#each tl.renderer.slice().reverse().slice(0, 5) as entry}
                        <div class="tl-entry">
                          <span class="tl-ts">{formatTs(entry.ts)}</span>
                          <span class="tl-sig">{sigPreview(entry.sig)}</span>
                        </div>
                      {/each}
                    {/if}
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if tags.length > 0 && (filteredDiscovery.length > 0 || (showDismissed && dismissedList.length > 0))}
        <div class="section-divider">Discovered</div>
      {/if}

      {#if filteredDiscovery.length === 0 && discoveryGroups.length === 0 && !(showDismissed && dismissedList.length > 0)}
        {#if tags.length === 0}<div class="hint">no tags yet — click "+ Tag element" above, or interact with the real app to surface candidates</div>{/if}
      {:else}
        {#if ungroupedCandidates.length > 0}
          <ul class="discovery-list">
            {#each ungroupedCandidates as c (c.id)}
              {@render candidateRow(c)}
            {/each}
          </ul>
        {/if}

        {#if showDismissed && dismissedList.length > 0}
          <div class="disc-group color-grey">
            <div class="disc-group-head">
              <span class="disc-group-dot color-grey"></span>
              <span class="disc-group-name">Dismissed</span>
              <span class="disc-group-count">{dismissedList.length}</span>
            </div>
            <ul class="discovery-list dismissed-list">
              {#each dismissedList as d (d.key)}
                <li class="discovery-item dismissed">
                  <div class="disc-head">
                    <span class="disc-path">{@render hl(d.key)}</span>
                    <span class="spacer"></span>
                    <button class="action" onclick={() => restoreDismissed(d.key)} title="restore">restore</button>
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        {#each groupedSections as section (section.group.id)}
          {@const g = section.group}
          <div class="disc-group color-{g.color}">
            <div class="disc-group-head">
              <button class="disc-group-toggle" onclick={() => toggleGroupCollapsed(g)}>
                <span class="caret">{section.expanded ? '▾' : '▸'}</span>
                <span class="disc-group-dot color-{g.color}"></span>
                {#if renamingGroupId === g.id}
                  <input
                    class="rename-input"
                    bind:value={renameGroupDraft}
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') commitRenameGroup(g);
                      if (e.key === 'Escape') cancelRenameGroup();
                    }}
                    onblur={() => commitRenameGroup(g)}
                    autofocus
                  />
                {:else}
                  <span class="disc-group-name">{g.name}</span>
                {/if}
                <span class="disc-group-count">{section.members.length}</span>
              </button>
              <span class="spacer"></span>
              <button class="action" onclick={() => cycleGroupColor(g)} title="cycle color">●</button>
              <button class="action" onclick={() => startRenameGroup(g)} title="rename">rename</button>
              <button
                class="action del"
                class:pending={pendingDeleteGroupId === g.id}
                onclick={() => deleteGroup(g)}
                title={pendingDeleteGroupId === g.id ? 'click again to confirm' : 'delete group (members become ungrouped)'}
              >{pendingDeleteGroupId === g.id ? 'confirm?' : '×'}</button>
            </div>
            {#if section.expanded}
              <ul class="discovery-list">
                {#each section.members as c (c.id)}
                  {@render candidateRow(c)}
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {:else if activeTab === 'streams'}
    <div class="workspace-body">
      {#if exposedEndpoints.length > 0}
        <h4 class="howto-h">Exposed</h4>
        <ul class="ep-list">
          {#each exposedEndpoints as e (e.id)}
            {@const isExpanded = expandedEndpointIds.has(e.id)}
            {@const isEditing = editingExposedId === e.id}
            <li class="ep-item exposed" class:expanded={isExpanded}>
              {#if isEditing}
                <div class="ep-expose">
                  <input class="ep-name-input" bind:value={editDraftName} placeholder="name" onkeydown={(ev) => { if (ev.key === 'Enter') commitEditExposed(e.id); if (ev.key === 'Escape') cancelEditExposed(); }} />
                  <input class="ep-path-input" bind:value={editDraftPath} placeholder="pattern" onkeydown={(ev) => { if (ev.key === 'Enter') commitEditExposed(e.id); if (ev.key === 'Escape') cancelEditExposed(); }} />
                  <button class="action" onclick={() => commitEditExposed(e.id)}>save</button>
                  <button class="action cancel" onclick={cancelEditExposed}>cancel</button>
                </div>
              {:else}
                <div class="ep-head" role="button" tabindex="0" onclick={() => toggleEndpoint(e.id)} onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggleEndpoint(e.id); }}>
                  <span class="caret">{isExpanded ? '▾' : '▸'}</span>
                  <span class="ep-name">{e.exposedAs}</span>
                  <span class="ep-method ep-{e.method.toLowerCase()}">{e.method}</span>
                  <span class="ep-path">{e.normalizedPath}</span>
                  <span class="ep-kind kind-{e.kind}">{e.kind}</span>
                  {#if e.hitCount > 0}<span class="ep-hits" title="hit count">×{e.hitCount}</span>{/if}
                  {#if e.kind === 'stream'}{@const sc = streamsForEndpoint(e).length}{#if sc > 0}<span class="ep-streams" title="buffered streams">{sc} stream{sc === 1 ? '' : 's'}</span>{/if}{/if}
                  <span class="spacer"></span>
                  <button class="action" onclick={(ev) => { ev.stopPropagation(); copySnippet(e); }} title="copy fetch() snippet">{copiedSnippetFor === e.id ? '✓ copied' : 'snippet'}</button>
                  {#if e.kind === 'stream'}<button class="action chunks-btn" onclick={(ev) => { ev.stopPropagation(); toggleMswPreview(e); }} title="copy captured chunks with original timing — use with MSW, Playwright, or any test framework">{mswPreviewFor === e.id ? 'hide chunks' : 'chunks'}</button>{/if}
                  <button class="action" onclick={(ev) => { ev.stopPropagation(); startEditExposed(e); }} title="edit">edit</button>
                  <button class="action del" onclick={(ev) => { ev.stopPropagation(); unexposeEndpoint(e.id); }} title="unexpose">×</button>
                </div>
              {/if}
              {#if isExpanded && !isEditing}
                {@render endpointDrillDown(e)}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if uncatalogedEndpoints.length > 0}
        <h4 class="howto-h">Discovered {#if uncatalogedEndpoints.length > 0}<span class="disc-count">({uncatalogedEndpoints.length})</span>{/if}</h4>
        <ul class="ep-list">
          {#each uncatalogedEndpoints as e (e.id)}
            {@const isExpanded = expandedEndpointIds.has(e.id)}
            <li class="ep-item" class:expanded={isExpanded}>
              <div class="ep-head" role="button" tabindex="0" onclick={() => toggleEndpoint(e.id)} onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggleEndpoint(e.id); }}>
                <span class="caret">{isExpanded ? '▾' : '▸'}</span>
                <span class="ep-method ep-{e.method.toLowerCase()}">{e.method}</span>
                <span class="ep-path">{e.normalizedPath}</span>
                <span class="ep-kind kind-{e.kind}">{e.kind}</span>
                <span class="ep-hits" title="hit count">×{e.hitCount}</span>
                {#if e.kind === 'stream'}{@const sc = streamsForEndpoint(e).length}{#if sc > 0}<span class="ep-streams" title="buffered streams">{sc} stream{sc === 1 ? '' : 's'}</span>{/if}{/if}
                <span class="spacer"></span>
                <button class="action del" onclick={(ev) => { ev.stopPropagation(); dismissEndpoint(e.id); }} title="dismiss (persistent per-domain)">×</button>
              </div>
              <div class="ep-expose">
                <input
                  class="ep-name-input"
                  placeholder="name (e.g. {defaultEndpointName(e)})"
                  bind:value={exposeDraftName[e.id]}
                  onclick={(ev) => ev.stopPropagation()}
                  onkeydown={(ev) => { if (ev.key === 'Enter') exposeEndpoint(e.id); }}
                />
                <input
                  class="ep-path-input"
                  placeholder={e.normalizedPath}
                  value={exposeDraftPath[e.id] ?? e.normalizedPath}
                  onclick={(ev) => ev.stopPropagation()}
                  oninput={(ev) => { exposeDraftPath[e.id] = (ev.currentTarget as HTMLInputElement).value; }}
                  onkeydown={(ev) => { if (ev.key === 'Enter') exposeEndpoint(e.id); }}
                  title="route pattern — edit to use :placeholders, e.g. /:username/:repo"
                />
                <button class="action" onclick={(ev) => { ev.stopPropagation(); exposeEndpoint(e.id); }} disabled={!(exposeDraftName[e.id] ?? '').trim()}>expose</button>
              </div>
              {#if exposeError[e.id]}<div class="ep-err">{exposeError[e.id]}</div>{/if}
              {#if isExpanded}
                {@render endpointDrillDown(e)}
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if dismissedEndpoints.length > 0}
        <div class="ep-dismissed-header">
          <button class="action" onclick={() => (showDismissedEndpoints = !showDismissedEndpoints)}>
            {showDismissedEndpoints ? '▾' : '▸'} Dismissed ({dismissedEndpoints.length})
          </button>
          {#if showDismissedEndpoints}
            <span class="spacer"></span>
            <button class="action" onclick={clearAllDismissedEndpoints}>clear all</button>
          {/if}
        </div>
        {#if showDismissedEndpoints}
          <ul class="ep-list">
            {#each dismissedEndpoints as d (d.id)}
              <li class="ep-item dismissed">
                <div class="ep-head">
                  <span class="ep-path">{d.id}</span>
                  <span class="spacer"></span>
                  <button class="action" onclick={() => restoreDismissedEndpoint(d.id)}>restore</button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}

      {#if endpoints.length === 0 && dismissedEndpoints.length === 0}
        <div class="hint">no requests observed yet — interact with the real app</div>
      {/if}
    </div>
  {:else if activeTab === 'howto'}
    <div class="workspace-body howto-body">
      <div class="howto-intro">
        <h3>How Replicata works</h3>
        <p>Connect a real app and your app (<code>localhost</code>). Replicata observes the real app's streaming responses and replays them into yours. Tag interactive elements to mirror their events.</p>
      </div>

      <h4 class="howto-h">First-time setup</h4>
      <ol class="howto-steps">
        <li>
          <span class="howto-step-num">1</span>
          <div>
            <div class="howto-step-title">Open the real app in the Replicata-launched Chrome window</div>
            <div class="howto-step-body">Replicata runs Chrome with a private profile at <code>~/.kata/chrome-profile</code>. <strong>Use that window</strong> — not your regular Chrome — or Replicata can't observe the bytes.</div>
          </div>
        </li>
        <li>
          <span class="howto-step-num">2</span>
          <div>
            <div class="howto-step-title">Sign in + solve any Cloudflare / CAPTCHA challenge</div>
            <div class="howto-step-body">The first time you visit a site, you may see "Just a moment…" or a login wall. Click through it once — the session persists across restarts. Replicata doesn't bypass these, it waits for you.</div>
          </div>
        </li>
        <li>
          <span class="howto-step-num">3</span>
          <div>
            <div class="howto-step-title">Open your renderer on <code>localhost</code> in the same Chrome</div>
            <div class="howto-step-body">Any port works. Any framework. Replicata rewrites the fetch calls you exposed in the Network tab.</div>
          </div>
        </li>
        <li>
          <span class="howto-step-num">4</span>
          <div>
            <div class="howto-step-title">Pair them in the Connection panel above</div>
            <div class="howto-step-body">Pick the real-app tab + your localhost tab. That's it — you're wired.</div>
          </div>
        </li>
      </ol>

      <h4 class="howto-h">Recipes</h4>
      <ul class="recipe-list">
        <li class="recipe-item recipe-row">
          <div class="recipe-body">
            <div class="recipe-title">Mirror a user action</div>
            <div class="recipe-hint">Type / click in real, see it fire in yours.</div>
          </div>
          <button class="action" onclick={startMirrorInput}>▶ Tour</button>
        </li>
        <li class="recipe-item recipe-row">
          <div class="recipe-body">
            <div class="recipe-title">Consume a streaming response</div>
            <div class="recipe-hint">Pipe real app's SSE / JSON into your fetch.</div>
          </div>
          <button class="action" onclick={startMirrorResponse}>▶ Tour</button>
        </li>
      </ul>

      <div class="howto-actions">
        <a class="howto-link" href="https://replicata.dev/docs" target="_blank" rel="noopener">Open full docs →</a>
      </div>

      <h4 class="howto-h">Setup progress</h4>
      <ul class="recipe-list">
        {#each recipeSteps as step}
          <li class="recipe-item" class:done={step.done}>
            <span class="recipe-pip" class:done={step.done}>{step.done ? '✓' : '○'}</span>
            <div class="recipe-body">
              <div class="recipe-title">{step.title}</div>
              <div class="recipe-hint">{step.hint}</div>
            </div>
            {#if step.action}
              <button class="action" onclick={step.action.run} disabled={step.action.disabled}>{step.action.label}</button>
            {/if}
          </li>
        {/each}
      </ul>

      <h4 class="howto-h">Found a bug or have a suggestion?</h4>
      <p class="howto-p">Email <a href="mailto:hello@replicata.dev">hello@replicata.dev</a> or paste a note below — we read everything.</p>
      <textarea class="howto-feedback" placeholder="Your feedback…" bind:value={feedbackDraft}></textarea>
      <div class="row">
        <span class="howto-sent" class:visible={feedbackSent}>Thanks — sent.</span>
        <span class="spacer"></span>
        <button onclick={submitFeedback} disabled={!feedbackDraft.trim() || feedbackSending}>{feedbackSending ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  {/if}
</div>

{#snippet endpointDrillDown(e: EndpointEntry)}
  {#if mswPreviewFor === e.id}
    <div class="msw-preview">
      <div class="msw-header">
        <span class="msw-title">captured chunks</span>
        <button class="action" onclick={copyMswHandler}>{mswCopied === e.id ? '✓ copied' : 'copy'}</button>
      </div>
      <pre class="msw-code">{mswPreviewCode}</pre>
    </div>
  {/if}
  <div class="ep-body">
    {#if e.kind === 'stream'}
      {@const matchingStreams = streamsForEndpoint(e)}
      {#if matchingStreams.length === 0}
        <div class="hint">no streams captured yet for this endpoint</div>
      {:else}
        <div class="view-toggle">
          <button class="toggle" class:on={streamViewMode === 'parsed'} onclick={() => (streamViewMode = 'parsed')}>parsed</button>
          <button class="toggle" class:on={streamViewMode === 'raw'} onclick={() => (streamViewMode = 'raw')}>raw</button>
        </div>
        <ul class="streamlist">
          {#each matchingStreams.slice().reverse() as s (s.streamId)}
            {@const sExpanded = expandedStreamIds.has(s.streamId)}
            <li class="stream-item" class:expanded={sExpanded}>
              <div class="stream-header-row" role="button" tabindex="0"
                onclick={() => toggleStream(s.streamId)}
                onkeydown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') toggleStream(s.streamId); }}>
                <span class="caret">{sExpanded ? '▾' : '▸'}</span>
                <span class="stream-status" class:live={!s.done}>{s.done ? '✓' : '…'}</span>
                <span class="stream-url" title={s.url}>{shortUrl(s.url)}</span>
                <span class="spacer"></span>
                <span class="stream-meta">{s.chunks}c · {formatBytes(s.bytes)}</span>
                <button class="action del" title="delete stream" onclick={(ev) => { ev.stopPropagation(); deleteStream(s.streamId); }}>×</button>
              </div>
              {#if sExpanded}
                <div class="stream-body">
                  {#if streamBodies[s.streamId] === undefined}
                    <div class="hint">loading…</div>
                  {:else if streamViewMode === 'raw'}
                    <pre class="raw-bytes">{streamBodies[s.streamId]}</pre>
                  {:else}
                    {@const msgs = streamParsed[s.streamId] ?? []}
                    {#if msgs.length === 0}
                      <div class="hint">no SSE messages parsed</div>
                    {:else}
                      <div class="sse-msgs">
                        {#each msgs as m, i (i)}
                          <div class="sse-msg">
                            <div class="sse-head">
                              <span class="sse-idx">#{i}</span>
                              {#if m.event}<span class="sse-event">{m.event}</span>{/if}
                            </div>
                            {#if m.parsed !== undefined}
                              <JsonView value={m.parsed} />
                            {:else}
                              <div class="sse-plain">{m.data || m.raw}</div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <div class="ep-sample">
        {#if e.sample.url}
          <div class="ep-sample-row"><span class="ep-sample-label">last url</span><span class="ep-sample-val">{e.sample.url}</span></div>
        {/if}
        {#if e.sample.status}
          <div class="ep-sample-row"><span class="ep-sample-label">status</span><span class="ep-sample-val">{e.sample.status}</span></div>
        {/if}
        {#if e.sample.contentType}
          <div class="ep-sample-row"><span class="ep-sample-label">content-type</span><span class="ep-sample-val">{e.sample.contentType}</span></div>
        {/if}
        {#if e.sample.bytes}
          <div class="ep-sample-row"><span class="ep-sample-label">size</span><span class="ep-sample-val">{formatBytes(e.sample.bytes)}</span></div>
        {/if}
      </div>
      <div class="view-toggle">
        <button class="toggle" class:on={streamViewMode === 'parsed'} onclick={() => (streamViewMode = 'parsed')}>parsed</button>
        <button class="toggle" class:on={streamViewMode === 'raw'} onclick={() => (streamViewMode = 'raw')}>raw</button>
      </div>
      {@const cached = endpointBodies[e.id]}
      {#if cached === undefined || cached === 'loading'}
        <div class="hint">loading…</div>
      {:else if cached === 'empty'}
        <div class="hint">no response cached yet for this endpoint — trigger it in the real app</div>
      {:else if streamViewMode === 'raw'}
        <pre class="raw-bytes">{cached.body}</pre>
      {:else if cached.parsed !== undefined}
        <JsonView value={cached.parsed} />
      {:else}
        <pre class="raw-bytes">{cached.body}</pre>
      {/if}
    {/if}
  </div>
{/snippet}

{#snippet candidateRow(c: DiscoveryCandidate)}
  <li
    class="discovery-item"
    class:removed={c.presence === 'removed'}
    onmouseenter={() => { if (c.presence === 'present') fetch(`/discovery/${c.id}/highlight`, { method: 'POST' }).catch(() => {}); }}
    onmouseleave={() => { fetch('/highlight/clear', { method: 'POST' }).catch(() => {}); }}
  >
    <div class="disc-head">
      <span class="tag-name">&lt;{@render hl(c.picked.tagName)}&gt;</span>
      {#if c.picked.text}<span class="tag-text">{@render hl(c.picked.text)}</span>{/if}
      {#if c.picked.ariaLabel}<span class="disc-chip aria" title="aria-label">{@render hl(c.picked.ariaLabel)}</span>{/if}
      {#if c.picked.role}<span class="disc-chip role" title="role">{@render hl(c.picked.role)}</span>{/if}
      {#if c.picked.testId}<span class="disc-chip testid" title="data-testid">{@render hl(c.picked.testId)}</span>{/if}
      <span class="spacer"></span>
      {#if c.presence === 'removed'}<span class="disc-chip removed-chip">removed</span>{/if}
      <span class="disc-count" title="mutation count">{c.mutationCount}</span>
      <div class="hamburger-wrap">
        <button class="action hamburger" title="group" onclick={(e) => { e.stopPropagation(); menuOpenFor = menuOpenFor === c.id ? null : c.id; }}>⋯</button>
        {#if menuOpenFor === c.id}
          <div class="group-menu">
            <div class="group-menu-label">Add to group</div>
            {#each discoveryGroups as g}
              <button class="group-menu-item" onclick={() => assignGroup(c.id, g.id)}>
                <span class="disc-group-dot color-{g.color}"></span>{g.name}
                {#if c.groupId === g.id}<span class="group-menu-check">✓</span>{/if}
              </button>
            {/each}
            {#if c.groupId}
              <button class="group-menu-item" onclick={() => assignGroup(c.id, null)}>Remove from group</button>
            {/if}
            {#if creatingGroupFor === c.id}
              <div class="group-menu-create">
                <input
                  class="disc-name"
                  placeholder="Group name"
                  bind:value={newGroupName}
                  onclick={(e) => e.stopPropagation()}
                  onkeydown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitCreateGroup(c.id);
                    if (e.key === 'Escape') cancelCreateGroup();
                  }}
                  autofocus
                />
              </div>
            {:else}
              <button class="group-menu-item new" onclick={() => startCreateGroup(c.id)}>+ New group…</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="action del" title="dismiss" onclick={() => dismissDiscovery(c.id)}>×</button>
    </div>
    {#if c.handlerKinds.length > 0 || c.signals.length > 0}
      <div class="disc-kinds">
        {#each c.handlerKinds as h}<span class="kind handler">{@render hl(h)}</span>{/each}
        {#each c.signals as s}<span class="kind signal">{@render hl(s)}</span>{/each}
      </div>
    {/if}
    <div class="disc-path">{@render hl(c.picked.cssPath)}</div>
    {#if c.presence === 'present'}
      <div class="disc-actions">
        <input
          class="disc-name"
          placeholder={suggestName(c.picked)}
          bind:value={discoveryDraftName[c.id]}
          onkeydown={(e) => { if (e.key === 'Enter') tagFromDiscovery(c); }}
        />
        <button class="action" onclick={() => tagFromDiscovery(c)} disabled={!(discoveryDraftName[c.id] ?? '').trim()}>tag this</button>
      </div>
    {/if}
  </li>
{/snippet}

<!-- LOG FOOTER -->
<div class="log-footer" class:expanded={logExpanded}>
  <button
    class="log-toggle"
    class:error={lastLog?.level === 'error'}
    onclick={() => (logExpanded = !logExpanded)}
    title={logExpanded ? 'collapse log' : 'expand log'}
  >
    <span class="caret">{logExpanded ? '▾' : '▸'}</span>
    {#if lastLog}
      <span class="log-ts">{lastLog.ts}</span>
      <span class="log-msg">{lastLog.msg}</span>
    {:else}
      <span class="log-msg hint">(log empty)</span>
    {/if}
    <span class="spacer"></span>
    {#if logs.length > 0}<span class="log-count">{logs.length}</span>{/if}
  </button>
  {#if logExpanded}
    <div class="log-history">
      {#each logs.slice().reverse() as entry}
        <div class="log-line" class:error={entry.level === 'error'}>
          <span class="log-ts">{entry.ts}</span>
          <span class="log-msg">{entry.msg}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(*) { margin: 0; padding: 0; box-sizing: border-box; }
  :global(body) { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 16px 16px 48px 16px; }
  h1 { font-size: 18px; font-weight: 600; color: #fff; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .health { display: flex; gap: 6px; align-items: center; }
  .pip { font-size: 10px; padding: 2px 8px; border-radius: 10px; border: 1px solid #333; background: #141420; color: #888; font-family: monospace; text-transform: uppercase; letter-spacing: 0.4px; }
  .pip.global-connected { color: #4ade80; border-color: #1a3a1a; background: #0f1a0f; }
  .pip.global-disconnected { color: #fbbf24; border-color: #665a22; background: #2a2210; }
  .pip.global-fatal { color: #e94560; border-color: #663333; background: #2a1010; }
  .pip.global-initializing { color: #aaa; }
  .pip.wiring-unwired { color: #888; }
  .pip.wiring-installingReal,
  .pip.wiring-installingMy,
  .pip.wiring-installingMyAfterReal,
  .pip.wiring-installingRealAfterMy { color: #60a5fa; border-color: #2a3a5a; }
  .pip.wiring-realOnly,
  .pip.wiring-myOnly { color: #fbbf24; border-color: #665a22; }
  .pip.wiring-ready { color: #4ade80; border-color: #1a3a1a; background: #0f1f1a; font-weight: 600; }
  .pip.pip-stream-buffering { color: #60a5fa; border-color: #2a3a5a; }
  .pip.pip-stream-replaying { color: #4ade80; border-color: #1a3a1a; }
  .pip.pip-stream-buffered { color: #aaa; }
  .pip.pip-stream-idle { color: #666; }

  .panel { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 12px; margin-bottom: 12px; }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; }
  .value { font-size: 13px; font-variant-numeric: tabular-nums; }
  .value.active { color: #4ade80; }
  .value.idle { color: #888; }
  .totals { font-size: 11px; color: #666; font-variant-numeric: tabular-nums; margin-top: 4px; }

  .workspace-panel { padding: 0; }
  .workspace-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-bottom: 1px solid #222; }
  .ws-tab { background: transparent; border: none; color: #888; padding: 4px 10px; font-size: 12px; border-radius: 4px; }
  .ws-tab:hover { color: #e0e0e0; background: #141a30; }
  .ws-tab.active { color: #4ade80; background: #0f1f1a; }
  .workspace-body { padding: 12px; }

  .disc-search { flex: 1; min-width: 120px; max-width: 260px; background: #0a0e1a; border: 1px solid #333; border-radius: 4px; padding: 3px 8px; color: #e0e0e0; font-size: 11px; }
  .disc-search:focus { border-color: #4ade80; outline: none; }
  mark.hl { background: #3a3a00; color: #fbbf24; padding: 0 1px; border-radius: 2px; }
  .disc-filter { display: inline-flex; align-items: center; gap: 4px; color: #888; font-size: 11px; }
  .disc-filter input { accent-color: #4ade80; }
  .discovery-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
  .discovery-item { background: #0f1424; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; }
  .discovery-item.removed { opacity: 0.5; border-style: dashed; }
  .disc-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .disc-chip { font-size: 10px; padding: 1px 5px; border-radius: 3px; border: 1px solid #333; background: #0a0e1a; color: #bbb; }
  .disc-chip.aria { color: #60a5fa; border-color: #224; }
  .disc-chip.role { color: #fbbf24; border-color: #442; }
  .disc-chip.testid { color: #c084fc; border-color: #332255; }
  .disc-chip.removed-chip { color: #e94560; border-color: #663333; }
  .disc-count { color: #888; font-size: 11px; font-variant-numeric: tabular-nums; }
  .disc-kinds { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .kind { font-family: monospace; font-size: 10px; padding: 1px 5px; border-radius: 3px; }
  .kind.handler { color: #4ade80; background: #0f1a0f; border: 1px solid #1a3a1a; }
  .kind.signal { color: #60a5fa; background: #0f1424; border: 1px solid #223; }
  .disc-path { font-family: monospace; font-size: 10px; color: #666; margin-top: 6px; word-break: break-all; }
  .disc-actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .disc-name { flex: 1; background: #0a0e1a; border: 1px solid #444; border-radius: 4px; padding: 4px 8px; color: #e0e0e0; font-size: 12px; }
  .disc-name:focus { border-color: #4ade80; outline: none; }

  .hamburger-wrap { position: relative; display: inline-block; }
  .hamburger { opacity: 0; transition: opacity 120ms; }
  .discovery-item:hover .hamburger { opacity: 1; }
  .group-menu { position: absolute; right: 0; top: calc(100% + 4px); background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 4px; min-width: 180px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 20; }
  .group-menu-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: 0.4px; padding: 4px 8px; }
  .group-menu-item { display: flex; align-items: center; gap: 6px; width: 100%; background: transparent; border: none; color: #e0e0e0; font-size: 12px; padding: 4px 8px; border-radius: 4px; text-align: left; cursor: pointer; }
  .group-menu-item:hover { background: #141a30; }
  .group-menu-item.new { color: #4ade80; border-top: 1px solid #222; margin-top: 2px; padding-top: 6px; }
  .group-menu-check { margin-left: auto; color: #4ade80; }

  .disc-group { margin-top: 10px; border: 1px solid #333; border-radius: 6px; overflow: hidden; }
  .disc-group-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #141420; border-bottom: 1px solid #222; }
  .disc-group-toggle { display: flex; align-items: center; gap: 6px; background: transparent; border: none; color: #e0e0e0; font-size: 13px; padding: 0; cursor: pointer; }
  .disc-group-name { font-weight: 600; }
  .disc-group-count { color: #888; font-size: 11px; font-variant-numeric: tabular-nums; }
  .disc-group .discovery-list { padding: 6px; gap: 4px; }

  .disc-group-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .color-grey   { --gc: #888; }
  .color-red    { --gc: #e94560; }
  .color-yellow { --gc: #fbbf24; }
  .color-green  { --gc: #4ade80; }
  .color-blue   { --gc: #60a5fa; }
  .color-purple { --gc: #c084fc; }
  .disc-group-dot.color-grey   { background: #888; }
  .disc-group-dot.color-red    { background: #e94560; }
  .disc-group-dot.color-yellow { background: #fbbf24; }
  .disc-group-dot.color-green  { background: #4ade80; }
  .disc-group-dot.color-blue   { background: #60a5fa; }
  .disc-group-dot.color-purple { background: #c084fc; }
  .disc-group.color-grey   { border-color: #555; }
  .disc-group.color-red    { border-color: #663333; }
  .disc-group.color-yellow { border-color: #665a22; }
  .disc-group.color-green  { border-color: #1a4a1a; }
  .disc-group.color-blue   { border-color: #2a3a5a; }
  .disc-group.color-purple { border-color: #4a2a5a; }

  .zone-connection { background: #141420; }

  .connection-summary { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
  .summary-url { font-family: monospace; color: #bbb; }
  .summary-sep { color: #555; }

  .log { background: #111; border: 1px solid #333; border-radius: 6px; padding: 10px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin-top: 6px; }

  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .hint { color: #aaa; font-size: 13px; margin-top: 8px; }
  button { background: #2a2a3a; color: #e0e0e0; border: 1px solid #444; border-radius: 6px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: #3a3a4a; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.cancel { background: #3a1a1a; border-color: #663333; }
  button.action { padding: 2px 8px; font-size: 11px; }
  button.action.del { background: transparent; border-color: #444; color: #888; }
  button.action.del:hover { background: #3a1a1a; border-color: #663333; color: #e94560; }
  button.action.del.pending { background: #3a1a1a; border-color: #e94560; color: #e94560; }
  input { flex: 1; background: #0f1424; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; color: #e0e0e0; font-size: 13px; outline: none; }
  input:focus { border-color: #4ade80; }

  .preview { background: #0f1424; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
  .cssPath { font-family: monospace; font-size: 11px; color: #888; margin-top: 4px; word-break: break-all; }
  .tag-name { color: #e94560; font-family: monospace; font-size: 12px; }
  .tag-text { color: #aaa; font-size: 12px; margin-left: 6px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .taglist { list-style: none; margin-top: 8px; }
  .tag-item { background: #0f1424; border: 1px solid #333; border-radius: 6px; margin-bottom: 4px; overflow: hidden; transition: border-color 120ms; }
  .tag-item.stale { border-color: #f59e0b; }
  .tag-item.expanded { border-color: #4ade80; }
  .tag-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; }
  .tag-header:hover, .tag-header.highlighted { background: #141a30; }
  .caret { color: #666; font-size: 10px; width: 10px; flex-shrink: 0; }
  .health-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; flex-shrink: 0; }
  .health-dot.match { background: #4ade80; }
  .health-dot.mismatch { background: #f59e0b; }
  .health-dot.missing { background: #555; }
  .tag-badge { background: #4ade80; color: #0a0a0a; font-weight: 600; border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: text; }
  .rename-input { flex: 0 1 auto; width: auto; max-width: 200px; background: #0a0a0a; border: 1px solid #4ade80; border-radius: 4px; padding: 2px 6px; font-size: 11px; color: #4ade80; font-weight: 600; }
  .count { color: #888; font-size: 11px; font-variant-numeric: tabular-nums; }
  .pair.paired { color: #4ade80; font-size: 13px; }
  .pair.unpaired { background: transparent; border: 1px dashed #666; color: #aaa; font-size: 10px; padding: 1px 5px; border-radius: 3px; cursor: pointer; }
  .pair.unpaired:hover { border-color: #4ade80; color: #4ade80; }

  .timeline-row { display: flex; gap: 8px; background: #0a0e1a; padding: 8px 10px; border-top: 1px solid #222; }
  .timeline-row.mismatch { background: #1e1608; }
  .tl-col { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .tl-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #888; margin-bottom: 4px; }
  .tl-entry { font-size: 11px; display: flex; gap: 6px; align-items: baseline; overflow: hidden; }
  .tl-ts { color: #666; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .tl-sig { color: #bbb; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-empty { color: #555; font-size: 11px; font-style: italic; }

  .tag-meta { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 10px 8px; }

  .section-divider { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: #666; margin: 14px 0 6px; padding-top: 8px; border-top: 1px solid #222; }

  .recipe-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
  .recipe-item { display: flex; gap: 10px; align-items: center; padding: 8px 10px; background: #0f1424; border: 1px solid #333; border-radius: 6px; }
  .recipe-item.done { border-color: #1a3a1a; background: #0f1a0f; }
  .recipe-pip { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; border: 1px solid #555; display: flex; align-items: center; justify-content: center; color: #666; font-size: 12px; font-weight: 600; }
  .recipe-pip.done { border-color: #4ade80; color: #4ade80; }
  .recipe-body { flex: 1; min-width: 0; }
  .recipe-title { font-size: 13px; color: #e0e0e0; }
  .recipe-item.done .recipe-title { color: #4ade80; }
  .recipe-hint { font-size: 11px; color: #888; margin-top: 2px; }

  .howto-body { display: flex; flex-direction: column; gap: 10px; }
  .howto-intro h3 { font-size: 15px; color: #e0e0e0; margin-bottom: 6px; }
  .howto-intro p { font-size: 12px; color: #aaa; line-height: 1.5; }
  .howto-intro code { background: #0a0e1a; padding: 1px 5px; border-radius: 3px; color: #60a5fa; font-size: 11px; }
  .howto-actions { display: flex; align-items: center; gap: 12px; margin: 4px 0 8px; }
  .howto-link { color: #60a5fa; font-size: 12px; text-decoration: none; }
  .howto-link:hover { text-decoration: underline; }
  .howto-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; color: #888; margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid #222; }
  .howto-p { font-size: 12px; color: #aaa; }
  .howto-p a { color: #60a5fa; }
  .howto-feedback { width: 100%; min-height: 80px; background: #0a0e1a; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; color: #e0e0e0; font-size: 12px; font-family: inherit; resize: vertical; }
  .howto-feedback:focus { border-color: #4ade80; outline: none; }
  .howto-sent { font-size: 11px; color: #4ade80; opacity: 0; transition: opacity 200ms; }
  .howto-sent.visible { opacity: 1; }
  .recipe-row .recipe-title { font-weight: 600; }

  .howto-steps { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-top: 4px; padding: 0; }
  .howto-steps > li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; background: #0f1424; border: 1px solid #333; border-radius: 6px; }
  .howto-step-num { flex-shrink: 0; width: 22px; height: 22px; border-radius: 50%; border: 1px solid #4ade80; color: #4ade80; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: #0f1a0f; }
  .howto-step-title { font-size: 12px; color: #e0e0e0; font-weight: 600; }
  .howto-step-body { font-size: 11px; color: #aaa; margin-top: 3px; line-height: 1.5; }
  .howto-step-body code { background: #0a0e1a; padding: 1px 4px; border-radius: 3px; color: #60a5fa; font-size: 10px; }

  .ep-list { list-style: none; display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
  .ep-item { background: #0f1424; border: 1px solid #333; border-radius: 6px; padding: 8px 10px; }
  .ep-item.exposed { border-color: #1a3a1a; background: #0f1a0f; }
  .ep-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ep-name { font-weight: 600; color: #4ade80; font-size: 12px; }
  .ep-method { font-family: monospace; font-size: 10px; padding: 1px 5px; border-radius: 3px; border: 1px solid #333; background: #0a0e1a; text-transform: uppercase; letter-spacing: 0.4px; }
  .ep-method.ep-get { color: #4ade80; border-color: #1a3a1a; }
  .ep-method.ep-post { color: #fbbf24; border-color: #665a22; }
  .ep-method.ep-put, .ep-method.ep-patch { color: #60a5fa; border-color: #2a3a5a; }
  .ep-method.ep-delete { color: #e94560; border-color: #663333; }
  .ep-path { font-family: monospace; font-size: 11px; color: #c0c0c0; word-break: break-all; }
  .ep-kind { font-size: 10px; color: #888; padding: 1px 5px; border-radius: 3px; border: 1px solid #333; }
  .ep-kind.kind-stream { color: #c084fc; border-color: #4a2a5a; }
  .ep-kind.kind-json { color: #60a5fa; border-color: #2a3a5a; }
  .ep-hits { font-size: 11px; color: #888; font-variant-numeric: tabular-nums; }
  .ep-expose { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
  .ep-name-input { flex: 0 0 140px; background: #0a0e1a; border: 1px solid #444; border-radius: 4px; padding: 3px 8px; color: #e0e0e0; font-size: 11px; }
  .ep-path-input { flex: 1; min-width: 100px; background: #0a0e1a; border: 1px solid #444; border-radius: 4px; padding: 3px 8px; color: #c0c0c0; font-size: 11px; font-family: monospace; }
  .ep-name-input:focus, .ep-path-input:focus { border-color: #4ade80; outline: none; }
  .ep-err { color: #e94560; font-size: 11px; margin-top: 4px; }
  .ep-item .ep-head { cursor: pointer; }
  .ep-item.expanded { border-color: #4ade80; }
  .ep-item.dismissed { opacity: 0.6; border-style: dashed; }
  .ep-body { padding: 8px 10px; border-top: 1px solid #222; background: #0a0e1a; border-radius: 0 0 6px 6px; }
  .msw-preview { border-top: 1px solid #222; background: #0d1117; padding: 8px 12px; }
  .msw-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .msw-title { font-size: 11px; font-weight: 600; color: #4ade80; text-transform: uppercase; letter-spacing: 0.5px; }
  .msw-code { font-size: 11px; line-height: 1.5; color: #c9d1d9; background: #0a0e1a; border: 1px solid #222; border-radius: 4px; padding: 8px 10px; overflow-x: auto; white-space: pre; margin: 0; }
  button.chunks-btn { color: #4ade80; border-color: #1a3a2a; }
  .ep-sample { display: flex; flex-direction: column; gap: 4px; }
  .ep-sample-row { display: flex; gap: 8px; font-size: 11px; }
  .ep-sample-label { color: #888; min-width: 80px; text-transform: uppercase; letter-spacing: 0.4px; font-size: 10px; }
  .ep-sample-val { color: #c0c0c0; font-family: monospace; word-break: break-all; }
  .ep-dismissed-header { display: flex; align-items: center; gap: 6px; margin-top: 10px; padding-top: 8px; border-top: 1px solid #222; }
  .ep-streams { font-size: 10px; color: #c084fc; border: 1px solid #4a2a5a; padding: 1px 5px; border-radius: 3px; background: #1a0f2a; }

  .pip.trial-pip { color: #fbbf24; border-color: #665a22; background: #2a2210; }
  .lock-screen { padding: 28px 24px; text-align: center; max-width: 560px; margin: 40px auto; }
  .lock-title { font-size: 20px; color: #e0e0e0; margin-bottom: 6px; }
  .lock-reason { color: #e94560; font-size: 13px; margin-bottom: 10px; }
  .lock-body { color: #aaa; font-size: 13px; margin-bottom: 18px; line-height: 1.5; }
  .lock-body a { color: #60a5fa; }
  .lock-actions { display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap; }
  .lock-or { color: #666; font-size: 12px; padding: 0 4px; }
  .lock-key { flex: 0 1 220px; background: #0a0e1a; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; color: #e0e0e0; font-family: monospace; font-size: 12px; }
  .lock-key:focus { border-color: #4ade80; outline: none; }
  .lock-err { color: #e94560; font-size: 12px; margin-top: 10px; }

  :global(.kata-tour.shepherd-element) { background: #141420; color: #e0e0e0; border: 1px solid #333; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); max-width: 360px; font-family: system-ui, -apple-system, sans-serif; }
  :global(.kata-tour .shepherd-header) { background: #141420; padding: 12px 14px 4px; border-radius: 8px 8px 0 0; }
  :global(.kata-tour .shepherd-title) { color: #4ade80; font-size: 14px; font-weight: 600; }
  :global(.kata-tour .shepherd-text) { color: #c0c0c0; font-size: 13px; line-height: 1.5; padding: 6px 14px 12px; }
  :global(.kata-tour .shepherd-text code) { background: #0a0e1a; color: #60a5fa; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  :global(.kata-tour .shepherd-text pre.tour-code) { background: #0a0e1a; color: #c0c0c0; padding: 10px 12px; border-radius: 6px; border: 1px solid #222; font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; margin: 8px 0; white-space: pre; overflow-x: auto; }
  :global(.kata-tour .shepherd-text pre.tour-code .hl) { color: #4ade80; font-weight: 600; }
  :global(.kata-tour .shepherd-text small.tour-note) { display: block; color: #888; font-size: 11px; margin-top: 4px; }
  :global(.kata-tour .shepherd-footer) { padding: 0 14px 12px; }
  :global(.kata-tour .shepherd-button) { background: #2a2a3a; color: #e0e0e0; border: 1px solid #444; border-radius: 6px; font-size: 12px; padding: 5px 10px; }
  :global(.kata-tour .shepherd-button:not(:disabled):hover) { background: #3a3a4a; }
  :global(.kata-tour .shepherd-button.shepherd-button-secondary) { background: transparent; color: #888; border-color: transparent; }
  :global(.kata-tour .shepherd-cancel-icon) { color: #888; }
  :global(.kata-tour .shepherd-cancel-icon:hover) { color: #e0e0e0; }
  :global(.kata-tour .shepherd-arrow:before) { background: #141420; border: 1px solid #333; }
  :global(.shepherd-modal-overlay-container) { fill: rgba(0,0,0,0.5); }

  .scenario-grid { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .scenario-grid select { background: #0f1424; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 5px 8px; font-size: 12px; }
  .scenario-grid label { font-size: 11px; color: #aaa; display: flex; align-items: center; gap: 4px; }
  .scenario-grid input[type="number"] { width: 60px; background: #0f1424; border: 1px solid #444; border-radius: 4px; color: #e0e0e0; padding: 4px 6px; font-size: 12px; }
  .scenario-hint { font-size: 10px; color: #666; margin-top: 6px; }

  .tabs { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
  .tab { display: flex; justify-content: space-between; align-items: center; gap: 8px; background: #0f1424; border: 1px solid #333; border-radius: 6px; padding: 6px 10px; }
  .tab.assigned-real { border-color: #4ade80; }
  .tab.assigned-renderer { border-color: #60a5fa; }
  .tab-meta { min-width: 0; flex: 1; }
  .tab-title { font-size: 13px; color: #e0e0e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-url { font-size: 11px; color: #888; font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .chip { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 6px; border-radius: 3px; font-weight: 600; flex-shrink: 0; }
  .chip.real { background: #4ade80; color: #0a0a0a; }
  .chip.renderer { background: #60a5fa; color: #0a0a0a; }
  .assigned { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; margin-bottom: 8px; }

  .spacer { flex: 1; }

  /* Streams */
  .stream-header { display: flex; align-items: center; gap: 8px; }
  .view-toggle { display: flex; gap: 4px; margin-top: 8px; }
  .toggle { padding: 3px 10px; font-size: 11px; background: #0f1424; border: 1px solid #333; }
  .toggle.on { background: #2a3a4a; border-color: #4ade80; color: #4ade80; }
  .streamlist { list-style: none; margin-top: 6px; }
  .stream-item { background: #0f1424; border: 1px solid #333; border-radius: 6px; margin-bottom: 4px; overflow: hidden; }
  .stream-item.expanded { border-color: #4ade80; }
  .stream-header-row { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
  .stream-header-row:hover { background: #141a30; }
  .stream-status { color: #666; }
  .stream-status.live { color: #4ade80; }
  .stream-url { font-family: monospace; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .stream-meta { color: #888; font-size: 11px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .stream-body { padding: 8px 10px; border-top: 1px solid #222; background: #0a0e1a; max-height: 400px; overflow-y: auto; }
  .raw-bytes { font-family: monospace; font-size: 11px; color: #bbb; white-space: pre-wrap; word-break: break-all; }
  .sse-msgs { display: flex; flex-direction: column; gap: 6px; }
  .sse-msg { background: #0f1424; border: 1px solid #222; border-radius: 4px; padding: 6px 8px; }
  .sse-head { display: flex; gap: 8px; align-items: baseline; font-size: 10px; margin-bottom: 4px; }
  .sse-idx { color: #555; font-variant-numeric: tabular-nums; }
  .sse-event { color: #60a5fa; text-transform: uppercase; letter-spacing: 0.3px; }
  .sse-plain { font-family: monospace; font-size: 11px; color: #bbb; white-space: pre-wrap; word-break: break-all; }

  .scenario-panel { background: #141420; }

  .log-footer { position: fixed; bottom: 0; left: 0; right: 0; background: #0a0a0a; border-top: 1px solid #333; z-index: 10; }
  .log-footer.expanded { box-shadow: 0 -8px 24px rgba(0,0,0,0.5); }
  .log-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 16px; background: transparent; border: none; border-radius: 0; font-size: 11px; color: #aaa; font-family: monospace; text-align: left; cursor: pointer; }
  .log-toggle:hover { background: #141420; }
  .log-toggle.error { color: #e94560; }
  .log-toggle.error .log-msg { color: #e94560; }
  .log-toggle .log-ts { color: #666; flex-shrink: 0; }
  .log-toggle .log-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .log-toggle .log-msg.hint { color: #555; font-style: italic; }
  .log-count { color: #666; font-size: 10px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .log-history { max-height: 240px; overflow-y: auto; background: #0a0a0a; border-top: 1px solid #222; padding: 6px 16px; font-family: monospace; font-size: 11px; }
  .log-line { display: flex; gap: 8px; color: #aaa; padding: 1px 0; }
  .log-line.error { color: #e94560; }
  .log-line .log-ts { color: #666; flex-shrink: 0; }
  .log-line .log-msg { word-break: break-word; }
</style>

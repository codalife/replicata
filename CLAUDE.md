# replicata

## What this is

Open-source tool for observing real production streaming web apps and replaying their bytes into a local renderer. Human uses real ChatGPT/Claude/any streaming app normally — replicata passively taps the byte stream and event interactions via CDP, then forwards them into the user's localhost code. User's code is unmodified — it thinks it's talking to a normal SSE endpoint.

The core insight: **observe, don't automate.** Replicata is a DevTools-grade passive tap, not a proxy or bot.

## Quickstart

```bash
npm install && npm run build

# launch Chrome with remote debugging
npm run chrome

# start replicata
npm run dev

# or with hot reload (type-safe, rebuilds on change)
npm run dev:watch

# start the react example renderer
npm run react
```

Open the replicata UI tab → pick your real-app tab + renderer tab → send a message in the real app → bytes flow to the renderer.

---

## Architecture: observe-only, three-window

```
Window 1: Real app (human drives, replicata never touches)
Window 2: User's renderer (localhost, user's own Vite/CRA/etc)
Window 3: Replicata UI (localhost:REPLICATA_PORT/ui)

User launches Chrome with --remote-debugging-port=9222 (npm run chrome).
Replicata connects via CDP (chromium.connectOverCDP) — does NOT launch
Chrome itself. Reason: Playwright-launched Chromium triggers Cloudflare
bot detection. User-launched Chrome is invisible to it.
```

### Data flow

```
Human types in real app → real request fires (not by replicata)
  → fetch wrapper (injected via addInitScript + evaluate) tees response.body
  → tee leg A → app's own JS (untouched, normal render)
  → tee leg B → __replicataChunk(streamId, decodedChunk) via Playwright exposeFunction
  → StreamBuffer accumulates chunks in Node
  → user's renderer code: fetch('/api/chat')
  → renderer-side fetch wrapper rewrites URL to replicata's /stream/ep_xxx
  → replicata server waits for stream to complete, serves with original chunk timing
  → user's code renders the stream
```

### Read end vs. write end (intentional asymmetry)

- **Read end (real app):** passive tap via `tee()`. ToS-clean.
- **Write end (renderer):** active redirect. User's `fetch()` rewritten to replicata's server.
- **Middle:** `StreamBuffer` (Node-side queue per stream).

### Event flow (real → renderer)

```
Human clicks in real app
  → Injected listener on tagged elements captures event
  → Forwards {tag, type, modifiers, ts} to renderer
  → Synthetic DOM event on renderer's [data-replicata-tag] equivalent
```

### Constraint: replicata NEVER

- Makes requests to target apps
- Fires events into real app DOM
- Automates user actions
- Requires changes to user's renderer code

---

## What's shipped

- **Stream tee** — fetch wrapper + response.body.tee() + StreamBuffer with chunk timing
- **Endpoint catalog** — auto-discover, URL normalization (numeric/:id, uuid/:uuid), expose/dismiss, per-domain persistence
- **Stream serving** — waits for stream completion, replays with original timing, scenario injection (latency/disconnect/drop/malformed/rate-limit)
- **Tagging** — CDP picker, smart locator hierarchy, persist per-domain, verify + MutationObserver re-verify, multi-match, broaden/re-tag
- **Event forwarding** — real → renderer via data-replicata-tag, synthetic MouseEvent/KeyboardEvent, React-aware native value setter
- **Discovery** — React fiber walker + MutationObserver + soft signals, Chrome-style groups, persistent dismissal
- **Tag state timeline** — content+signature comparison, side-by-side, mismatch highlighting
- **Scenario injection** — latency multiplier, mid-stream disconnect, drop chunks, rate-limit, malformed chunk
- **Chunks export** — copy captured chunks with real timing from UI (for MSW/Playwright/any test framework)
- **XState runtime machine** — sequential wiring + parallel stream, observer pattern
- **Quint formal spec** — replicata-machine.qnt (15 tests, 13 invariants) + replicata-lifecycle.qnt (16 invariants, found 2 real bugs)
- **Interactive tab assignment** — UI picker, Chrome connect w/ backoff, my-app localhost-only
- **Tab reload survival** — re-injects scripts on page reload via evaluate
- **UI tab reuse** — reuses existing UI tab on hot reload instead of opening new ones
- **Guided tours** — Shepherd.js (mirror-input, mirror-response)
- **React example** — ChatGPT delta-encoding v1 parser + markdown rendering

---

## Module structure

```
core/
  bootstrap/             Playwright connect-over-CDP w/ backoff + UI tab reuse
    index.ts             bootstrap + exponential-backoff CDP connect
  observe/
    network.ts           NetworkTap — fetch wrapper + tee, chunks to Node
    picker.ts            CDP Overlay.setInspectMode picker
    highlight.ts         DOM-overlay highlighter (multi-match)
    targets.ts           TargetWatcher — browser-level CDP Target.*
    discovery.ts         DiscoveryTracker — merge-by-cssPath, sources, presence
    discovery-groups.ts  per-domain Chrome-style groups
    discovery-dismissed.ts persistent dismissal set
    endpoints.ts         endpoint catalog + URL normalization
    endpoints-store.ts   per-domain endpoint persistence
    endpoints-dismissed.ts persistent endpoint dismissal
  bridge/
    stream-buffer.ts     per-stream byte buffer w/ chunk timing
    renderer-route.ts    injects fetch URL-rewriter into renderer
    server.ts            HTTP server: /stream, /events, /tags, /endpoints, /ui, etc
    scenarios.ts         scenario types + chunk corruption
    init-scripts.ts      CDP init script management + cleanup
  injected/              browser-side IIFEs (built via tsconfig.injected.json)
    fetch-tap.ts         real app: tee response.body
    renderer-redirect.ts renderer: rewrite fetch URL → replicata /stream
    resolve-tag.ts       locator resolver + highlighter helpers
    dom-watch.ts         MutationObserver → __replicataDomChanged
    event-tap.ts         capture-phase listener on tagged elements
    event-fire.ts        synthetic event dispatch + React-aware value setter
    state-tap.ts         signature poll (text/attrs/childKey/visible/matchCount)
    discovery.ts         RDT hook + fiber walker → __replicataDiscover
  tagging/
    types.ts             PickedElement, TagLocator, Tag
    store.ts             ~/.replicata/tags/<domain>.json
    resolver.ts          TagResolver → __replicataResolveTag
    timeline.ts          per-tag signature timelines
    api.ts               TaggingApi interface
  machine.ts             XState runtime state machine (replicataMachine)
  runtime.ts             ReplicataRuntime — lifecycle + assignments
  config.ts              REPLICATA constants (host, port, cdpPort)
ui/                      Svelte 5 + Vite
  App.svelte             Elements + Network + How To tabs
  JsonView.svelte        recursive JSON view w/ copy-path
cli/
  index.ts               entry point + chrome subcommand
examples/
  simple-renderer/       minimal plain-HTML
  react-renderer/        Vite + React + TS + Tailwind v4 + markdown
specs/
  replicata-machine.qnt       Quint spec for runtime state machine
  replicata-lifecycle.qnt     Quint spec for full lifecycle (found 2 bugs)
```

---

## Key decisions

| Decision | Choice | Reason |
|---|---|---|
| Architecture | Observe-only passive tap | ToS-clean, no Cloudflare issues |
| Bootstrap | User launches Chrome, replicata connects via CDP | Playwright-launched Chromium triggers Cloudflare |
| Read end | fetch wrapper + response.body.tee() | CDP Network.dataReceived gives no body bytes |
| Write end | URL-rewrite to local SSE server | User writes normal fetch(), no SDK needed |
| Stream serving | Wait for completion, replay with original timing | Avoids race between event forwarding and stream arrival |
| Event direction | Real → renderer only | Human drives real app, renderer reacts |
| Endpoint classification | Auto-catalog, manual expose | Avoids surprising interception bugs |
| Tagging | CDP picker + persist per-domain | Interactive, no code annotation needed |
| Browser lib | playwright-core | Thin sugar over CDP, earns its keep |
| UI framework | Svelte 5 w/ runes | Compiled, small bundle |
| State machine | XState v5 | Executable, inspectable, Quint-verifiable |

---

## Non-goals

- Automating real app in any way
- Request forwarding / proxying
- Public API proxy
- Multi-user collaboration
- Mobile support

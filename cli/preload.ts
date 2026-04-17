// Runtime shims that must execute BEFORE any other module (especially
// playwright-core) evaluates. Imported as the first line in cli/index.ts.
//
// Why delete globalThis.WebSocket:
//   - Bun ships its own globalThis.WebSocket (built on uWebSockets).
//   - Playwright's CDP client ultimately uses the `ws` npm package, which
//     sniffs `globalThis.WebSocket` when available and defers to it.
//   - Bun's WebSocket has subtly different handshake semantics that hang
//     Playwright's connectOverCDP — the underlying WS upgrade never
//     completes, timing out after 30s.
//   - Deleting the global forces `ws` to use its own native impl, which
//     works correctly inside bun-compiled binaries.
//
// Safe under Node (property is non-existent or writeable).

if (typeof globalThis !== 'undefined' && 'WebSocket' in globalThis) {
  try { delete (globalThis as any).WebSocket; } catch {}
}

export {};

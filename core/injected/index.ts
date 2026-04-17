import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Locate the compiled injected/ directory. Injected scripts are compiled
// by tsconfig.injected.json which outDirs to dist/core/injected (same
// folder as this module after tsc). At runtime:
//   - Bundled tarball: they're staged alongside the binary as injected/
//   - tsc output (dev): they're colocated w/ this module in dist/core/injected
//   - bundled CJS: import.meta.url is empty; rely on execDir candidate
function findInjectedDir(): string {
  const candidates: string[] = [];
  if (process.env.REPLICATA_ROOT) {
    candidates.push(resolve(process.env.REPLICATA_ROOT, 'injected'));
  }
  const execDir = dirname(process.execPath);
  candidates.push(resolve(execDir, 'injected'));
  candidates.push(resolve(execDir, '../injected'));
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(dirname(here));      // dev: same dir (dist/core/injected)
  } catch { /* bundled CJS — import.meta.url unavailable */ }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}
const INJECTED_DIR = findInjectedDir();

const cache = new Map<string, string>();

export function loadInjected(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const path = resolve(INJECTED_DIR, `${name}.js`);
  const src = readFileSync(path, 'utf-8');
  cache.set(name, src);
  return src;
}

export function invokeInjected(name: string, args: unknown): string {
  // Strip trailing semicolon TypeScript auto-appends to the IIFE expression
  // statement — otherwise the "(args)" we append becomes a separate expression
  // and the IIFE never gets invoked.
  const src = loadInjected(name).replace(/;\s*$/, '');
  return `${src}(${JSON.stringify(args)});`;
}

import type { Page } from 'playwright-core';
import { invokeInjected } from '../injected/index.js';
import { installInitScript } from './init-scripts.js';

export interface ReplicataRoute { id: string; method: string; normalizedPath: string; }

export async function injectRendererBridge(page: Page, replicataHost: string, replicataPort: number, routes: ReplicataRoute[]): Promise<void> {
  const invocation = invokeInjected('renderer-redirect', { host: replicataHost, port: replicataPort, routes });
  await installInitScript(page, invocation);
}

export async function pushRoutesToRenderer(page: Page, routes: ReplicataRoute[]): Promise<void> {
  // Idempotent — calls __replicataUpdateRoutes if the wrapper is installed; no-ops
  // otherwise (e.g. before first navigation).
  await page.evaluate((next) => {
    (window as any).__replicataUpdateRoutes?.(next);
  }, routes).catch(() => {});
}

import { chromium, type Browser, type Page } from 'playwright-core';
import { REPLICATA } from '../config.js';

export interface ReplicataBoot {
  browser: Browser;
  replicataUiPage: Page;
}

export interface BootstrapOptions {
  replicataUiUrl: string;
  cdpPort: number;
  onRetry?: (attempt: number, delayMs: number) => void;
}

export class CdpConnectError extends Error {
  cdpPort: number;
  cause: Error;
  constructor(port: number, cause: Error) {
    super(`could not connect to Chrome CDP on port ${port}: ${cause.message}`);
    this.name = 'CdpConnectError';
    this.cdpPort = port;
    this.cause = cause;
  }
}

export async function bootstrap(opts: BootstrapOptions): Promise<ReplicataBoot> {
  const browser = await connectWithRetry(opts.cdpPort, opts.onRetry);

  const context = browser.contexts()[0];
  if (!context) throw new Error('no browser context found');

  // Reuse an existing UI tab if one is already open (e.g. after hot reload).
  const uiOrigin = new URL(opts.replicataUiUrl).origin;
  let replicataUiPage: Page | undefined;
  for (const page of context.pages()) {
    if (page.url().startsWith(uiOrigin + '/ui')) {
      replicataUiPage = page;
      await page.goto(opts.replicataUiUrl, { waitUntil: 'domcontentloaded' });
      break;
    }
  }

  if (!replicataUiPage) {
    replicataUiPage = await context.newPage();
    await replicataUiPage.goto(opts.replicataUiUrl, { waitUntil: 'domcontentloaded' });
  }

  return { browser, replicataUiPage };
}

async function connectWithRetry(cdpPort: number, onRetry?: (attempt: number, delayMs: number) => void): Promise<Browser> {
  const url = `http://${REPLICATA.host}:${cdpPort}`;
  let attempt = 0;
  let lastErr: Error | undefined;
  while (attempt < 60) {  // ~5 min @ 5s cap
    try {
      return await chromium.connectOverCDP(url);
    } catch (err) {
      lastErr = err as Error;
      attempt++;
      // Surface the first error — silent retries hide bundling / module
      // resolution failures that would otherwise keep the loop stuck.
      if (attempt === 1 || process.env.REPLICATA_DEBUG === '1') {
        console.error(`[cdp] attempt ${attempt} failed: ${(err as Error).message}`);
      }
      const delayMs = Math.min(500 * Math.pow(1.5, Math.min(attempt, 8)), 5000);
      onRetry?.(attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw new CdpConnectError(cdpPort, lastErr!);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

import type { Browser, Page } from 'playwright-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Install init scripts via raw CDP so we get the identifier back and can
// un-register them on the next replicata start. Playwright's `page.addInitScript`
// hides the identifier, so scripts accumulate across replicata restarts within the
// same Chrome session. Idempotency guards in the injected scripts prevent
// *double-wrapping* at runtime, but registrations still pile up in Chrome's
// per-target list — noisy and occasionally load-bearing (old pre-guard wrappers
// forced full Chrome restarts).
//
// Strategy: persist { targetId, scriptId } per install; on replicata start, iterate
// and call `Page.removeScriptToEvaluateOnNewDocument` best-effort. Targets from
// a previous Chrome session fail silently (Chrome doesn't know them), then we
// clear the file. Also activates `src` on the current page (Playwright's
// convention) so installs take effect without a reload.

const STATE_PATH = path.join(os.homedir(), '.replicata', 'init-scripts.json');

interface Entry { targetId: string; scriptId: string; }
let entries: Entry[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    entries = (JSON.parse(raw) as { entries: Entry[] }).entries ?? [];
  } catch { entries = []; }
}

function persist(): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ entries }, null, 2));
  } catch {}
}

export async function installInitScript(page: Page, src: string): Promise<void> {
  load();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Page.enable').catch(() => {});
    const info = await cdp.send('Target.getTargetInfo').catch(() => null);
    const targetId = info?.targetInfo.targetId;
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    if (targetId) {
      entries.push({ targetId, scriptId: identifier });
      persist();
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  try { await page.evaluate(src); } catch {}
}

export async function cleanupInitScripts(browser: Browser): Promise<void> {
  load();
  if (entries.length === 0) return;
  const context = browser.contexts()[0];
  if (!context) { entries = []; persist(); return; }

  const byTarget = new Map<string, string[]>();
  for (const e of entries) {
    const arr = byTarget.get(e.targetId) ?? [];
    arr.push(e.scriptId);
    byTarget.set(e.targetId, arr);
  }

  for (const page of context.pages()) {
    const cdp = await context.newCDPSession(page).catch(() => null);
    if (!cdp) continue;
    try {
      const info = await cdp.send('Target.getTargetInfo').catch(() => null);
      const tid = info?.targetInfo.targetId;
      if (!tid) continue;
      const ids = byTarget.get(tid);
      if (!ids) continue;
      await cdp.send('Page.enable').catch(() => {});
      for (const id of ids) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(() => {});
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  entries = [];
  persist();
}

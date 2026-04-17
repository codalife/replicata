import type { Page } from 'playwright-core';
import type { TagLocator } from '../tagging/types.js';

// Delegates to browser-side __replicataHighlightMatches / __replicataHideHighlights
// (installed by resolve-tag.ts). DOM overlays — not CDP Overlay.highlightNode —
// because tags can map to collections (multiple message bubbles, list items)
// and CDP Overlay only highlights one node at a time.

export class Highlighter {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async highlight(locator: TagLocator): Promise<boolean> {
    try {
      const count = await this.page.evaluate<number, TagLocator>(
        (loc) => {
          const fn = (window as any).__replicataHighlightMatches;
          return typeof fn === 'function' ? fn(loc) : 0;
        },
        locator,
      );
      return count > 0;
    } catch {
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.page.evaluate(() => {
        const fn = (window as any).__replicataHideHighlights;
        if (typeof fn === 'function') fn();
      });
    } catch {
      // best effort
    }
  }

  async dispose(): Promise<void> {
    await this.clear();
  }
}

import type { Page } from 'playwright-core';
import type { TagLocator } from './types.js';

export type ResolutionStatus = 'resolved' | 'stale';
export type LocatorField = keyof TagLocator;

export interface ResolutionResult {
  status: ResolutionStatus;
  matchedBy?: LocatorField;
  count: number;
  sample?: { text: string; tagName: string };
}

export class TagResolver {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async resolve(locator: TagLocator): Promise<ResolutionResult> {
    try {
      return await this.page.evaluate<ResolutionResult, TagLocator>(
        (loc) => {
          const fn = (window as any).__replicataResolveTag;
          if (typeof fn !== 'function') return { status: 'stale' as const, count: 0 };
          return fn(loc);
        },
        locator,
      );
    } catch {
      return { status: 'stale', count: 0 };
    }
  }
}

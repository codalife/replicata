import type { PickedElement, Tag } from './types.js';
import type { ResolutionResult } from './resolver.js';
import type { TagTimeline } from './timeline.js';

export interface TagWithResolution extends Tag {
  resolution?: ResolutionResult;
  paired?: boolean;
  eventCounts?: Record<string, number>;
}

export interface TaggingApi {
  startPicker(): Promise<PickedElement>;
  cancelPicker(): Promise<void>;
  createTag(name: string, picked: PickedElement): Tag;
  getTags(): TagWithResolution[];
  verifyAll(): Promise<void>;
  removeTag(id: string): boolean;
  renameTag(id: string, name: string): { ok: true; tag: Tag } | { ok: false; reason: 'not-found' | 'duplicate' | 'invalid' };
  replaceLocator(id: string, picked: PickedElement): Tag | null;
  broadenTag(id: string): Promise<TagWithResolution | null>;
  highlightTag(id: string): Promise<boolean>;
  clearHighlight(): Promise<void>;
  getTimeline(tagName: string): TagTimeline;
}

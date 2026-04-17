export interface StateSignature {
  text: string;
  attrs: Record<string, string>;
  childTagsKey: string;
  visible: boolean;
  matchCount: number;
}

export interface TimelineEntry {
  ts: number;
  sig: StateSignature;
}

export type Source = 'real' | 'renderer';

export interface TagTimeline {
  real: TimelineEntry[];
  renderer: TimelineEntry[];
}

const MAX_ENTRIES = 50;

export class TimelineStore {
  private byTag = new Map<string, TagTimeline>();

  push(tagName: string, source: Source, entry: TimelineEntry): void {
    let t = this.byTag.get(tagName);
    if (!t) {
      t = { real: [], renderer: [] };
      this.byTag.set(tagName, t);
    }
    const list = t[source];
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.shift();
  }

  get(tagName: string): TagTimeline {
    return this.byTag.get(tagName) ?? { real: [], renderer: [] };
  }

  clearFor(tagName: string): void {
    this.byTag.delete(tagName);
  }
}

export function signaturesMatch(a: StateSignature, b: StateSignature): boolean {
  return (
    a.text === b.text &&
    a.childTagsKey === b.childTagsKey &&
    a.visible === b.visible &&
    JSON.stringify(a.attrs) === JSON.stringify(b.attrs)
  );
}

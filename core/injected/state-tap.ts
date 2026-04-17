// Installed on BOTH real app AND renderer. Periodically scans tagged
// elements, computes a "state signature" (trimmed text + relevant attrs +
// child-tag summary + visibility). If the signature differs from the last
// captured one, pushes a new timeline entry to Node via __replicataStateSnapshot.
//
// Discovery of tagged elements differs per context:
//   real app: (window as any).__replicataKnownTags (populated by event-tap's cache)
//   renderer: [data-replicata-tag] attribute queries
//
// Source is inferred: presence of __replicataKnownTags ⇒ "real", else "renderer".

interface StateSignature {
  text: string;
  attrs: Record<string, string>;
  childTagsKey: string;   // e.g. "button,span,svg"
  visible: boolean;
  matchCount: number;
}

interface TimelineEntry {
  ts: number;
  sig: StateSignature;
}

interface StateTag {
  name: string;
  locator: {
    testId?: string;
    ariaLabel?: string;
    role?: string;
    text?: string;
    classPath?: string;
    nthChildPath?: string;
    cssPath: string;
  };
}

interface Window {
  // __replicataKnownTags is declared by event-tap — don't redeclare here (script mode merges)
  __replicataStateSnapshot?: (tagName: string, source: 'real' | 'renderer', entry: TimelineEntry) => void;
  __replicataStateTapInstalled?: boolean;
}

const INTERVAL_MS = 1000;
const TRACKED_ATTRS = ['disabled', 'readonly', 'aria-label', 'aria-expanded', 'aria-pressed', 'aria-selected', 'role', 'placeholder', 'value', 'open', 'checked'];

((): void => {
  if (window.__replicataStateTapInstalled) return;
  window.__replicataStateTapInstalled = true;

  const source: 'real' | 'renderer' = (window as any).__replicataKnownTags !== undefined ? 'real' : 'renderer';
  const lastSigByTag = new Map<string, string>();

  function esc(s: string): string {
    return (window as any).CSS?.escape ? (window as any).CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  function findElementsForTag(tag: StateTag): Element[] {
    // Real app: resolve locator candidates (first non-empty wins)
    for (const sel of buildSelectors(tag.locator)) {
      try {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length > 0) return [...nodes];
      } catch {}
    }
    return [];
  }

  function buildSelectors(loc: StateTag['locator']): string[] {
    const s: string[] = [];
    if (loc.testId) s.push(`[data-testid="${esc(loc.testId)}"], [data-test="${esc(loc.testId)}"], [data-cy="${esc(loc.testId)}"]`);
    if (loc.ariaLabel) s.push(`[aria-label="${esc(loc.ariaLabel)}"]`);
    if (loc.classPath) s.push(loc.classPath);
    if (loc.nthChildPath) s.push(loc.nthChildPath);
    s.push(loc.cssPath);
    return s;
  }

  function findElementsByTagAttr(name: string): Element[] {
    return [...document.querySelectorAll(`[data-replicata-tag~="${esc(name)}"]`)];
  }

  function computeSignature(els: Element[]): StateSignature {
    if (els.length === 0) {
      return { text: '', attrs: {}, childTagsKey: '', visible: false, matchCount: 0 };
    }
    const el = els[0]; // MVP: signature of first matched element
    const attrs: Record<string, string> = {};
    for (const name of TRACKED_ATTRS) {
      const v = el.getAttribute(name);
      if (v !== null) attrs[name] = v;
    }
    const childTags = [...el.children].map((c) => c.tagName.toLowerCase()).sort();
    const style = window.getComputedStyle(el as HTMLElement);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
    return {
      text: (el.textContent || '').trim().slice(0, 200),
      attrs,
      childTagsKey: childTags.join(','),
      visible,
      matchCount: els.length,
    };
  }

  function sigKey(sig: StateSignature): string {
    return JSON.stringify(sig);
  }

  function tick(): void {
    const send = window.__replicataStateSnapshot;
    if (typeof send !== 'function') return;

    const tagNames: string[] = [];
    if (source === 'real') {
      for (const t of (window as any).__replicataKnownTags || []) tagNames.push(t.name);
    } else {
      const seen = new Set<string>();
      for (const el of document.querySelectorAll('[data-replicata-tag]')) {
        const v = el.getAttribute('data-replicata-tag');
        if (!v) continue;
        for (const n of v.split(/\s+/)) if (n) seen.add(n);
      }
      tagNames.push(...seen);
    }

    const now = Date.now();
    for (const name of tagNames) {
      const els = source === 'real'
        ? findElementsForTag((((window as any).__replicataKnownTags || []) as StateTag[]).find((t) => t.name === name)!)
        : findElementsByTagAttr(name);
      const sig = computeSignature(els);
      const key = sigKey(sig);
      if (lastSigByTag.get(name) === key) continue;
      lastSigByTag.set(name, key);
      try { send(name, source, { ts: now, sig }); } catch {}
    }
  }

  setInterval(tick, INTERVAL_MS);
  tick();
})();

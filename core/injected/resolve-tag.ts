// Installs window.__replicataResolveTag (by-value status/count) and the
// highlighter helpers. Resolver walks locator candidates in stability order
// and returns ALL matches for the first candidate that matches >=1 element.
// Tags naturally map to collections (message bubbles, list items).

interface TagLocator {
  testId?: string;
  ariaLabel?: string;
  role?: string;
  text?: string;
  classPath?: string;
  nthChildPath?: string;
  cssPath: string;
}

type ResolutionStatus = 'resolved' | 'stale';
type LocatorField = keyof TagLocator;

interface ResolutionResult {
  status: ResolutionStatus;
  matchedBy?: LocatorField;
  count: number;
  sample?: { text: string; tagName: string };
}

interface OverlayPair {
  el: HTMLDivElement;
  target: Element;
}

interface Window {
  __replicataResolveTag?: (locator: TagLocator) => ResolutionResult;
  __replicataHighlightMatches?: (locator: TagLocator) => number;
  __replicataHideHighlights?: () => void;
  __replicataKataInstalled?: boolean;
  __replicataOverlays?: OverlayPair[];
  __replicataOverlayRaf?: number;
}

((): void => {
  // Re-installing is idempotent (overwrites window.__replicata* functions).
  // Intentional: ensures new replicata versions replace any stale helpers left
  // in a tab from a prior replicata run.

  function buildCandidates(loc: TagLocator): Array<{ field: LocatorField; selector: string }> {
    const c: Array<{ field: LocatorField; selector: string }> = [];
    const esc = (window as any).CSS?.escape ?? ((s: string) => s.replace(/["\\]/g, '\\$&'));
    if (loc.testId) c.push({ field: 'testId', selector: `[data-testid="${esc(loc.testId)}"], [data-test="${esc(loc.testId)}"], [data-cy="${esc(loc.testId)}"]` });
    if (loc.ariaLabel) c.push({ field: 'ariaLabel', selector: `[aria-label="${esc(loc.ariaLabel)}"]` });
    if (loc.classPath) c.push({ field: 'classPath', selector: loc.classPath });
    if (loc.nthChildPath) c.push({ field: 'nthChildPath', selector: loc.nthChildPath });
    c.push({ field: 'cssPath', selector: loc.cssPath });
    return c;
  }

  function safeQueryAll(selector: string): Element[] | null {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      // Retry with class names escaped — legacy tags (pre-fix) stored raw
      // Tailwind classes w/ ':' '/' '[' ']' which break CSS parsing unless
      // escaped via CSS.escape.
      const esc = (window as any).CSS?.escape;
      if (typeof esc !== 'function') return null;
      // Pattern: '.<class>' where class is anything up to next selector separator
      const escaped = selector.replace(/\.([^\s>+~,\[\]]+)/g, (_m, cls) => '.' + esc(cls));
      try {
        return [...document.querySelectorAll(escaped)];
      } catch {
        return null;
      }
    }
  }

  function resolveAll(loc: TagLocator): { els: Element[]; matchedBy: LocatorField } | null {
    for (const c of buildCandidates(loc)) {
      const matches = safeQueryAll(c.selector);
      if (matches && matches.length > 0) {
        return { els: matches, matchedBy: c.field };
      }
    }
    return null;
  }

  window.__replicataResolveTag = function (locator: TagLocator): ResolutionResult {
    const hit = resolveAll(locator);
    if (!hit) return { status: 'stale', count: 0 };
    const first = hit.els[0];
    return {
      status: 'resolved',
      matchedBy: hit.matchedBy,
      count: hit.els.length,
      sample: {
        text: (first.textContent || '').trim().slice(0, 80),
        tagName: first.tagName.toLowerCase(),
      },
    };
  };

  function createOverlay(target: Element): HTMLDivElement {
    const el = document.createElement('div');
    const r = target.getBoundingClientRect();
    el.style.cssText = [
      'position:fixed',
      'border:2px solid #4ade80',
      'background:rgba(74,222,128,0.18)',
      'box-shadow:0 0 0 1px rgba(255,255,255,0.2)',
      'pointer-events:none',
      'z-index:2147483647',
      'box-sizing:border-box',
      'border-radius:2px',
      `left:${r.left}px`,
      `top:${r.top}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
    ].join(';');
    document.documentElement.appendChild(el);
    return el;
  }

  function updatePositions(): void {
    if (!window.__replicataOverlays) return;
    for (const o of window.__replicataOverlays) {
      if (!o.target.isConnected) {
        o.el.style.display = 'none';
        continue;
      }
      const r = o.target.getBoundingClientRect();
      o.el.style.display = '';
      o.el.style.left = r.left + 'px';
      o.el.style.top = r.top + 'px';
      o.el.style.width = r.width + 'px';
      o.el.style.height = r.height + 'px';
    }
    window.__replicataOverlayRaf = requestAnimationFrame(updatePositions);
  }

  function clearOverlays(): void {
    if (window.__replicataOverlayRaf != null) {
      cancelAnimationFrame(window.__replicataOverlayRaf);
      window.__replicataOverlayRaf = undefined;
    }
    if (window.__replicataOverlays) {
      for (const o of window.__replicataOverlays) o.el.remove();
      window.__replicataOverlays = [];
    }
  }

  window.__replicataHighlightMatches = function (locator: TagLocator): number {
    clearOverlays();
    const hit = resolveAll(locator);
    if (!hit) return 0;
    window.__replicataOverlays = hit.els.map((target) => ({ el: createOverlay(target), target }));
    window.__replicataOverlayRaf = requestAnimationFrame(updatePositions);
    return hit.els.length;
  };

  window.__replicataHideHighlights = function (): void {
    clearOverlays();
  };
})();

// Installed on the real app. Capture-phase event listeners at document level.
// For each event, checks whether the target (or an ancestor) is in the match
// set of any known tag; if so, forwards {tagName, eventType, detail} to Node
// via window.__replicataEvent. Runtime keeps the tag list in sync via
// window.__replicataSetTags.

interface KnownTag {
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

interface SerializableEvent {
  type: string;
  button?: number;
  clientX?: number;
  clientY?: number;
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  value?: string;
}

interface Window {
  __replicataKnownTags?: KnownTag[];
  __replicataSetTags?: (tags: KnownTag[]) => void;
  __replicataEvent?: (tagName: string, eventType: string, detail: SerializableEvent) => void;
  __replicataResolveTagToObject?: (locator: KnownTag['locator']) => Element | null;
}

const TAPPED_EVENTS = [
  'click', 'mousedown', 'mouseup',
  'focus', 'blur',
  'keydown', 'keyup',
  'input', 'change',
  'submit',
];

((): void => {
  // Cache of currently-matched elements per tag name. Re-computed on
  // __replicataSetTags (tag change) and on DOM mutation (debounced). Avoids
  // running ~40 querySelectorAlls per keystroke against a large DOM.
  const matchCache = new Map<string, Element[]>();

  function resolveTagMatches(tag: KnownTag): Element[] {
    for (const sel of buildSelectors(tag.locator)) {
      try {
        const nodes = document.querySelectorAll(sel);
        if (nodes.length > 0) return [...nodes];
      } catch {
        // invalid selector → try next candidate
      }
    }
    return [];
  }

  function recomputeCache(): void {
    matchCache.clear();
    for (const tag of window.__replicataKnownTags || []) {
      matchCache.set(tag.name, resolveTagMatches(tag));
    }
  }

  window.__replicataKnownTags = window.__replicataKnownTags || [];
  window.__replicataSetTags = function (tags: KnownTag[]): void {
    window.__replicataKnownTags = tags;
    recomputeCache();
  };

  // Re-cache on DOM mutations, debounced to avoid thrashing during streams.
  let mutationTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRecache(): void {
    if (mutationTimer) clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      recomputeCache();
    }, 500);
  }

  function installMutationObserver(): void {
    const root = document.body ?? document.documentElement;
    if (!root) {
      setTimeout(installMutationObserver, 20);
      return;
    }
    new MutationObserver(scheduleRecache).observe(root, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installMutationObserver, { once: true });
  } else {
    installMutationObserver();
  }

  function findMatchingTags(target: EventTarget | null): KnownTag[] {
    if (!(target instanceof Element)) return [];
    const matches: KnownTag[] = [];
    for (const tag of window.__replicataKnownTags || []) {
      const cached = matchCache.get(tag.name);
      if (!cached || cached.length === 0) continue;
      for (const el of cached) {
        if (el === target || el.contains(target)) {
          matches.push(tag);
          break;
        }
      }
    }
    return matches;
  }

  function buildSelectors(loc: KnownTag['locator']): string[] {
    const esc = (window as any).CSS?.escape ?? ((s: string) => s.replace(/["\\]/g, '\\$&'));
    const s: string[] = [];
    if (loc.testId) s.push(`[data-testid="${esc(loc.testId)}"], [data-test="${esc(loc.testId)}"], [data-cy="${esc(loc.testId)}"]`);
    if (loc.ariaLabel) s.push(`[aria-label="${esc(loc.ariaLabel)}"]`);
    if (loc.classPath) s.push(loc.classPath);
    if (loc.nthChildPath) s.push(loc.nthChildPath);
    s.push(loc.cssPath);
    return s;
  }

  function extractDetail(e: Event): SerializableEvent {
    const d: SerializableEvent = { type: e.type };
    if (e instanceof MouseEvent) {
      d.button = e.button;
      d.clientX = e.clientX;
      d.clientY = e.clientY;
      d.ctrlKey = e.ctrlKey;
      d.shiftKey = e.shiftKey;
      d.altKey = e.altKey;
      d.metaKey = e.metaKey;
    }
    if (e instanceof KeyboardEvent) {
      d.key = e.key;
      d.code = e.code;
      d.ctrlKey = e.ctrlKey;
      d.shiftKey = e.shiftKey;
      d.altKey = e.altKey;
      d.metaKey = e.metaKey;
    }
    const t = e.target as (HTMLInputElement & HTMLElement) | null;
    if (t) {
      if ('value' in t && typeof t.value === 'string') {
        d.value = t.value;
      } else if (t.isContentEditable) {
        // ProseMirror, Slate, plain contenteditable — textContent is the rough
        // equivalent of .value. Strips formatting but preserves typed text.
        d.value = t.textContent || '';
      }
    }
    return d;
  }

  function onEvent(e: Event): void {
    const forward = window.__replicataEvent;
    if (typeof forward !== 'function') return;
    const matched = findMatchingTags(e.target);
    if (matched.length === 0) return;
    const detail = extractDetail(e);
    for (const tag of matched) {
      try {
        forward(tag.name, e.type, detail);
      } catch {}
    }
  }

  for (const type of TAPPED_EVENTS) {
    document.addEventListener(type, onEvent, true);
  }
})();

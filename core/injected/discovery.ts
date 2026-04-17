// Discovery: surfaces untagged interactive elements in the real app.
//
// Sources:
//   1. React DevTools hook — installs __REACT_DEVTOOLS_GLOBAL_HOOK__ before
//      React loads; subscribes to onCommitFiberRoot so every re-render hands
//      us the root. We walk the tree and harvest fibers w/ on*-prop handlers.
//   2. DOM-side fiber walk — for the already-loaded page, read the
//      __reactFiber$... property on each DOM node and walk `.return` up to
//      find memoizedProps w/ handlers. Covers the case where React already
//      registered with a stub hook before ours installed.
//   3. MutationObserver — batched @ 200ms idle. Reports added/removed/
//      attribute-changed nodes. Enriches w/ handler info via fiber lookup.
//
// Soft signals (for non-React / for React elements w/o handlers but still
// visibly interactive): cursor:pointer, [role=button|link|menuitem|tab],
// native interactives (button/a/input/select/textarea).
//
// Sends candidates to Node via window.__replicataDiscover(event). One call per
// batched flush, not one per element.

interface CandidateInfo {
  cssPath: string;
  tagName: string;
  text: string;
  attrs: Record<string, string>;
  testId?: string;
  ariaLabel?: string;
  role?: string;
  classPath: string;
  nthChildPath: string;
}

type Source = 'react-commit' | 'initial-scan' | 'mutation';

interface CandidateEvent {
  key: string;
  info: CandidateInfo;
  handlerKinds: string[];   // e.g. ['onClick', 'onKeyDown']
  signals: string[];         // e.g. ['cursor-pointer', 'role-button']
  source: Source;
  presence: 'present' | 'removed';
}

interface DiscoverWindow extends Window {
  __replicataDiscover?: (events: CandidateEvent[]) => void;
  __replicataDiscoveryInstalled?: boolean;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: any;
}

((): void => {
  const win = window as unknown as DiscoverWindow;
  if (win.__replicataDiscoveryInstalled) return;
  win.__replicataDiscoveryInstalled = true;

  // ---- Hook (must happen synchronously, before React checks for it) ----
  installReactHook();

  // ---- Element info extraction ----
  function esc(c: string): string {
    return (window as any).CSS?.escape ? (window as any).CSS.escape(c) : c;
  }

  function pathTo(el: Element, kind: 'class' | 'nth' | 'both'): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
      if (kind !== 'nth') {
        const cls = [...node.classList].filter((c) => !c.match(/^(hover|active|focus|is-)/)).slice(0, kind === 'class' ? 3 : 2);
        if (cls.length) part += '.' + cls.map(esc).join('.');
      }
      if (kind !== 'class') {
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName)
          : [node];
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function extract(el: Element): CandidateInfo {
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    return {
      tagName: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().slice(0, 80),
      attrs,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      role: el.getAttribute('role') || undefined,
      classPath: pathTo(el, 'class'),
      nthChildPath: pathTo(el, 'nth'),
      cssPath: pathTo(el, 'both'),
    };
  }

  // ---- Signal detection ----
  const ROLE_INTERACTIVE = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);
  const NATIVE_INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);

  function softSignals(el: Element): string[] {
    const out: string[] = [];
    try {
      const style = (window as any).getComputedStyle?.(el);
      if (style && style.cursor === 'pointer') out.push('cursor-pointer');
    } catch {}
    const role = el.getAttribute('role');
    if (role && ROLE_INTERACTIVE.has(role)) out.push('role-' + role);
    if (NATIVE_INTERACTIVE.has(el.tagName)) out.push('native-' + el.tagName.toLowerCase());
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') out.push('tabindex');
    return out;
  }

  function fiberFor(el: Element): any {
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        return (el as any)[k];
      }
    }
    return null;
  }

  function handlerKindsForElement(el: Element): string[] {
    const fiber = fiberFor(el);
    if (!fiber) return [];
    let cur: any = fiber;
    let depth = 0;
    while (cur && depth < 8) {
      const props = cur.memoizedProps || cur.pendingProps;
      if (props) {
        const kinds: string[] = [];
        for (const k of Object.keys(props)) {
          if (/^on[A-Z]/.test(k) && typeof props[k] === 'function') kinds.push(k);
        }
        if (kinds.length > 0) return kinds;
      }
      cur = cur.return;
      depth++;
    }
    return [];
  }

  // ---- React hook ----
  function installReactHook(): void {
    if (win.__REACT_DEVTOOLS_GLOBAL_HOOK__ && typeof win.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot === 'function') {
      // Someone else (real RDT?) is already hooked — wrap their onCommitFiberRoot.
      const prev = win.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot;
      win.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = function (id: number, root: any, pri: number) {
        try { handleCommit(root); } catch {}
        return prev.call(this, id, root, pri);
      };
      return;
    }
    const renderers = new Map<number, any>();
    let nextId = 1;
    win.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers,
      inject(renderer: any) {
        const id = nextId++;
        renderers.set(id, renderer);
        return id;
      },
      onScheduleFiberRoot() {},
      onCommitFiberRoot(_id: number, root: any) {
        try { handleCommit(root); } catch {}
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  }

  // Queue of elements to process from fiber commits, debounced w/ the
  // same idle timer as MutationObserver so we flush once per batch.
  const pendingFiberNodes = new Set<Element>();

  function handleCommit(root: any): void {
    // Cheap: just remember the root; the next flush will walk it fresh.
    // Walking here on every commit = expensive; walk on flush.
    walkFiberCollecting(root.current, pendingFiberNodes, 0);
    scheduleFlush();
  }

  function walkFiberCollecting(fiber: any, out: Set<Element>, depth: number): void {
    if (!fiber || depth > 1000) return;
    const node = fiber.stateNode;
    if (node && node.nodeType === 1) {
      const props = fiber.memoizedProps;
      if (props) {
        for (const k of Object.keys(props)) {
          if (/^on[A-Z]/.test(k) && typeof props[k] === 'function') {
            out.add(node);
            break;
          }
        }
      }
    }
    walkFiberCollecting(fiber.child, out, depth + 1);
    walkFiberCollecting(fiber.sibling, out, depth + 1);
  }

  // ---- Mutation observer + initial scan ----
  const pendingMutated = new Set<Element>();
  const pendingRemoved = new Set<Element>();

  function scheduleMutationObserver(): void {
    const target = document.body || document.documentElement;
    if (!target) { setTimeout(scheduleMutationObserver, 20); return; }
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          r.addedNodes.forEach((n) => { if (n.nodeType === 1) pendingMutated.add(n as Element); });
          r.removedNodes.forEach((n) => { if (n.nodeType === 1) pendingRemoved.add(n as Element); });
        } else if (r.type === 'attributes' && r.target.nodeType === 1) {
          pendingMutated.add(r.target as Element);
        }
      }
      scheduleFlush();
    });
    obs.observe(target, { childList: true, subtree: true, attributes: true });

    initialScan();
  }

  function initialScan(): void {
    const all = document.querySelectorAll('*');
    for (const el of all) pendingMutated.add(el);
    scheduleFlush('initial-scan');
  }

  // ---- Batched flush ----
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSource: Source = 'mutation';

  function scheduleFlush(source: Source = 'mutation'): void {
    if (source === 'initial-scan') pendingSource = 'initial-scan';
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 200);
  }

  function flush(): void {
    flushTimer = null;
    const reportFn = (window as any).__replicataDiscover;
    if (typeof reportFn !== 'function') return;

    const events: CandidateEvent[] = [];
    const source = pendingSource;
    pendingSource = 'mutation';

    const presentSet = new Set<Element>([...pendingMutated, ...pendingFiberNodes]);
    pendingMutated.clear();
    pendingFiberNodes.clear();

    for (const el of presentSet) {
      if (!el.isConnected) continue;  // removed before flush; handled in removed set
      const handlerKinds = handlerKindsForElement(el);
      const signals = softSignals(el);
      if (handlerKinds.length === 0 && signals.length === 0) continue;
      try {
        const info = extract(el);
        if (!info.cssPath) continue;
        events.push({
          key: info.cssPath,
          info,
          handlerKinds,
          signals,
          source: pendingFiberNodes.has(el) ? 'react-commit' : source,
          presence: 'present',
        });
      } catch {}
    }

    for (const el of pendingRemoved) {
      try {
        const info = extract(el);
        if (!info.cssPath) continue;
        events.push({
          key: info.cssPath,
          info,
          handlerKinds: [],
          signals: [],
          source: 'mutation',
          presence: 'removed',
        });
      } catch {}
    }
    pendingRemoved.clear();

    if (events.length > 0) {
      try { reportFn(events); } catch {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleMutationObserver, { once: true });
  } else {
    scheduleMutationObserver();
  }
})();

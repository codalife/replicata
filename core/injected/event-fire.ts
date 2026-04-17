// Installed on the renderer. Two responsibilities:
//   1. window.__replicataFireEvent(tagName, type, detail) — Node calls this when
//      the real app fires a matching event. Finds all [data-replicata-tag="X"]
//      elements and dispatches a synthetic DOM event on each. Synthetic
//      events have event.isTrusted === false — a limitation, not a bug.
//   2. reports the set of data-replicata-tag attribute values to Node via
//      window.__replicataReportPairs so the kata UI can show pair status.
//      MutationObserver keeps the report live as user adds/removes attrs.

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
  __replicataFireEvent?: (tagName: string, type: string, detail: SerializableEvent) => number;
  __replicataReportPairs?: (names: string[]) => void;
  __replicataRendererInstalled?: boolean;
}

((): void => {
  // Fire synthetic events on tagged elements
  window.__replicataFireEvent = function (tagName: string, type: string, detail: SerializableEvent): number {
    const esc = (window as any).CSS?.escape ?? ((s: string) => s.replace(/["\\]/g, '\\$&'));
    const nodes = document.querySelectorAll<HTMLElement>(`[data-replicata-tag="${esc(tagName)}"]`);
    let fired = 0;
    for (const node of nodes) {
      try {
        dispatch(node, type, detail);
        fired++;
      } catch {}
    }
    return fired;
  };

  function dispatch(target: HTMLElement, type: string, detail: SerializableEvent): void {
    let event: Event;
    if (type === 'click' || type === 'mousedown' || type === 'mouseup') {
      event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: detail.button ?? 0,
        clientX: detail.clientX ?? 0,
        clientY: detail.clientY ?? 0,
        ctrlKey: !!detail.ctrlKey,
        shiftKey: !!detail.shiftKey,
        altKey: !!detail.altKey,
        metaKey: !!detail.metaKey,
      });
    } else if (type === 'keydown' || type === 'keyup') {
      event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: detail.key ?? '',
        code: detail.code ?? '',
        ctrlKey: !!detail.ctrlKey,
        shiftKey: !!detail.shiftKey,
        altKey: !!detail.altKey,
        metaKey: !!detail.metaKey,
      });
    } else if (type === 'input' || type === 'change') {
      if (detail.value !== undefined) setNativeValue(target, detail.value);
      event = new Event(type, { bubbles: true, cancelable: true });
    } else {
      event = new Event(type, { bubbles: true, cancelable: true });
    }
    target.dispatchEvent(event);
  }

  // Bypass React's value tracker by calling the prototype's native setter
  // directly. Plain `el.value = x` updates the DOM but not React's cached
  // valueTracker, so onChange skips. Native setter writes through both.
  function setNativeValue(el: HTMLElement, value: string): void {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) { setter.call(el, value); return; }
      (el as HTMLInputElement).value = value;
      return;
    }
    if (el instanceof HTMLSelectElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) { setter.call(el, value); return; }
      (el as HTMLSelectElement).value = value;
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      el.textContent = value;
    }
  }

  // Pair reporting — scan for [data-replicata-tag] values, debounced on mutations
  function scanPairs(): string[] {
    const nodes = document.querySelectorAll<HTMLElement>('[data-replicata-tag]');
    const names = new Set<string>();
    for (const n of nodes) {
      const v = n.getAttribute('data-replicata-tag');
      if (v) names.add(v);
    }
    return [...names];
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  function reportDebounced(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const fn = window.__replicataReportPairs;
      if (typeof fn === 'function') fn(scanPairs());
    }, 300);
  }

  function installObserver(): void {
    const target = document.body ?? document.documentElement;
    if (!target) {
      setTimeout(installObserver, 20);
      return;
    }
    const observer = new MutationObserver(reportDebounced);
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-replicata-tag'] });
    reportDebounced();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installObserver, { once: true });
  } else {
    installObserver();
  }
})();

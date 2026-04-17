// Watches the real app DOM for changes. Debounced — calls Node's
// __replicataDomChanged once mutations have been idle for ~750ms. Node's handler
// triggers a throttled re-verify of persisted tags so elements that render
// late (conversation history, streamed messages, virtualized lists) flip
// from ⚠ to ✓ once they actually land in the DOM.

interface Window {
  __replicataDomWatchInstalled?: boolean;
  __replicataDomChanged?: () => void;
}

((): void => {
  if (window.__replicataDomWatchInstalled) return;
  window.__replicataDomWatchInstalled = true;

  const DEBOUNCE_MS = 750;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function onIdle(): void {
    timer = null;
    const fn = window.__replicataDomChanged;
    if (typeof fn === 'function') fn();
  }

  function onMutations(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onIdle, DEBOUNCE_MS);
  }

  function install(): void {
    const target = document.body ?? document.documentElement;
    if (!target) {
      setTimeout(install, 20);
      return;
    }
    const observer = new MutationObserver(onMutations);
    observer.observe(target, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();

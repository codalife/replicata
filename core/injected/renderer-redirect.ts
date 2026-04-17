// Injected into the renderer page. Rewrites fetches that match any exposed
// replicata endpoint (by method + normalized path) to point at replicata's local
// per-endpoint replay route. Renderer code is unmodified — it calls
// fetch('/api/chat') and gets real bytes back.
//
// Invoked via:  <this file source> + '(' + JSON.stringify({host, port, routes}) + ')'
// `routes` is the live list of exposed endpoints; updated in-place by
// __replicataUpdateRoutes(newRoutes) (backend pushes when catalog changes).

interface ReplicataRoute { id: string; method: string; normalizedPath: string; }

((args: { host: string; port: number; routes: ReplicataRoute[] }) => {
  const { host, port } = args;
  if ((window as any).__replicataRedirectInstalled) {
    (window as any).__replicataUpdateRoutes?.(args.routes);
    return;
  }
  (window as any).__replicataRedirectInstalled = true;

  let routes: ReplicataRoute[] = args.routes ?? [];
  (window as any).__replicataUpdateRoutes = (next: ReplicataRoute[]) => { routes = next ?? []; };


  // Per-segment matcher: exact for static segments, wildcard for `:id` / `:uuid` / `:hex`.
  function pathMatches(actualPath: string, normalizedPath: string): boolean {
    const aSegs = actualPath.split('/');
    const nSegs = normalizedPath.split('/');
    if (aSegs.length !== nSegs.length) return false;
    for (let i = 0; i < nSegs.length; i++) {
      const n = nSegs[i];
      if (n.startsWith(':')) continue; // placeholder accepts anything
      if (n !== aSegs[i]) return false;
    }
    return true;
  }

  function matchRoute(method: string, pathname: string): ReplicataRoute | null {
    const m = method.toUpperCase();
    for (const r of routes) {
      if (r.method.toUpperCase() === m && pathMatches(pathname, r.normalizedPath)) return r;
    }
    return null;
  }

  const originalFetch = window.fetch;

  window.fetch = async function (...fetchArgs: Parameters<typeof fetch>): Promise<Response> {
    const input = fetchArgs[0];
    const init = fetchArgs[1];

    // Extract URL without reconstructing Request (which would consume body).
    let url: URL;
    try {
      if (typeof input === 'string') {
        url = new URL(input, window.location.origin);
      } else if (input instanceof URL) {
        url = input;
      } else if (input && typeof input === 'object' && 'url' in input) {
        url = new URL((input as Request).url, window.location.origin);
      } else {
        return originalFetch.apply(this, fetchArgs);
      }
    } catch {
      return originalFetch.apply(this, fetchArgs);
    }

    let method = 'GET';
    let headers: HeadersInit | undefined;
    let body: BodyInit | undefined;

    if (input instanceof Request) {
      method = init?.method ?? input.method;
      headers = init?.headers ?? input.headers;
      if (method !== 'GET' && method !== 'HEAD') {
        body = (init && 'body' in init && init.body !== undefined)
          ? init.body as BodyInit
          : await input.clone().text();
      }
    } else {
      method = init?.method ?? 'GET';
      headers = init?.headers;
      if (method !== 'GET' && method !== 'HEAD') body = init?.body ?? undefined;
    }

    const route = matchRoute(method, url.pathname);
    if (!route) return originalFetch.apply(this, fetchArgs);

    const replicataUrl = 'http://' + host + ':' + port + '/stream/' + route.id;
    const replicataRequest = new Request(replicataUrl, { method, headers, body });
    return originalFetch.call(this, replicataRequest);
  };
})

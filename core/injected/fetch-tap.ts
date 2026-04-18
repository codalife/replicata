// Injected into the real-app page. Wraps window.fetch to passively observe
// streaming responses from a target domain. Tees the ReadableStream so the
// real consumer (the app's own JS) gets its bytes untouched, while a copy
// flows to kata via the __replicataChunk binding.
//
// Invoked via:  <this file source> + '(' + JSON.stringify({domain}) + ')'
// Idempotent — safe to inject twice.

interface Window {
  __replicataWrapped?: boolean;
  __replicataStreamStart(streamId: string, url: string, method: string, status: number, contentType: string): void;
  __replicataChunk(streamId: string, data: string): void;
  __replicataStreamEnd(streamId: string): void;
  __replicataRequest(url: string, method: string, status: number, contentType: string, bytes: number): void;
  __replicataResponseBody(endpointHint: string, body: string): void;
}

((args: { domain: string }) => {
  if (window.__replicataWrapped) return;
  window.__replicataWrapped = true;

  const targetDomain = args.domain;
  const originalFetch = window.fetch;
  let streamCounter = 0;

  window.fetch = async function (...fetchArgs: Parameters<typeof fetch>): Promise<Response> {
    const response = await originalFetch.apply(this, fetchArgs);

    const input = fetchArgs[0];
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;

    let url: string;
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      // Skip third-party analytics/tracking domains. Tap everything else —
      // the user chose this tab, we observe all its API traffic.
      const h = parsed.hostname;
      if (h.includes('google-analytics') || h.includes('googletagmanager') || h.includes('doubleclick') || h.includes('facebook.com') || h.includes('sentry.io')) return response;
      url = parsed.href;
    } catch {
      return response;
    }

    const init = fetchArgs[1];
    const method =
      init?.method ??
      (input instanceof Request ? input.method : 'GET');

    const contentType = response.headers.get('content-type') || '';
    const isStream =
      contentType.includes('text/event-stream') ||
      contentType.includes('application/x-ndjson');

    // Catalog the request immediately — once per fetch, regardless of what
    // happens during body drain. Bytes from Content-Length when available
    // (it's an estimate; chunked or compressed responses may differ).
    const bytesHint = Number(response.headers.get('content-length') || 0) || 0;
    try { window.__replicataRequest(url, method, response.status, contentType, bytesHint); } catch {}

    // Stream: tee and forward chunks for buffering.
    if (isStream && response.body) {
      const streamId = 'stream_' + ++streamCounter + '_' + Date.now();
      window.__replicataStreamStart(streamId, url, method, response.status, contentType);

      const [forApp, forReplicata] = response.body.tee();

      (async () => {
        const reader = forReplicata.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            window.__replicataChunk(streamId, decoder.decode(value, { stream: true }));
          }
        } catch {}
        window.__replicataStreamEnd(streamId);
      })();

      return new Response(forApp, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Non-stream: tee the body so we can cache it for replay, while
    // returning an intact body leg to the app. Already cataloged above —
    // here we just hydrate the body cache best-effort. If the consumer
    // cancels the stream early, the catalog entry still exists.
    if (!response.body) return response;

    const [forApp, forReplicata] = response.body.tee();
    (async () => {
      const reader = forReplicata.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          chunks.push(text);
          bytes += text.length;
        }
      } catch {}
      const body = chunks.join('');
      if (body.length > 0 && body.length <= 512 * 1024) {
        window.__replicataResponseBody(url + '|' + method, body);
      }
    })();

    return new Response(forApp, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // --- XHR tap ---
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  XHR.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    (this as any).__replicataMethod = method;
    (this as any).__replicataUrl = url;
    return origOpen.apply(this, [method, url, ...rest] as any);
  };

  XHR.send = function (this: XMLHttpRequest, ...sendArgs: any[]) {
    const method = (this as any).__replicataMethod || 'GET';
    const rawUrl = (this as any).__replicataUrl || '';

    let url: string;
    try {
      const parsed = new URL(String(rawUrl), window.location.origin);
      const h = parsed.hostname;
      if (h.includes('google-analytics') || h.includes('googletagmanager') || h.includes('doubleclick') || h.includes('facebook.com') || h.includes('sentry.io')) {
        return origSend.apply(this, sendArgs as any);
      }
      url = parsed.href;
    } catch {
      return origSend.apply(this, sendArgs as any);
    }

    this.addEventListener('load', function () {
      const contentType = this.getResponseHeader('content-type') || '';
      const bytes = Number(this.getResponseHeader('content-length') || 0) || (this.responseText?.length ?? 0);
      try { window.__replicataRequest(url, method, this.status, contentType, bytes); } catch {}

      const isStream = contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson');

      if (isStream && this.responseText) {
        const streamId = 'stream_' + ++streamCounter + '_' + Date.now();
        window.__replicataStreamStart(streamId, url, method, this.status, contentType);
        window.__replicataChunk(streamId, this.responseText);
        window.__replicataStreamEnd(streamId);
      } else if (this.responseText && this.responseText.length > 0 && this.responseText.length <= 512 * 1024) {
        window.__replicataResponseBody(url + '|' + method, this.responseText);
      }
    });

    return origSend.apply(this, sendArgs as any);
  };
})

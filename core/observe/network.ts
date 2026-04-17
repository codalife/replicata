import type { Page } from 'playwright-core';
import { invokeInjected } from '../injected/index.js';
import { installInitScript } from '../bridge/init-scripts.js';

export interface StreamChunk {
  streamId: string;
  data: string;
  timestamp: number;
}

export interface StreamMeta {
  streamId: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  startTime: number;
  chunks: StreamChunk[];
  done: boolean;
}

type StreamStartCb = (meta: StreamMeta) => void;
type ChunkCb = (chunk: StreamChunk, meta: StreamMeta) => void;
type StreamEndCb = (meta: StreamMeta) => void;
type RequestCb = (req: { url: string; method: string; status: number; contentType: string; bytes: number }) => void;
type ResponseBodyCb = (hint: string, body: string) => void;

export class NetworkTap {
  private page: Page;
  private streams = new Map<string, StreamMeta>();
  private onStreamStart?: StreamStartCb;
  private onChunk?: ChunkCb;
  private onStreamEnd?: StreamEndCb;
  private onRequest?: RequestCb;
  private onResponseBody?: ResponseBodyCb;
  private targetDomain: string;

  constructor(page: Page, targetDomain: string) {
    this.page = page;
    this.targetDomain = targetDomain;
  }

  on(event: 'stream-start', cb: StreamStartCb): this;
  on(event: 'chunk', cb: ChunkCb): this;
  on(event: 'stream-end', cb: StreamEndCb): this;
  on(event: 'request', cb: RequestCb): this;
  on(event: 'response-body', cb: ResponseBodyCb): this;
  on(event: string, cb: (...args: any[]) => void): this {
    if (event === 'stream-start') this.onStreamStart = cb as StreamStartCb;
    if (event === 'chunk') this.onChunk = cb as ChunkCb;
    if (event === 'stream-end') this.onStreamEnd = cb as StreamEndCb;
    if (event === 'request') this.onRequest = cb as RequestCb;
    if (event === 'response-body') this.onResponseBody = cb as ResponseBodyCb;
    return this;
  }

  async start(): Promise<void> {
    await this.page.exposeFunction('__replicataStreamStart', (streamId: string, url: string, method: string, status: number, contentType: string) => {
      const meta: StreamMeta = {
        streamId, url, method, status, contentType,
        startTime: Date.now(),
        chunks: [],
        done: false,
      };
      this.streams.set(streamId, meta);
      this.onStreamStart?.(meta);
    });

    await this.page.exposeFunction('__replicataChunk', (streamId: string, data: string) => {
      const meta = this.streams.get(streamId);
      if (!meta) return;
      const chunk: StreamChunk = { streamId, data, timestamp: Date.now() - meta.startTime };
      meta.chunks.push(chunk);
      this.onChunk?.(chunk, meta);
    });

    await this.page.exposeFunction('__replicataStreamEnd', (streamId: string) => {
      const meta = this.streams.get(streamId);
      if (!meta) return;
      meta.done = true;
      this.onStreamEnd?.(meta);
    });

    await this.page.exposeFunction('__replicataRequest', (url: string, method: string, status: number, contentType: string, bytes: number) => {
      this.onRequest?.({ url, method, status, contentType, bytes });
    });

    await this.page.exposeFunction('__replicataResponseBody', (hint: string, body: string) => {
      this.onResponseBody?.(hint, body);
    });

    const invocation = invokeInjected('fetch-tap', { domain: this.targetDomain });
    await installInitScript(this.page, invocation);
  }

  getLatestStream(): StreamMeta | undefined {
    let latest: StreamMeta | undefined;
    for (const [, meta] of this.streams) {
      if (!latest || meta.startTime > latest.startTime) latest = meta;
    }
    return latest;
  }
}

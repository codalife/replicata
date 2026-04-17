import type { StreamChunk, StreamMeta } from '../observe/network.js';

export interface BufferedStream {
  meta: StreamMeta;
  chunks: Array<{ data: string; msOffset: number }>;
}

export class StreamBuffer {
  private streams: BufferedStream[] = [];
  private liveListeners = new Set<(chunk: StreamChunk) => void>();
  private doneListeners = new Set<(streamId: string) => void>();

  addStream(meta: StreamMeta): void {
    this.streams.push({
      meta,
      chunks: [],
    });
  }

  addChunk(chunk: StreamChunk): void {
    const stream = this.streams.find(s => s.meta.streamId === chunk.streamId);
    if (stream) {
      stream.chunks.push({ data: chunk.data, msOffset: chunk.timestamp });
    }
    for (const cb of this.liveListeners) cb(chunk);
  }

  markDone(streamId: string): void {
    const stream = this.streams.find(s => s.meta.streamId === streamId);
    if (stream) {
      stream.meta.done = true;
      for (const cb of this.doneListeners) cb(streamId);
    }
  }

  getLatest(): BufferedStream | undefined {
    return this.streams[this.streams.length - 1];
  }

  getActive(): BufferedStream | undefined {
    for (let i = this.streams.length - 1; i >= 0; i--) {
      if (!this.streams[i].meta.done) return this.streams[i];
    }
    return undefined;
  }

  onLiveChunk(cb: (chunk: StreamChunk) => void): () => void {
    this.liveListeners.add(cb);
    return () => this.liveListeners.delete(cb);
  }

  onStreamDone(cb: (streamId: string) => void): () => void {
    this.doneListeners.add(cb);
    return () => this.doneListeners.delete(cb);
  }

  clear(): void {
    this.streams = [];
  }

  list(): BufferedStream[] {
    return this.streams;
  }

  getById(streamId: string): BufferedStream | undefined {
    return this.streams.find((s) => s.meta.streamId === streamId);
  }

  remove(streamId: string): boolean {
    const i = this.streams.findIndex((s) => s.meta.streamId === streamId);
    if (i < 0) return false;
    this.streams.splice(i, 1);
    return true;
  }

  get count(): number {
    return this.streams.length;
  }

  get totalChunks(): number {
    return this.streams.reduce((sum, s) => sum + s.chunks.length, 0);
  }

  get totalBytes(): number {
    return this.streams.reduce(
      (sum, s) => sum + s.chunks.reduce((cs, c) => cs + c.data.length, 0),
      0,
    );
  }

}

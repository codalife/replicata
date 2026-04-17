import { describe, it, expect, vi } from 'vitest';
import { StreamBuffer } from '../core/bridge/stream-buffer.js';
import type { StreamMeta } from '../core/observe/network.js';

function makeMeta(id: string, url = 'https://example.com/api', done = false): StreamMeta {
  return { streamId: id, url, method: 'POST', status: 200, contentType: 'text/event-stream', startTime: Date.now(), chunks: [], done };
}

describe('StreamBuffer', () => {
  it('addStream + getLatest', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addStream(makeMeta('s2'));
    expect(buf.getLatest()?.meta.streamId).toBe('s2');
  });

  it('addChunk appends to correct stream', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addStream(makeMeta('s2'));
    buf.addChunk({ streamId: 's1', data: 'hello', timestamp: 0 });
    buf.addChunk({ streamId: 's2', data: 'world', timestamp: 10 });
    expect(buf.getById('s1')!.chunks).toHaveLength(1);
    expect(buf.getById('s2')!.chunks[0].data).toBe('world');
  });

  it('addChunk ignores unknown streamId', () => {
    const buf = new StreamBuffer();
    buf.addChunk({ streamId: 'nope', data: 'x', timestamp: 0 });
    expect(buf.count).toBe(0);
  });

  it('markDone sets done flag', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    expect(buf.getById('s1')!.meta.done).toBe(false);
    buf.markDone('s1');
    expect(buf.getById('s1')!.meta.done).toBe(true);
  });

  it('getActive returns latest non-done stream', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addStream(makeMeta('s2'));
    buf.markDone('s2');
    expect(buf.getActive()?.meta.streamId).toBe('s1');
  });

  it('getActive returns undefined when all done', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.markDone('s1');
    expect(buf.getActive()).toBeUndefined();
  });

  it('onLiveChunk fires on addChunk', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    const cb = vi.fn();
    buf.onLiveChunk(cb);
    buf.addChunk({ streamId: 's1', data: 'x', timestamp: 0 });
    expect(cb).toHaveBeenCalledOnce();
  });

  it('onLiveChunk unsubscribe works', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    const cb = vi.fn();
    const unsub = buf.onLiveChunk(cb);
    unsub();
    buf.addChunk({ streamId: 's1', data: 'x', timestamp: 0 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('onStreamDone fires on markDone', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    const cb = vi.fn();
    buf.onStreamDone(cb);
    buf.markDone('s1');
    expect(cb).toHaveBeenCalledWith('s1');
  });

  it('onStreamDone does not fire for unknown id', () => {
    const buf = new StreamBuffer();
    const cb = vi.fn();
    buf.onStreamDone(cb);
    buf.markDone('nope');
    expect(cb).not.toHaveBeenCalled();
  });

  it('remove deletes a stream', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addStream(makeMeta('s2'));
    expect(buf.remove('s1')).toBe(true);
    expect(buf.count).toBe(1);
    expect(buf.getById('s1')).toBeUndefined();
  });

  it('remove returns false for unknown id', () => {
    const buf = new StreamBuffer();
    expect(buf.remove('nope')).toBe(false);
  });

  it('clear empties everything', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addChunk({ streamId: 's1', data: 'x', timestamp: 0 });
    buf.clear();
    expect(buf.count).toBe(0);
    expect(buf.totalChunks).toBe(0);
    expect(buf.totalBytes).toBe(0);
  });

  it('totalChunks and totalBytes aggregate correctly', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addChunk({ streamId: 's1', data: 'abc', timestamp: 0 });
    buf.addChunk({ streamId: 's1', data: 'de', timestamp: 10 });
    expect(buf.totalChunks).toBe(2);
    expect(buf.totalBytes).toBe(5);
  });

  it('preserves chunk timing', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addChunk({ streamId: 's1', data: 'a', timestamp: 0 });
    buf.addChunk({ streamId: 's1', data: 'b', timestamp: 42 });
    buf.addChunk({ streamId: 's1', data: 'c', timestamp: 87 });
    const chunks = buf.getById('s1')!.chunks;
    expect(chunks.map(c => c.msOffset)).toEqual([0, 42, 87]);
  });

  it('getLatest returns undefined on empty buffer', () => {
    const buf = new StreamBuffer();
    expect(buf.getLatest()).toBeUndefined();
  });

  it('list returns all streams in order', () => {
    const buf = new StreamBuffer();
    buf.addStream(makeMeta('s1'));
    buf.addStream(makeMeta('s2'));
    buf.addStream(makeMeta('s3'));
    expect(buf.list().map(s => s.meta.streamId)).toEqual(['s1', 's2', 's3']);
  });
});

import { describe, it, expect } from 'vitest';
import { normalizePath, endpointIdFor, pathMatchesPattern, inferKind } from '../core/observe/endpoints.js';

describe('normalizePath', () => {
  it('replaces numeric segments with :id', () => {
    expect(normalizePath('/api/users/42')).toBe('/api/users/:id');
    expect(normalizePath('/v1/chat/123/messages/456')).toBe('/v1/chat/:id/messages/:id');
  });

  it('replaces UUIDs with :uuid', () => {
    expect(normalizePath('/api/conv/550e8400-e29b-41d4-a716-446655440000')).toBe('/api/conv/:uuid');
  });

  it('replaces UUIDs without dashes', () => {
    expect(normalizePath('/api/conv/550e8400e29b41d4a716446655440000')).toBe('/api/conv/:uuid');
  });

  it('replaces long hex strings with :hex', () => {
    expect(normalizePath('/api/obj/abcdef0123456789abcdef')).toBe('/api/obj/:hex');
  });

  it('does not replace short hex strings', () => {
    expect(normalizePath('/api/obj/abcdef')).toBe('/api/obj/abcdef');
  });

  it('preserves static segments', () => {
    expect(normalizePath('/backend-api/conversation')).toBe('/backend-api/conversation');
  });

  it('handles leading/trailing slashes', () => {
    expect(normalizePath('/api/')).toBe('/api/');
    expect(normalizePath('/')).toBe('/');
  });

  it('handles mixed segments', () => {
    expect(normalizePath('/api/users/42/posts/550e8400-e29b-41d4-a716-446655440000')).toBe('/api/users/:id/posts/:uuid');
  });
});

describe('endpointIdFor', () => {
  it('returns deterministic id for same input', () => {
    const a = endpointIdFor('POST', '/api/chat');
    const b = endpointIdFor('POST', '/api/chat');
    expect(a).toBe(b);
  });

  it('differs by method', () => {
    expect(endpointIdFor('GET', '/api/chat')).not.toBe(endpointIdFor('POST', '/api/chat'));
  });

  it('differs by path', () => {
    expect(endpointIdFor('POST', '/api/chat')).not.toBe(endpointIdFor('POST', '/api/users'));
  });

  it('starts with ep_', () => {
    expect(endpointIdFor('GET', '/api')).toMatch(/^ep_/);
  });

  it('is case-insensitive on method', () => {
    expect(endpointIdFor('post', '/api/chat')).toBe(endpointIdFor('POST', '/api/chat'));
  });
});

describe('pathMatchesPattern', () => {
  it('matches exact static paths', () => {
    expect(pathMatchesPattern('/api/chat', '/api/chat')).toBe(true);
  });

  it('rejects different static paths', () => {
    expect(pathMatchesPattern('/api/chat', '/api/users')).toBe(false);
  });

  it('matches placeholders against any value', () => {
    expect(pathMatchesPattern('/api/users/42', '/api/users/:id')).toBe(true);
    expect(pathMatchesPattern('/api/users/abc', '/api/users/:id')).toBe(true);
  });

  it('rejects different segment counts', () => {
    expect(pathMatchesPattern('/api/users', '/api/users/:id')).toBe(false);
    expect(pathMatchesPattern('/api/users/42/posts', '/api/users/:id')).toBe(false);
  });

  it('matches multiple placeholders', () => {
    expect(pathMatchesPattern('/api/users/42/posts/99', '/api/users/:id/posts/:id')).toBe(true);
  });
});

describe('inferKind', () => {
  it('detects SSE streams', () => {
    expect(inferKind('text/event-stream')).toBe('stream');
    expect(inferKind('text/event-stream; charset=utf-8')).toBe('stream');
  });

  it('detects NDJSON streams', () => {
    expect(inferKind('application/x-ndjson')).toBe('stream');
    expect(inferKind('application/ndjson')).toBe('stream');
  });

  it('detects JSON', () => {
    expect(inferKind('application/json')).toBe('json');
    expect(inferKind('application/json; charset=utf-8')).toBe('json');
  });

  it('returns other for unknown types', () => {
    expect(inferKind('text/html')).toBe('other');
    expect(inferKind('')).toBe('other');
  });
});

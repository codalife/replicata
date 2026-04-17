<script lang="ts">
  import Self from './JsonView.svelte';
  interface Props { value: unknown; depth?: number; path?: string; }
  let { value, depth = 0, path = '' }: Props = $props();

  function typeOf(v: unknown): 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object' {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v as 'string' | 'number' | 'boolean' | 'object';
  }

  function keyPath(parent: string, key: string): string {
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    if (ident.test(key)) return parent ? `${parent}.${key}` : key;
    return `${parent}[${JSON.stringify(key)}]`;
  }

  function indexPath(parent: string, i: number): string {
    return `${parent}[${i}]`;
  }

  async function copyPath(p: string, e: Event) {
    e.stopPropagation();
    e.preventDefault();
    try { await navigator.clipboard.writeText(p); } catch {}
  }

  const t = $derived(typeOf(value));
</script>

{#if t === 'object'}
  {@const entries = Object.entries(value as Record<string, unknown>)}
  {#if entries.length === 0}
    <span class="punct">{'{}'}</span>
  {:else}
    <details class="json-details" open={depth < 1}>
      <summary><span class="punct">{'{'}</span><span class="preview"> {entries.length} key{entries.length === 1 ? '' : 's'} </span><span class="punct">{'}'}</span></summary>
      <div class="json-body">
        {#each entries as [k, v]}
          {@const childPath = keyPath(path, k)}
          <div class="json-row">
            <span class="json-key">"{k}"</span><span class="punct">: </span><Self value={v} depth={depth + 1} path={childPath} />
            <button class="copy-path" title="copy path: {childPath}" onclick={(e) => copyPath(childPath, e)}>⎘</button>
          </div>
        {/each}
      </div>
    </details>
  {/if}
{:else if t === 'array'}
  {@const arr = value as unknown[]}
  {#if arr.length === 0}
    <span class="punct">[]</span>
  {:else}
    <details class="json-details" open={depth < 1}>
      <summary><span class="punct">[</span><span class="preview"> {arr.length} item{arr.length === 1 ? '' : 's'} </span><span class="punct">]</span></summary>
      <div class="json-body">
        {#each arr as v, i}
          {@const childPath = indexPath(path, i)}
          <div class="json-row">
            <span class="json-idx">{i}:</span> <Self value={v} depth={depth + 1} path={childPath} />
            <button class="copy-path" title="copy path: {childPath}" onclick={(e) => copyPath(childPath, e)}>⎘</button>
          </div>
        {/each}
      </div>
    </details>
  {/if}
{:else if t === 'string'}
  <span class="json-string">"{value}"</span>
{:else if t === 'number'}
  <span class="json-number">{value}</span>
{:else if t === 'boolean'}
  <span class="json-bool">{value}</span>
{:else}
  <span class="json-null">null</span>
{/if}

<style>
  .json-details { display: inline-block; vertical-align: top; }
  .json-details > summary { cursor: pointer; display: inline; font-family: monospace; font-size: 11px; color: #bbb; list-style: none; }
  .json-details > summary::-webkit-details-marker { display: none; }
  .json-details > summary::before { content: '▸ '; color: #666; }
  .json-details[open] > summary::before { content: '▾ '; }
  .json-body { margin-left: 12px; font-family: monospace; font-size: 11px; }
  .json-row { line-height: 1.5; position: relative; }
  .json-row:hover > .copy-path { opacity: 1; }
  .json-key { color: #60a5fa; }
  .json-idx { color: #666; }
  .json-string { color: #4ade80; font-family: monospace; font-size: 11px; word-break: break-word; }
  .json-number { color: #fbbf24; font-family: monospace; font-size: 11px; }
  .json-bool { color: #e94560; font-family: monospace; font-size: 11px; }
  .json-null { color: #888; font-family: monospace; font-size: 11px; }
  .punct { color: #666; font-family: monospace; font-size: 11px; }
  .preview { color: #555; font-size: 10px; font-style: italic; }
  .copy-path { opacity: 0; margin-left: 6px; background: #1a1a1a; border: 1px solid #333; color: #888; padding: 0 4px; border-radius: 3px; font-size: 10px; cursor: pointer; line-height: 1.2; vertical-align: middle; transition: opacity 120ms; }
  .copy-path:hover { color: #4ade80; border-color: #4ade80; background: #0f1a0f; }
</style>

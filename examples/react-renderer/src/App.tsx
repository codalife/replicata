import { useEffect, useRef, useState, memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Chat UI — receives real bytes from replicata's SSE bridge.
// Parses ChatGPT's delta-encoding v1 format (JSON patches on /message/content/parts/0).

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  errored?: boolean;
}

function extractDeltas(jsonObj: unknown): string[] {
  if (!jsonObj || typeof jsonObj !== 'object') return [];
  const o = jsonObj as Record<string, any>;

  // ChatGPT delta-encoding v1: initial add
  if (o.o === 'add' && o.v?.message?.content?.parts) {
    const text = o.v.message.content.parts.join('');
    return text ? [text] : [];
  }

  // ChatGPT delta-encoding v1: patch array
  if (o.o === 'patch' && Array.isArray(o.v)) {
    return o.v
      .filter((p: any) => p.p === '/message/content/parts/0' && p.o === 'append' && typeof p.v === 'string')
      .map((p: any) => p.v as string);
  }

  // Shorthand: top-level patch without wrapping "o":"patch"
  if (Array.isArray(o.v) && !o.o) {
    return (o.v as any[])
      .filter((p: any) => p.p === '/message/content/parts/0' && p.o === 'append' && typeof p.v === 'string')
      .map((p: any) => p.v as string);
  }

  // Fallback: OpenAI completions API shape
  if (o.choices?.[0]?.delta?.content) return [o.choices[0].delta.content];
  // Claude shape
  if (o.delta?.text) return [o.delta.text];

  return [];
}

function parseSseChunk(buffer: string): { events: Array<{ event?: string; data: string }>; remainder: string } {
  const parts = buffer.split(/\n\n/);
  const remainder = parts.pop() ?? '';
  const events: Array<{ event?: string; data: string }> = [];
  for (const p of parts) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of p.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join('\n') });
  }
  return { events, remainder };
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [composer, setComposer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = composer.trim();
    if (!text || streaming) return;
    setComposer('');
    await submitMessage(text);
  }

  async function submitMessage(text: string) {
    const userMsg: Message = { id: 'u_' + Date.now(), role: 'user', text };
    const assistantMsg: Message = {
      id: 'a_' + Date.now(),
      role: 'assistant',
      text: '',
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/backend-anon/f/conversation", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseChunk(buffer);
        buffer = remainder;
        for (const { event, data } of events) {
          if (data === '[DONE]') continue;
          if (event === 'delta_encoding') continue;
          // Only process delta events and bare data lines with delta content
          if (event && event !== 'delta') continue;
          try {
            const json = JSON.parse(data);
            const deltas = extractDeltas(json);
            for (const d of deltas) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsg.id ? { ...m, text: m.text + d } : m)),
              );
            }
          } catch {
            // non-json — ignore
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: m.text || `error: ${(err as Error).message}`, errored: true }
              : m,
          ),
        );
      }
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)),
      );
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function regen() {
    if (streaming) return;
    const lastUserIdx = [...messages].map((m, i) => ({ m, i })).reverse().find((x) => x.m.role === 'user')?.i;
    if (lastUserIdx === undefined) return;
    const lastUser = messages[lastUserIdx];
    setMessages((prev) => prev.slice(0, lastUserIdx));
    await submitMessage(lastUser.text);
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRegen = !streaming && !!lastAssistant && !lastAssistant.streaming;

  return (
    <div className="flex flex-col h-full max-w-2xl mx-auto">
      <header className="p-4 border-b border-zinc-800 text-sm font-semibold text-zinc-300">
        replicata renderer
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-zinc-500 text-sm" data-replicata-tag="empty-state">
            drive a message in the real app to start streaming
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            data-replicata-tag={m.role === 'user' ? 'user-message' : 'assistant-message'}
            className={
              m.role === 'user'
                ? 'ml-auto max-w-[80%] rounded-xl bg-blue-900/40 border border-blue-800/50 px-4 py-2 text-sm whitespace-pre-wrap'
                : 'mr-auto max-w-[80%] rounded-xl bg-zinc-900 border border-zinc-800 px-4 py-2 text-sm'
            }
          >
            {m.role === 'assistant' && m.text ? (
              <MarkdownBody text={m.text} />
            ) : (
              m.text || (m.streaming && <TypingIndicator />)
            )}
            {m.errored && <div className="mt-1 text-xs text-rose-400">{m.text.startsWith('error:') ? '' : 'error during stream'}</div>}
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-800 p-3 flex gap-2 items-end">
        <form
          data-replicata-tag="enter-capture"
          onSubmit={(e) => { e.preventDefault(); send(); }}
          className="flex-1"
        >
          <textarea
            data-replicata-tag="message-input"
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            className="w-full resize-none bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm focus:border-emerald-600 outline-none"
          />
        </form>
        {streaming ? (
          <button
            data-replicata-tag="stop-button"
            onClick={stop}
            className="px-4 py-2 rounded-lg bg-rose-900/60 border border-rose-800/70 text-sm hover:bg-rose-900"
          >
            stop
          </button>
        ) : (
          <>
            <button
              data-replicata-tag="send-button"
              onClick={send}
              disabled={!composer.trim()}
              className="px-4 py-2 rounded-lg bg-emerald-900/60 border border-emerald-800/70 text-sm hover:bg-emerald-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              send
            </button>
            {canRegen && (
              <button
                data-replicata-tag="regen-button"
                onClick={regen}
                className="px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                regen
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="prose prose-invert prose-sm max-w-none
      prose-headings:text-zinc-200 prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
      prose-p:my-2 prose-p:leading-relaxed
      prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
      prose-blockquote:border-l-emerald-600 prose-blockquote:text-zinc-400 prose-blockquote:my-2
      prose-code:text-emerald-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
      prose-pre:bg-zinc-800 prose-pre:rounded-lg prose-pre:my-2
      prose-hr:border-zinc-700 prose-hr:my-4
      prose-strong:text-zinc-200
      prose-em:text-zinc-300
      prose-a:text-emerald-400
    ">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  );
});

function TypingIndicator() {
  return (
    <span data-replicata-tag="typing-indicator" className="inline-flex gap-1 items-center text-zinc-500">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse [animation-delay:300ms]" />
    </span>
  );
}

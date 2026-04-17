import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { EventEmitter } from 'events';

export interface TargetInfo {
  targetId: string;
  url: string;
  title: string;
  type: string;
}

export class TargetWatcher extends EventEmitter {
  private context: BrowserContext;
  private hostPage: Page;
  private session: CDPSession | null = null;
  private targets = new Map<string, TargetInfo>();

  constructor(context: BrowserContext, hostPage: Page) {
    super();
    this.context = context;
    this.hostPage = hostPage;
  }

  async start(): Promise<void> {
    this.session = await this.context.newCDPSession(this.hostPage);
    await this.session.send('Target.setDiscoverTargets', { discover: true });

    this.session.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type !== 'page') return;
      this.targets.set(targetInfo.targetId, this.toInfo(targetInfo));
      this.emitChanged();
    });

    this.session.on('Target.targetInfoChanged', ({ targetInfo }) => {
      if (targetInfo.type !== 'page') return;
      const prev = this.targets.get(targetInfo.targetId);
      this.targets.set(targetInfo.targetId, this.toInfo(targetInfo));
      if (prev && prev.url !== targetInfo.url) {
        this.emit('url-changed', targetInfo.targetId, prev.url, targetInfo.url);
      }
      this.emitChanged();
    });

    this.session.on('Target.targetDestroyed', ({ targetId }) => {
      if (this.targets.delete(targetId)) {
        this.emit('destroyed', targetId);
        this.emitChanged();
      }
    });

    const { targetInfos } = await this.session.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page') this.targets.set(t.targetId, this.toInfo(t));
    }
    this.emitChanged();
  }

  list(): TargetInfo[] {
    return [...this.targets.values()];
  }

  async pageFor(targetId: string): Promise<Page | undefined> {
    for (const page of this.context.pages()) {
      try {
        const s = await this.context.newCDPSession(page);
        const { targetInfo } = await s.send('Target.getTargetInfo');
        await s.detach();
        if (targetInfo.targetId === targetId) return page;
      } catch {}
    }
    return undefined;
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    try { await this.session.detach(); } catch {}
    this.session = null;
  }

  private emitChanged(): void {
    this.emit('changed', [...this.targets.values()]);
  }

  private toInfo(t: { targetId: string; url: string; title: string; type: string }): TargetInfo {
    return { targetId: t.targetId, url: t.url, title: t.title, type: t.type };
  }
}

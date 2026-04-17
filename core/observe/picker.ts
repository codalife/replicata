import type { Page, CDPSession } from 'playwright-core';
import type { PickedElement } from '../tagging/types.js';

// Runs in the browser. Receives the picked element as \`this\`, returns info.
const ELEMENT_INFO_FN = `function() {
  const el = this;

  function pathTo(kind) {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + node.id;
        parts.unshift(part);
        break;
      }
      const esc = (c) => (window.CSS && window.CSS.escape ? window.CSS.escape(c) : c);
      if (kind === 'class') {
        const cls = [...node.classList]
          .filter(c => !c.match(/^(hover|active|focus|is-)/))
          .slice(0, 3);
        if (cls.length) part += '.' + cls.map(esc).join('.');
      } else if (kind === 'nth') {
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
          : [node];
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      } else if (kind === 'both') {
        const cls = [...node.classList]
          .filter(c => !c.match(/^(hover|active|focus|is-)/))
          .slice(0, 2);
        if (cls.length) part += '.' + cls.map(esc).join('.');
        const siblings = node.parentElement
          ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
          : [node];
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;

  const testId =
    el.getAttribute('data-testid') ||
    el.getAttribute('data-test') ||
    el.getAttribute('data-cy') ||
    undefined;

  return {
    tagName: el.tagName.toLowerCase(),
    text: (el.textContent || '').trim().slice(0, 80),
    attrs,
    testId,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    role: el.getAttribute('role') || undefined,
    classPath: pathTo('class'),
    nthChildPath: pathTo('nth'),
    cssPath: pathTo('both'),
  };
}`;

export class Picker {
  private page: Page;
  private session: CDPSession | null = null;
  private waiting: { resolve: (e: PickedElement) => void; reject: (err: Error) => void } | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  async pick(): Promise<PickedElement> {
    if (this.waiting) throw new Error('picker already active');

    const session = await this.page.context().newCDPSession(this.page);
    this.session = session;

    await session.send('DOM.enable');
    await session.send('Runtime.enable');
    await session.send('Overlay.enable');

    const picked = new Promise<PickedElement>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });

    session.on('Overlay.inspectNodeRequested', async (params) => {
      try {
        const { object } = await session.send('DOM.resolveNode', {
          backendNodeId: params.backendNodeId,
          objectGroup: 'replicata-picker',
        });
        if (!object.objectId) throw new Error('resolveNode returned no objectId');

        const result = await session.send('Runtime.callFunctionOn', {
          functionDeclaration: ELEMENT_INFO_FN,
          objectId: object.objectId,
          returnByValue: true,
        });

        if (result.exceptionDetails) {
          throw new Error('element info failed: ' + result.exceptionDetails.text);
        }

        const info = result.result.value as PickedElement;
        await this.cleanup();
        this.waiting?.resolve(info);
        this.waiting = null;
      } catch (err) {
        await this.cleanup();
        this.waiting?.reject(err as Error);
        this.waiting = null;
      }
    });

    await session.send('Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: {
        contentColor: { r: 100, g: 140, b: 255, a: 0.3 },
        borderColor: { r: 100, g: 140, b: 255, a: 1 },
        showInfo: true,
        showRulers: false,
        showExtensionLines: false,
      },
    });

    return picked;
  }

  async cancel(): Promise<void> {
    if (this.waiting) {
      this.waiting.reject(new Error('picker cancelled'));
      this.waiting = null;
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
    } catch {}
    try { await this.session.send('Overlay.disable'); } catch {}
    try { await this.session.detach(); } catch {}
    this.session = null;
  }
}

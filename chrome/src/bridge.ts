/**
 * Gepetel fork: the extension's end of the agent's direct line
 * (agent/src/bridge.ts) — the takeover for pages the debugger can't hold.
 *
 * Chrome lets no extension debug a page another extension is active on, so a
 * password manager's menu on a sign-in page took the tab from Gepetel each
 * time the person tapped a field. Nothing here uses the debugger: the
 * picture is Chrome's own capture of the visible tab, and taps and typing
 * are delivered by a page script.
 *
 * The agent listens on 127.0.0.1 at a port the connect page was given; both
 * sides prove they hold the key the person approved (HMAC of each other's
 * random challenge) before anything else is said.
 */

import { debugLog } from './relayConnection';

export interface BridgeTabs {
  all(): number[];
  takenAway(): number[];
  release(tabId: number): void;
  reattach(tabId: number): void;
}

async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}

export class BridgeClient {
  private _ws: WebSocket | null = null;
  private _closed = false;
  private _lastCapture = 0;

  constructor(private _port: number, private _key: string, private _tabs: BridgeTabs) {}

  connect(): void {
    if (!(this._port > 1024 && this._port < 65536))
      return;
    const ws = new WebSocket(`ws://127.0.0.1:${this._port}`);
    this._ws = ws;
    const challenge = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    let proven = false;
    ws.onmessage = async ev => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.t === 'hello' && typeof msg.challenge === 'string') {
        ws.send(JSON.stringify({ t: 'auth', mac: await hmac(this._key, 'extension:' + msg.challenge), challenge }));
        return;
      }
      if (msg?.t === 'ok') {
        if (msg.mac !== await hmac(this._key, 'agent:' + challenge)) {
          debugLog('bridge: the other end does not hold the key; closed');
          ws.close();
          return;
        }
        proven = true;
        // From now on the extension's own log goes to the agent's log too.
        (globalThis as any).__gepetelLogSink = (line: string) => { try { if (this._ws === ws) ws.send(JSON.stringify({ t: 'log', line })); } catch {} };
        debugLog(`bridge: connected to the agent (port ${this._port})`);
        return;
      }
      if (!proven || typeof msg?.id !== 'number')
        return;
      try {
        ws.send(JSON.stringify({ id: msg.id, result: await this._handle(String(msg.method), msg.params || {}) }));
      } catch (e: any) {
        ws.send(JSON.stringify({ id: msg.id, error: String(e?.message || e) }));
      }
    };
    ws.onclose = () => { this._ws = null; (globalThis as any).__gepetelLogSink = null; };
    ws.onerror = () => {};
  }

  close(): void {
    this._closed = true;
    try { this._ws?.close(); } catch {}
  }

  private async _handle(method: string, p: any): Promise<any> {
    const tabId = Number(p.tabId);
    switch (method) {
      case 'takenAway': {
        const out = [];
        for (const id of this._tabs.takenAway()) {
          const tab = await chrome.tabs.get(id).catch(() => null);
          if (tab)
            out.push({ tabId: id, url: tab.url || '' });
        }
        return out;
      }
      case 'tabs': {
        // Gepetel's tabs, with Chrome's own ids — Playwright has none.
        const out = [];
        for (const id of this._tabs.all()) {
          const tab = await chrome.tabs.get(id).catch(() => null);
          if (tab)
            out.push({ tabId: id, url: tab.url || '', windowId: tab.windowId, active: !!tab.active });
        }
        return out;
      }
      case 'release':
        this._tabs.release(tabId);
        await chrome.tabs.sendMessage(tabId, { type: 'gepetelGuardOff' }).catch(() => {});
        return true;
      case 'reattach':
        this._tabs.reattach(tabId);
        return true;
      case 'capture': {
        // Chrome allows two captures a second; wait out the gap ourselves
        // (the question's picture and the first frame collided).
        const wait = this._lastCapture + 520 - Date.now();
        if (wait > 0)
          await new Promise(r => setTimeout(r, wait));
        this._lastCapture = Date.now();
        const tab = await chrome.tabs.get(tabId);
        // Chrome captures what a window shows: the tab must be its window's
        // current one.
        if (!tab.active)
          await chrome.tabs.update(tabId, { active: true });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
        const [size] = await chrome.scripting.executeScript({ target: { tabId }, func: () => [innerWidth, innerHeight] });
        const [w, h] = (size?.result as number[]) || [0, 0];
        return { b64: dataUrl.slice(dataUrl.indexOf(',') + 1), w, h };
      }
      case 'window': {
        // Phone mode by a real window size (the owner's idea): Gepetel's own
        // window, phone-wide, or maximized for a desktop ("full screen").
        // Nothing about the page is faked, and it holds when Chrome takes the
        // tab and gives it back. Never a window with the person's own tabs,
        // and never by moving a tab (that lost it to Playwright).
        const tab = await chrome.tabs.get(tabId);
        const there = await chrome.tabs.query({ windowId: tab.windowId });
        if (there.some(t => t.groupId !== tab.groupId))
          throw new Error(`tab ${tabId} shares its window with the person's tabs; not resizing it`);
        if (Number(p.width) >= 1000) {
          await chrome.windows.update(tab.windowId, { state: 'maximized' });
        } else {
          const win = await chrome.windows.get(tab.windowId);
          if (win.state !== 'normal')
            await chrome.windows.update(tab.windowId, { state: 'normal' });
          await chrome.windows.update(tab.windowId, { width: Math.round(Number(p.width)), height: Math.round(Number(p.height)) });
        }
        await new Promise(r => setTimeout(r, 300));
        const after = await chrome.windows.get(tab.windowId);
        const [inner] = await chrome.scripting.executeScript({ target: { tabId }, func: () => [innerWidth, innerHeight, document.documentElement.scrollWidth] }).catch(() => [{ result: null }] as any);
        debugLog(`window of tab ${tabId}: asked ${Number(p.width) >= 1000 ? 'maximized' : `${p.width}x${p.height}`}, got ${after.width}x${after.height} (${after.state}), page ${JSON.stringify(inner?.result)}`);
        return { window: [after.width, after.height], page: inner?.result ?? null };
      }
      case 'fields': {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageFields });
        return r?.result || [];
      }
      case 'input': {
        const m = p.m || {};
        // The page's own world: a site's script (React) only sees a value set
        // where it can see it.
        // A tap from the extension's own world: it alone can see into another
        // extension's closed shadow root (iCloud Passwords' list sat over the
        // password field that way) and tap what's under it. Typing from the
        // page's world, where a site's script sees the value change.
        const [r] = await chrome.scripting.executeScript(m.kind === 'tap'
          ? { target: { tabId }, func: pageTap, args: [Number(m.x), Number(m.y)] }
          : { target: { tabId }, world: 'MAIN', func: pageInput, args: [m] });
        const what = String(r?.result ?? '');
        debugLog(`takeover input on tab ${tabId}: ${m.kind}${m.kind === 'tap' ? ` ${m.x},${m.y}` : m.kind === 'key' ? ` ${m.key}` : m.kind === 'text' ? ` (${String(m.text ?? '').length} chars)` : ''} → ${what}`);
        return what;
      }
    }
    throw new Error(`unknown bridge method ${method}`);
  }
}

/** In the page: its text fields, as [x, y, w, h] in CSS pixels. */
function pageFields(): number[][] {
  const out: number[][] = [];
  for (const el of document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable=true]')) {
    const i = el as HTMLInputElement;
    if (i.tagName === 'INPUT' && /^(hidden|checkbox|radio|submit|button|image|file|range|color|reset)$/i.test(i.type))
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight)
      continue;
    out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
    if (out.length >= 40)
      break;
  }
  return out;
}

/** In the page, in the extension's world: a tap. What the person sees at
 *  that spot, under anything another extension laid over the page — its
 *  frames, and the elements holding them in closed shadow roots, which only
 *  chrome.dom can open. */
function pageTap(x: number, y: number): string {
  const own = chrome.runtime.getURL('');
  const foreignFrame = (e: Element) => e.tagName === 'IFRAME' && /^chrome-extension:/.test((e as HTMLIFrameElement).src) && !(e as HTMLIFrameElement).src.startsWith(own);
  const holdsForeign = (e: Element): boolean => {
    let sr: ShadowRoot | null = null;
    try { sr = (chrome as any).dom?.openOrClosedShadowRoot?.(e as HTMLElement) ?? null; } catch {}
    return !!sr && [...sr.querySelectorAll('iframe')].some(foreignFrame);
  };
  const isOverlay = (e: Element) => foreignFrame(e) || (e instanceof HTMLElement && holdsForeign(e))
    || (e !== document.body && e !== document.documentElement && !document.body.contains(e));
  const label = (e: Element | null) => {
    if (!e) return 'nothing';
    const h = e as HTMLElement & { type?: string; name?: string };
    const text = (h.getAttribute('aria-label') || (h.tagName === 'INPUT' ? h.getAttribute('placeholder') || h.name : h.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${h.tagName}${h.type ? `[${h.type}]` : ''}${h.id ? `#${h.id}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const stack = document.elementsFromPoint(x, y);
  const skipped = stack.filter(isOverlay);
  const el = (stack.find(e => !isOverlay(e)) || null) as HTMLElement | null;
  if (!el)
    return `nothing at ${x},${y} (page ${innerWidth}x${innerHeight})`;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  const field = el.closest('input, textarea, select, [contenteditable]') as HTMLElement | null;
  const typable = !!field && (field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|image|file|range|color|reset|hidden)$/i.test((field as HTMLInputElement).type)));
  (field || el).focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  if (!typable)
    el.click();
  return `${typable ? 'focused' : 'clicked'} ${label(field || el)}${skipped.length ? ` (under ${skipped.map(label).join(', ')} — another extension's)` : ''}`;
}

/** In the page: one input from the takeover viewer. Untrusted events, so
 *  what a person's tap does is done directly: focus a field, click the rest.
 *  Says what it did, for the log — never what was typed. */
function pageInput(m: { kind?: string; x?: number; y?: number; text?: string; key?: string; dy?: number }): string {
  const name = (el: Element | null) => {
    if (!el) return 'nothing';
    const h = el as HTMLElement & { type?: string; name?: string };
    const label = (h.getAttribute('aria-label') || (h.tagName === 'INPUT' ? h.getAttribute('placeholder') || h.name : h.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${h.tagName}${h.type ? `[${h.type}]` : ''}${label ? ` "${label}"` : ''}`;
  };
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const active = document.activeElement as HTMLElement | null;
  const typable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
    !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|image|file|range|color|reset|hidden)$/i.test((el as HTMLInputElement).type)));
  switch (m.kind) {
    case 'tap': {
      // What the person sees at that spot, below anything another extension
      // laid over the page: iCloud Passwords' suggestion list covered the
      // password field on a real Mac, and the tap went to it, not the field.
      const isOverlay = (e: Element) => (e.tagName === 'IFRAME' && /^chrome-extension:/.test((e as HTMLIFrameElement).src))
        || (e !== document.body && e !== document.documentElement && !document.body.contains(e));
      const stack = document.elementsFromPoint(Number(m.x), Number(m.y));
      const skipped = stack.filter(isOverlay).length;
      const el = (stack.find(e => !isOverlay(e)) || null) as HTMLElement | null;
      if (!el)
        return `nothing at ${m.x},${m.y} (page ${innerWidth}x${innerHeight})`;
      const opts = { bubbles: true, cancelable: true, clientX: Number(m.x), clientY: Number(m.y), view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      const field = el.closest('input, textarea, select, [contenteditable]') as HTMLElement | null;
      (field || el).focus?.();
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      if (!typable(field))
        el.click();
      return `${typable(field) ? 'focused' : 'clicked'} ${name(field || el)}${skipped ? ` (under ${skipped} overlay element(s) of another extension)` : ''}`;
    }
    case 'text': {
      const t = String(m.text ?? '');
      if (typable(active)) {
        const s = active.selectionStart ?? active.value.length, e = active.selectionEnd ?? active.value.length;
        setValue(active, active.value.slice(0, s) + t + active.value.slice(e));
        try { active.setSelectionRange(s + t.length, s + t.length); } catch {}
      } else if (active?.isContentEditable) {
        document.execCommand('insertText', false, t);
      } else {
        return `typed nowhere: the focus is on ${name(active)}`;
      }
      return `typed into ${name(active)}`;
    }
    case 'key': {
      const key = String(m.key);
      if (key === 'Backspace' && typable(active)) {
        const s = active.selectionStart ?? active.value.length, e = active.selectionEnd ?? s;
        const from = s === e ? Math.max(0, s - 1) : s;
        setValue(active, active.value.slice(0, from) + active.value.slice(e));
        try { active.setSelectionRange(from, from); } catch {}
        return `deleted in ${name(active)}`;
      }
      if (key === 'Enter' && active && (active as HTMLInputElement).form) {
        const f = (active as HTMLInputElement).form!;
        if (f.requestSubmit) f.requestSubmit(); else f.submit();
        return `submitted the form of ${name(active)}`;
      }
      if (key === 'Tab') {
        const all = [...document.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')].filter(x => !(x as HTMLInputElement).disabled && x.offsetParent);
        all[(all.indexOf(active as HTMLElement) + 1) % all.length]?.focus();
        return `focus to ${name(document.activeElement)}`;
      }
      (active || document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      (active || document.body).dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      return `key to ${name(active)}`;
    }
    case 'scroll':
      window.scrollBy(0, Number(m.dy) || 0);
      return `scrolled to ${scrollY}`;
    case 'back':
      history.back();
      return 'back';
  }
  return `unknown input ${m.kind}`;
}

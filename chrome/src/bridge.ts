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
import { pageFields, pageInput, pageReading, pageTap } from './pageScripts';

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
    try { this._ws?.close(); } catch {}
  }

  /** Gepetel's tab: one of its connection's (taken-away ones too), or a
   *  window one of those opened (a sign-in popup). Never a person's own —
   *  every method that takes a tab asks first. */
  private async _mine(tabId: number): Promise<chrome.tabs.Tab> {
    const ours = new Set(this._tabs.all());
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !(ours.has(tabId) || (tab.openerTabId !== undefined && ours.has(tab.openerTabId))))
      throw new Error(`tab ${tabId} isn't Gepetel's`);
    return tab;
  }

  private async _handle(method: string, p: any): Promise<any> {
    const tabId = Number(p.tabId);
    if (!['takenAway', 'tabs'].includes(method))
      await this._mine(tabId);
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
        const out: { tabId: number; url: string; windowId: number; active: boolean; popup?: boolean }[] = [];
        const ids = new Set(this._tabs.all());
        for (const id of ids) {
          const tab = await chrome.tabs.get(id).catch(() => null);
          if (tab)
            out.push({ tabId: id, url: tab.url || '', windowId: tab.windowId, active: !!tab.active });
        }
        // And the windows those opened — Google's sign-in from booking.com's
        // (2026-10-14): Gepetel's too (the guard says so), but not in the
        // connection's list, so the takeover never knew it was there.
        for (const tab of await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[])) {
          if (tab.id !== undefined && !ids.has(tab.id) && tab.openerTabId !== undefined && ids.has(tab.openerTabId))
            out.push({ tabId: tab.id, url: tab.url || '', windowId: tab.windowId, active: !!tab.active, popup: true });
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
      case 'close': {
        // Only Gepetel's own tabs: duplicates on one site, which jobs used to
        // leave behind (six booking.com tabs, 2026-10-14). Never a person's
        // (_mine, above).
        await chrome.tabs.remove(tabId);
        debugLog(`closed tab ${tabId} (a duplicate on its site)`);
        return true;
      }
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
        // Every other tab there Gepetel's, or in its group — and "no group"
        // (-1) is no group: two ungrouped tabs aren't one owner's.
        const there = await chrome.tabs.query({ windowId: tab.windowId });
        const ours = new Set(this._tabs.all());
        const own = (t: chrome.tabs.Tab) => t.id === tabId || (t.id !== undefined && ours.has(t.id))
          || (t.openerTabId !== undefined && ours.has(t.openerTabId)) || (tab.groupId !== -1 && t.groupId === tab.groupId);
        if (!there.every(own))
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
      case 'locate': {
        // Where something with this text is on the page, in CSS pixels —
        // for tests, and for the log: what is at that spot.
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, args: [String(p.text || '')], func: (want: string) => {
          const all = [...document.querySelectorAll<HTMLElement>('button, a, [role=button], input[type=submit], div, span')];
          const hit = all.filter(e => (e.innerText || e.getAttribute('aria-label') || '').trim().includes(want) && e.getBoundingClientRect().width > 0)
            .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
          if (!hit) return null;
          const q = hit.getBoundingClientRect();
          return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)];
        } });
        return r?.result ?? null;
      }
      case 'page': {
        // A taken tab, read by script (no debugger): its text, its boxes and
        // buttons and where they are — for the job to sign in or type a code
        // with the Mac's own keys while another extension's frame (iCloud
        // Passwords) keeps the debugger out (2026-10-15).
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageReading });
        return r?.result ?? null;
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

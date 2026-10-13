/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { debugLog } from './relayConnection';
import { BridgeClient } from './bridge';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, cleanupStalePlaywrightGroups, isNonDebuggableUrl, ungroupTabs, uniqueGroupStyle, GEPETEL_GROUP_TITLE, findGepetelGroup } from './connectedTabGroup';

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  connectionId: number;
} | {
  type: 'keepalive';
};

/** Gepetel fork: its window, phone-wide to start (Chrome's narrowest normal
 *  window is 500 px on a Mac, measured). */
const GEPETEL_WINDOW = { width: 500, height: 900 };

class PlaywrightExtension {
  private _connections = new Map<number, ConnectedTabGroup>();
  private _bridge: BridgeClient | null = null;   // Gepetel fork: bridge.ts
  private _lastConnectionId = 0;
  private _pendingConnections = new PendingConnections();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;

  constructor() {
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        this._releaseConnectPage(selectorTabId).then(() => {
          this._pendingConnections.create(selectorTabId, message.mcpRelayUrl);
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // Token-bypass (no specific pick) falls back to the connect page itself
        // so `ConnectedTabGroup` always has a concrete tab to start from. Both
        // sender.tab and UI-supplied tabs come from chrome.tabs.query / runtime
        // message sender, where `id` is always defined.
        const selectedTab = (message.tab ?? sender.tab!) as chrome.tabs.Tab & { id: number };
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections].map(([id, group]) => ({
            id,
            clientName: group.clientName,
            connectedTabIds: group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        this._connections.get(message.connectionId)?.close('User disconnected');
        sendResponse({ success: true });
        return false;
      case 'gepetelGuard': {
        // Gepetel fork (guard/guard.js): is this tab one Gepetel is driving
        // now — in its group, or a popup one of those opened?
        const tab = sender.tab;
        const driven = (id: number | undefined) => id !== undefined && [...this._connections.values()].some(g => g.clientName === 'Gepetel' && g.connectedTabIds().includes(id));
        // A tab left alone (Chrome took it for another extension's frame):
        // no guard there either — taking the frame out again went in a loop.
        const released = !!tab?.id && [...this._connections.values()].some(g => g.isReleased(tab.id!));
        sendResponse({ on: !!tab && !released && (driven(tab.id) || driven(tab.openerTabId)) });
        return false;
      }
      case 'gepetelBridge': {
        // The connect page of a Gepetel connection: where the agent's direct
        // line listens, and the key both sides must prove (bridge.ts).
        const port = Number(message.port), key = String(message.key || '');
        if (port && key) {
          this._bridge?.close();
          const groups = () => [...this._connections.values()].filter(g => g.clientName === 'Gepetel');
          this._bridge = new BridgeClient(port, key, {
            all: () => [...new Set(groups().flatMap(g => [...g.connectedTabIds(), ...g.takenAway()]))],
            takenAway: () => groups().flatMap(g => g.takenAway()),
            release: id => groups().forEach(g => g.release(id)),
            reattach: id => groups().forEach(g => g.reattach(id)),
          });
          this._bridge.connect();
        }
        sendResponse({ success: true });
        return false;
      }
      case 'gepetelGuardLog':
        debugLog(`guard (tab ${sender.tab?.id}): ${String(message.what || '').slice(0, 200)}`);
        // A frame just went: if Chrome took the tab from us for it, it can be ours again.
        if (message.took && sender.tab?.id !== undefined)
          for (const group of this._connections.values()) group.retryTab(sender.tab.id);
        return false;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: chrome.tabs.Tab & { id: number }, clientName: string | undefined): Promise<void> {
    try {
      await this._cleanupPromise;
      this._releaseTab(selectorTabId);
      if (tab.id !== selectorTabId && this._connectedTabIds().has(tab.id))
        throw new Error('This tab is already connected to another client');

      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');

      const id = ++this._lastConnectionId;
      const taken = [...this._connections.values()].map(group => group.groupStyle);
      const style = uniqueGroupStyle(clientName, taken);
      // Gepetel fork: Gepetel's kept group, adopted (connectedTabGroup.ts).
      const adopt = clientName === 'Gepetel' && style.title === GEPETEL_GROUP_TITLE ? await findGepetelGroup() : null;
      // Gepetel fork: Gepetel's own window, before anything attaches to the
      // tab (moving a tab later lost it for Playwright). Phone or desktop is
      // that window's size (bridge.ts, 'window') — nothing about the page is
      // faked. Reused: the kept tabs live there too.
      if (clientName === 'Gepetel')
        await this._intoGepetelWindow(tab, adopt);
      const group = new ConnectedTabGroup(connection, tab, clientName, style, tabId => this._pendingConnections.has(tabId), adopt);
      group.onclose = () => this._connections.delete(id);
      this._connections.set(id, group);

      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true }),
      ]).catch(() => {});

      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error: any) {
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    }
  }

  private async _intoGepetelWindow(tab: chrome.tabs.Tab & { id: number }, adopt: { groupId: number; tabs: chrome.tabs.Tab[] } | null): Promise<void> {
    try {
      // Gepetel's window: the kept group's, if nothing else of the person's
      // is in it; otherwise a new one, made from this tab.
      const keptWindow = adopt?.tabs.find(t => t.id !== tab.id)?.windowId;
      let windowId: number | undefined;
      if (keptWindow !== undefined) {
        const there = await chrome.tabs.query({ windowId: keptWindow });
        if (there.every(t => t.groupId === adopt!.groupId || t.id === tab.id))
          windowId = keptWindow;
      }
      if (windowId === undefined) {
        const alone = (await chrome.tabs.query({ windowId: tab.windowId })).length === 1;
        if (alone) {
          windowId = tab.windowId;
        } else {
          const w = await chrome.windows.create({ tabId: tab.id, focused: false, width: GEPETEL_WINDOW.width, height: GEPETEL_WINDOW.height });
          windowId = w!.id!;
          debugLog(`tab ${tab.id}: a new Gepetel window ${windowId}`);
        }
      }
      // This tab and the kept ones, all there before anything attaches to
      // them (a tab moved later was lost to Playwright).
      const move = [tab, ...(adopt?.tabs ?? [])].filter(t => t.id !== undefined && t.windowId !== windowId).map(t => t.id!);
      if (move.length) {
        await chrome.tabs.move(move, { windowId, index: -1 });
        debugLog(`into Gepetel's window ${windowId}: ${move.length} tab(s)`);
      }
      Object.assign(tab, await chrome.tabs.get(tab.id));
      if (adopt)
        adopt.tabs = await Promise.all(adopt.tabs.map(t => chrome.tabs.get(t.id!).catch(() => t)));
    } catch (e: any) {
      debugLog('Error giving Gepetel its window:', e);
    }
  }

  // Chrome may create the connect page inside the active client's group.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    this._releaseTab(tabId);
    await ungroupTabs([tabId]);
  }

  private _releaseTab(tabId: number): void {
    for (const group of this._connections.values())
      group.releaseTab(tabId);
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    const connectedTabIds = this._connectedTabIds();
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url) && (tab.id === selectorTabId || !connectedTabIds.has(tab.id!)));
  }

  private _connectedTabIds(): Set<number> {
    return new Set([...this._connections.values()].flatMap(group => group.connectedTabIds()));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
}

new PlaywrightExtension();

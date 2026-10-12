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

import { RelayConnection, debugLog } from './relayConnection';

const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;
// Green first, so a lone connection keeps the familiar look.
const PLAYWRIGHT_GROUP_COLORS: GroupColor[] = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

type GroupColor = `${chrome.tabGroups.Color}`;

export type GroupStyle = {
  title: string;
  color: GroupColor;
};

export function uniqueGroupStyle(clientName: string | undefined, taken: readonly GroupStyle[]): GroupStyle {
  const titles = new Set(taken.map(style => style.title));
  const base = PLAYWRIGHT_GROUP_TITLE_PREFIX + (clientName || 'unknown');
  let title = base;
  for (let i = 2; titles.has(title); i++)
    title = `${base} (${i})`;

  const colors = new Set(taken.map(style => style.color));
  const color = PLAYWRIGHT_GROUP_COLORS.find(candidate => !colors.has(candidate)) ?? PLAYWRIGHT_GROUP_COLORS[0];
  return { title, color };
}

// Ungroups any Playwright-titled groups left behind by a prior service worker.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    // The bare title comes from versions that predate per-client groups.
    // Gepetel fork: Gepetel's group is kept between jobs on purpose — and
    // Chrome stops this worker between them, so this runs on each wake.
    const stale = groups.filter(g => (g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX)) && g.title !== GEPETEL_GROUP_TITLE);
    const tabsPerGroup = await Promise.all(stale.map(g => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map(t => t.id).filter((id): id is number => id !== undefined);
    if (tabIds.length)
      await ungroupTabs(tabIds);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The Playwright tab group for an active RelayConnection. The Chrome tab group
// is the single source of truth for which tabs the client targets:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// `_groupTabIds` caches group membership from Chrome events so hot-path checks
// in `_onTabUpdated` stay synchronous.
export class ConnectedTabGroup {
  readonly clientName: string | undefined;
  readonly groupStyle: GroupStyle;
  private _connection: RelayConnection;
  private _isTabReserved: (tabId: number) => boolean;
  private _groupId: number | null = null;
  private _groupTabIds: Set<number> = new Set();
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;

  onclose?: () => void;

  constructor(connection: RelayConnection, selectedTab: chrome.tabs.Tab, clientName: string | undefined, groupStyle: GroupStyle, isTabReserved: (tabId: number) => boolean,
              adopt?: { groupId: number; tabs: chrome.tabs.Tab[] } | null) {
    this.clientName = clientName;
    this.groupStyle = groupStyle;
    this._isTabReserved = isTabReserved;
    this._connection = connection;
    this._connection.onclose = () => this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    // Seed the relay with the user-selected tab, then close out the initial
    // handshake. The relay holds Playwright-side CDP traffic until
    // `didInitialize` arrives, so it sees a fully populated tab model by the
    // time it handles `Target.setAutoAttach`.
    this._connection.attachTab(selectedTab);
    if (adopt) {
      // Gepetel fork: the kept group's tabs come back to this job, after the
      // tab it starts in (Playwright makes the first one current).
      this._groupId = adopt.groupId;
      for (const tab of adopt.tabs) {
        if (tab.id === undefined || tab.id === selectedTab.id)
          continue;
        this._groupTabIds.add(tab.id);
        if (!isNonDebuggableUrl(tab.url))
          this._connection.attachTab(tab);
      }
    }
    this._connection.didInitialize();
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  /** Gepetel fork: the guard took another extension's frame out of this tab. */
  retryTab(tabId: number): void {
    if (this._groupTabIds.has(tabId))
      this._connection.retryTakenAway(tabId);
  }

  releaseTab(tabId: number): void {
    if (!this._groupTabIds.has(tabId))
      return;
    this._groupTabIds.delete(tabId);
    this._connection.detachTab(tabId);
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      // Chrome may drop the connect page of a client that is still connecting
      // into our group; that tab is spoken for.
      if (this._isTabReserved(tabId)) {
        void ungroupTabs([tabId]);
        return;
      }
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
  }

  private _onTabAttached(tabId: number): void {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    void this._addTabToGroup(tabId);
  }

  // The debugger detached (drag-out, tab close, or external action). Clear the
  // badge but leave the tab in the group — the user's intent is still there,
  // and a subsequent navigation will re-attach via _onTabUpdated.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
  }

  private _onConnectionClose(): void {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    const groupTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    // Gepetel fork: Gepetel's tab group is its own working area, and it is
    // kept between jobs (asked for by the owner, 2026-10-12): the next job
    // picks up where the sites were — still signed in, nothing to load again
    // — and the person can see what was done. At most GEPETEL_KEEP_TABS, the
    // least recently used closed first; a connect page or a blank tab is
    // never worth keeping. A second Gepetel group (two jobs at once) closes
    // with its job. Other clients keep upstream's behaviour.
    if (groupTabs.length && this.clientName === 'Gepetel') {
      if (this.groupStyle.title === GEPETEL_GROUP_TITLE)
        void keepGepetelTabs(groupTabs);
      else
        void chrome.tabs.remove(groupTabs).catch(() => ungroupTabs(groupTabs));
    } else if (groupTabs.length) {
      void ungroupTabs(groupTabs);
    }
    this.onclose?.();
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into our Chrome tab group, creating it on
  // first use. `_groupTabIds` is updated after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _addTabToGroup(tabId: number): Promise<void> {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      await retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({ tabIds: [tabId] });
          await chrome.tabGroups.update(this._groupId, this.groupStyle);
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
    }
  }

}

/** Gepetel fork: the group kept between jobs, and how many tabs it keeps. */
export const GEPETEL_GROUP_TITLE = `${PLAYWRIGHT_GROUP_TITLE_PREFIX}Gepetel`;
export const GEPETEL_KEEP_TABS = 10;

async function keepGepetelTabs(tabIds: number[]): Promise<void> {
  try {
    const tabs = (await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)))).filter((t): t is chrome.tabs.Tab => !!t);
    const useless = tabs.filter(t => !t.url || t.url === 'about:blank' || t.url.startsWith(chrome.runtime.getURL('')));
    const kept = tabs.filter(t => !useless.includes(t)).sort((a, b) => ((b as any).lastAccessed ?? 0) - ((a as any).lastAccessed ?? 0));
    const close = [...useless, ...kept.slice(GEPETEL_KEEP_TABS)].map(t => t.id!).filter(Boolean);
    if (close.length)
      await chrome.tabs.remove(close);
  } catch (error: any) {
    debugLog('Error keeping Gepetel tabs:', error);
  }
}

/** Gepetel fork: the kept group, if there is one — a new connection adopts
 *  it instead of starting a group of its own. */
export async function findGepetelGroup(): Promise<{ groupId: number; tabs: chrome.tabs.Tab[] } | null> {
  try {
    const group = (await chrome.tabGroups.query({ title: GEPETEL_GROUP_TITLE }))[0];
    if (!group)
      return null;
    return { groupId: group.id, tabs: await chrome.tabs.query({ groupId: group.id }) };
  } catch {
    return null;
  }
}

export async function ungroupTabs(tabIds: number[]): Promise<void> {
  try {
    await retryOnDrag(() => chrome.tabs.ungroup(tabIds));
  } catch (error: any) {
    debugLog('Error ungrouping tabs:', error);
  }
}

// Chrome throws "user may be dragging a tab" while a drag is in progress.
// Retry with backoff until it clears (or we give up).
async function retryOnDrag(fn: () => Promise<void>): Promise<void> {
  const delays = [0, 100, 200, 400, 800];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay)
      await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await fn();
      return;
    } catch (error: any) {
      if (!error?.message?.includes('user may be dragging a tab'))
        throw error;
      lastError = error;
    }
  }
  throw lastError;
}

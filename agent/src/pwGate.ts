// Playwright, asked for anything while it holds no tab, opens one: a blank
// tab (its ensureTab — even listing the tabs does it). That happens whenever
// Chrome takes the job's only tab from the debugger (a password manager's
// frame on a sign-in page): every look, every tab list, the takeover's poll —
// the about:blank tabs the owner kept seeing (2026-10-16: "how do we make sure
// this never happens?"). So every call goes through here: while each of
// Gepetel's tabs is taken, nothing goes to Playwright and the caller gets an
// error result instead; the extension reads and types into the taken tab.
import type { McpResult } from "./mcpClient.js";

export type Call = (tool: string, args: Record<string, unknown>, ms?: number) => Promise<McpResult>;
type TabsView = {
    connected: boolean;
    takenAway(): Promise<{ tabId: number; url: string }[]>;
    tabs(): Promise<{ tabId: number; url: string; popup?: boolean }[]>;
};

export const HELD = "Playwright holds no tab now: Chrome has taken the job's tab (another extension is active in it). Read it through the extension.";

/** True when Playwright has no tab of Gepetel's left: each one is taken. */
export async function allTaken(b: TabsView | null | undefined): Promise<boolean> {
    if (!b?.connected) return false;
    const taken = await b.takenAway().catch(() => null);
    if (!taken?.length) return false;
    const tabs = await b.tabs().catch(() => null);
    if (!tabs) return false;
    const takenIds = new Set(taken.map(t => t.tabId));
    return !tabs.some(t => !t.popup && !takenIds.has(t.tabId));
}

/** A call that never reaches Playwright while it holds no tab. */
export function gated(call: Call, bridge: () => TabsView | null | undefined, log?: (line: string) => void): Call {
    let held = false;
    /** Tabs Chrome held when Playwright said its page was gone: until one of
     *  them is back, Playwright has none of its own — another held tab was
     *  counted as one it could use, and a blank tab opened (2026-10-17). */
    let heldAfterClose: Set<number> | null = null;
    return async (tool, args, ms) => {
        const b = bridge();
        if (heldAfterClose && b?.connected) {
            const now = new Set((await b.takenAway().catch(() => [])).map(t => t.tabId));
            if ([...heldAfterClose].some(id => !now.has(id))) { heldAfterClose = null; log?.("playwright: a held tab is back; calls go through again"); }
            else return { content: [{ type: "text", text: HELD }], isError: true };
        }
        if (await allTaken(b)) {
            if (!held) { held = true; log?.("playwright: every tab of Gepetel's is taken by Chrome — no calls to it until one is back (it would open a blank tab)"); }
            return { content: [{ type: "text", text: HELD }], isError: true };
        }
        if (held) { held = false; log?.("playwright: a tab is back; calls go through again"); }
        const r = await call(tool, args, ms);
        if (r.isError && /Target page, context or browser has been closed/.test(r.content.map(c => c.text || "").join(" ")) && b?.connected) {
            const taken = await b.takenAway().catch(() => []);
            if (taken.length) { heldAfterClose = new Set(taken.map(t => t.tabId)); log?.("playwright: its page was taken by Chrome mid-call — no calls to it until a held tab is back (it would open a blank tab)"); }
        }
        return r;
    };
}

export default { gated, allTaken, HELD };

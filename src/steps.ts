// What a reply is doing while it runs, step by step: a tool starting, a
// connector being opened, a lookup coming back. Reported only when a caller
// asks for it (Turn.onStep) — a phone call, which says it out loud so the line
// is never silent ("Mă uit în calendarul de mâine…"). A WhatsApp reply reports
// nothing and pays nothing for it.

export type Step = {
    phase: "start" | "done";
    /** mcp: a connector call; list: a connector being opened; tool: one of ours; search: the web. */
    kind: "mcp" | "list" | "tool" | "search";
    server?: string;
    name?: string;
    args?: any;
    /** How many results came back, when that can be told. */
    count?: number;
    error?: boolean;
};

/** How many things a tool returned — the length of the first list in it — or undefined. */
export function countResults(output: any): number | undefined {
    let o = output;
    if (typeof o === "string") {
        try { o = JSON.parse(o); } catch { return undefined; }
    }
    if (Array.isArray(o)) return o.length;
    if (!o || typeof o !== "object") return undefined;
    for (const k of ["events", "items", "threads", "messages", "results", "contacts", "reminders", "files", "data"]) {
        if (Array.isArray(o[k])) return o[k].length;
    }
    for (const v of Object.values(o)) if (Array.isArray(v)) return v.length;
    // MCP results arrive as { content: [{ type: "text", text: "<json>" }] }.
    const text = o?.content?.[0]?.text;
    return typeof text === "string" ? countResults(text) : undefined;
}

/** Which of their things a connector is, in a few words. */
export function areaOf(server: string | undefined, name: string | undefined = ""): string {
    const s = `${server || ""} ${name || ""}`.toLowerCase();
    if (/calendar/.test(s)) return "their calendar";
    if (/gmail|mail|inbox/.test(s)) return "their mail";
    if (/drive|docs|sheet/.test(s)) return "their files";
    if (/contact/.test(s)) return "their contacts";
    if (/computer|device|mac|browser|desktop/.test(s)) return "their computer";
    const label = String(server || "").replace(/_[a-z0-9]+_(gmail|yahoo|outlook|icloud)_com$/i, "").replace(/[_-]+/g, " ").trim();
    return label ? label : "a connected service";
}

const short = (s: any, n = 40) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** The day a calendar lookup is about, as YYYY-MM-DD, if it says. */
function dayOf(args: any): string {
    const v = args?.startTime || args?.timeMin || args?.start || args?.date || "";
    const m = String(v).match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : "";
}

/** What a search is for — the words, never anything found. */
function queryOf(args: any): string {
    const q = args?.query ?? args?.q ?? args?.search ?? args?.text ?? args?.name ?? "";
    return short(q);
}

const OUR_TOOLS: Record<string, string> = {
    set_reminder: "setting the reminder",
    create_reminder: "setting the reminder",
    create_recurring_reminder: "setting the reminder",
    update_reminder: "changing the reminder",
    delete_reminder: "removing the reminder",
    list_my_reminders: "checking their reminders",
    list_reminders: "checking their reminders",
    search_reminders: "checking their reminders",
    send_email: "sending the email",
    call_business: "placing the call",
    call_me_now: "ringing their phone",
    reply_to_email: "sending the reply",
    send_email_attachment: "sending the email",
    find_contacts: "looking up the contact",
    save_contact: "saving the contact",
    search_memory: "checking what they told you before",
    list_memories: "checking what they told you before",
    remember_about_them: "noting that down",
    get_place_info: "looking up the place",
    read_url: "reading the page",
    catch_up_on_group: "reading the group",
    send_message_now: "sending the message",
    get_balances: "checking the balances",
    connect_computer: "getting their computer ready",
};

/**
 * One line, in English, for the voice model to put into its own words: what
 * the reply is doing now. "" when the step isn't worth saying. Only what was
 * asked for and where it is being looked — never anything found in it.
 */
export function describeStep(s: Step): string {
    if (s.kind === "search") return s.phase === "start" ? "searching the web" : "";
    if (s.kind === "list") return s.phase === "start" ? `opening ${areaOf(s.server)}` : "";
    if (s.kind === "tool") {
        const what = OUR_TOOLS[String(s.name || "")];
        if (!what) return "";
        return s.phase === "start" ? what : (s.error ? `${what} didn't work, trying to sort it out` : "");
    }
    // A connector call.
    const area = areaOf(s.server, s.name);
    if (s.phase === "done") {
        if (s.error) return `${area} didn't answer properly, working around it`;
        if (typeof s.count === "number") return s.count === 0 ? `nothing found in ${area}, checking further` : `found ${s.count} in ${area}, going through ${s.count === 1 ? "it" : "them"}`;
        return `got it from ${area}, putting the answer together`;
    }
    const name = String(s.name || "").toLowerCase();
    if (area === "their calendar") {
        const day = dayOf(s.args);
        if (/create|insert|add/.test(name)) return `adding it to their calendar${day ? ` on ${day}` : ""}`;
        if (/update|patch|move/.test(name)) return `changing the event in their calendar`;
        if (/delete|remove/.test(name)) return `removing the event from their calendar`;
        const q = queryOf(s.args);
        return `looking in their calendar${day ? ` for ${day}` : ""}${q ? ` for "${q}"` : ""}`;
    }
    if (area === "their mail") {
        if (/send|reply|draft/.test(name)) return /draft/.test(name) ? "writing the draft" : "sending the email";
        if (/get|read|thread|message/.test(name) && !/search|list/.test(name)) return "opening the email";
        const q = queryOf(s.args);
        return `searching their mail${q ? ` for "${q}"` : ""}`;
    }
    if (area === "their computer") return "starting it on their computer";
    return `checking ${area}`;
}

// ---------------------------------------------------------------------------
// When to say it. A spoken "thinking" line, driven by the steps, with a timed
// fallback for a long step that says nothing.

export const STEP_GAP_MS = 3000;        // never two status lines closer than this
export const QUIET_STEP_MS = 4000;      // a step this recent covers the fallback
export const FIRST_FALLBACK_MS = 3000;  // the first "still on it" after the ask started
export const FALLBACK_EVERY_MS = 6000;  // then every so often…
export const MAX_FALLBACKS = 3;         // …this many times at most

export type ProgressState = {
    now: number;
    askStartedAt: number;
    /** When a status line (or the model's own lead-in) was last said. */
    lastSpokenAt: number;
    /** When the last step was reported, 0 for none. */
    lastStepAt: number;
    /** A described step not said yet. */
    pendingStep: boolean;
    /** The model is talking, or they are. */
    speaking: boolean;
    /** The answer is in: no more status lines. */
    resultIn: boolean;
    fallbacks: number;
};

/** Say the pending step, say a timed "still on it", or say nothing. */
export function progressDecision(s: ProgressState): "step" | "fallback" | "none" {
    if (s.resultIn || s.speaking) return "none";
    if (s.now - s.lastSpokenAt < STEP_GAP_MS) return "none";
    if (s.pendingStep) return "step";
    if (s.fallbacks >= MAX_FALLBACKS) return "none";
    if (s.lastStepAt && s.now - s.lastStepAt < QUIET_STEP_MS) return "none";
    const due = s.askStartedAt + FIRST_FALLBACK_MS + s.fallbacks * FALLBACK_EVERY_MS;
    return s.now >= due ? "fallback" : "none";
}

export default { countResults, areaOf, describeStep, progressDecision };

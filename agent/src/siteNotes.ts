// What Gepetel remembers about each site (Phase 9, asked for by the owner on
// 2026-10-14): short notes on how a site behaves or how the person uses it —
// "signs in with Google here", "the sort is under Sort by", "the sign-in
// button looks dead; it works after 5–6 seconds" — and addresses that worked
// ("my trips: /app/trips"), so a job needn't guess them.
//
// A JSON file next to the recipes, readable by the person only. Bounded: ~20
// notes a site, ~300 sites, a note unused for 90 days goes. Never in a note:
// passwords, codes, card or account numbers, what a page showed about the
// person (amounts, names, addresses, messages) — checked before saving.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type NoteSource = "job" | "person" | "review";
export type SiteNote = {
    id: string;
    site: string;
    /** A sentence, or for kind "address", the address's path (no query). */
    text: string;
    kind: "note" | "address";
    source: NoteSource;
    created: string;
    changed: string;
    used: string;
    /** How often it was read by a job (a rough "how useful"). */
    uses: number;
};

export const PER_SITE = 20, SITES = 300, UNUSED_DAYS = 90, NOTE_CHARS = 200;

/** The site a note belongs to: the registrable domain (booking.com, not
 *  secure.booking.com; bbc.co.uk, not www.bbc.co.uk). */
export function siteKey(hostOrUrl: string): string {
    let host = hostOrUrl.trim().toLowerCase();
    try { if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname; } catch { /* as is */ }
    host = host.replace(/^www\./, "").replace(/\.$/, "");
    host = host.replace(/:\d+$/, "");
    if (/^[\d.]+$/.test(host) || !host.includes(".")) return host;   // an IP address, localhost
    const parts = host.split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    // Second-level public suffixes worth knowing (co.uk, com.au…).
    const sl = parts.slice(-2).join(".");
    if (/^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(sl)) return parts.slice(-3).join(".");
    return parts.slice(-2).join(".");
}

/** Why a note can't be kept, or "" when it can: nothing about the person's
 *  account or a secret. A note says how the site works. */
export function unfit(text: string): string {
    const t = text.trim();
    if (!t) return "it's empty";
    if (t.length > NOTE_CHARS) return `it's over ${NOTE_CHARS} characters`;
    if (/\b\d{4,}\b|\d[\d .-]{7,}\d/.test(t)) return "it has a long number in it (an account, card, phone or code?)";
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return "it has an email address in it";
    if (/(password|parol|passwort|pin|cvv|otp|one-time code|cod de verificare)\s*[:=]/i.test(t)) return "it looks like a secret";
    if (/[$€£]\s?\d|\d\s?(lei|ron|eur|usd|chf)\b/i.test(t)) return "it has an amount in it — what a page showed isn't a site note";
    return "";
}

/** An address worth keeping: the path of a page on the site, no query or
 *  fragment (where a form's fields and session ids live). */
export function addressPath(url: string): string {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return "";
        const p = u.pathname.replace(/\/+$/, "") || "/";
        if (p === "/" || p.length > 120 || /\d{6,}|[0-9a-f]{16,}/i.test(p)) return "";   // the front page, or one item's own page
        return p;
    } catch { return ""; }
}

export class SiteNotes {
    private notes: SiteNote[] = [];

    constructor(private file: string | null, private now: () => Date = () => new Date()) {
        try {
            if (file) {
                const raw = JSON.parse(fs.readFileSync(file, "utf8"));
                if (Array.isArray(raw?.notes)) this.notes = raw.notes.filter((n: any) => n && typeof n.text === "string" && typeof n.site === "string");
            }
        } catch { /* none yet */ }
        this.prune();
    }

    /** A site's notes, most useful first: the person's own first, then the
     *  most used, then the newest. */
    forSite(site: string, limit = 10): SiteNote[] {
        const k = siteKey(site);
        const rank = (n: SiteNote) => (n.source === "person" ? 1e6 : 0) + n.uses * 10 + Date.parse(n.changed) / 1e11;
        return this.notes.filter(n => n.site === k).sort((a, b) => rank(b) - rank(a)).slice(0, limit);
    }

    all(): SiteNote[] { return [...this.notes]; }

    /** Read by a job: counted, and its clock for expiry reset. */
    markUsed(ids: string[]): void {
        const t = this.now().toISOString();
        let any = false;
        for (const n of this.notes) if (ids.includes(n.id)) { n.uses++; n.used = t; any = true; }
        if (any) this.save();
    }

    /** Keep a note. Returns why not, or the note. The same text again on a
     *  site refreshes the old one instead of adding. */
    add(site: string, text: string, source: NoteSource, kind: SiteNote["kind"] = "note"): SiteNote | { why: string } {
        const k = siteKey(site);
        if (!k) return { why: "no site" };
        const clean = text.replace(/\s+/g, " ").trim();
        const why = kind === "address" ? (clean.startsWith("/") && clean.length <= 120 ? "" : "not an address path") : unfit(clean);
        if (why) return { why };
        const t = this.now().toISOString();
        const same = this.notes.find(n => n.site === k && n.kind === kind && n.text.toLowerCase() === clean.toLowerCase());
        if (same) { same.changed = t; same.used = t; if (source === "person") same.source = "person"; this.save(); return same; }
        const note: SiteNote = { id: crypto.randomBytes(6).toString("hex"), site: k, text: clean, kind, source, created: t, changed: t, used: t, uses: 0 };
        this.notes.push(note);
        this.prune();
        this.save();
        return note;
    }

    /** Change a note's text (a note that proved wrong). */
    update(id: string, text: string): SiteNote | { why: string } {
        const n = this.notes.find(x => x.id === id);
        if (!n) return { why: "no such note" };
        const clean = text.replace(/\s+/g, " ").trim();
        const why = n.kind === "address" ? "" : unfit(clean);
        if (why) return { why };
        n.text = clean; n.changed = this.now().toISOString();
        this.save();
        return n;
    }

    /** Forget notes: by id, by matching text on a site, or a whole site. */
    forget(match: { id?: string; site?: string; text?: string }): number {
        const before = this.notes.length;
        const k = match.site ? siteKey(match.site) : "";
        const t = (match.text || "").toLowerCase().trim();
        this.notes = this.notes.filter(n => {
            if (match.id) return n.id !== match.id;
            if (k && n.site !== k) return true;
            if (t) return !n.text.toLowerCase().includes(t);
            return !k;   // a whole site
        });
        const gone = before - this.notes.length;
        if (gone) this.save();
        return gone;
    }

    /** Addresses that worked on a site (paths), for a job not to take them
     *  for guesses. */
    addresses(site: string): string[] {
        const k = siteKey(site);
        return this.notes.filter(n => n.site === k && n.kind === "address").map(n => n.text);
    }

    private prune(): void {
        const cutoff = this.now().getTime() - UNUSED_DAYS * 864e5;
        this.notes = this.notes.filter(n => Date.parse(n.used || n.changed) >= cutoff);
        // Per site: the person's notes stay longest; then the most used, the newest.
        const bySite = new Map<string, SiteNote[]>();
        for (const n of this.notes) (bySite.get(n.site) ?? bySite.set(n.site, []).get(n.site)!).push(n);
        const keep = (a: SiteNote, b: SiteNote) => (b.source === "person" ? 1 : 0) - (a.source === "person" ? 1 : 0) || b.uses - a.uses || Date.parse(b.used) - Date.parse(a.used);
        let sites = [...bySite.entries()].map(([s, ns]) => [s, ns.sort(keep).slice(0, PER_SITE)] as const);
        if (sites.length > SITES) {
            const last = (ns: readonly SiteNote[]) => Math.max(...ns.map(n => Date.parse(n.used)));
            sites = sites.sort((a, b) => last(b[1]) - last(a[1])).slice(0, SITES);
        }
        this.notes = sites.flatMap(([, ns]) => ns);
    }

    private save(): void {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ notes: this.notes }, null, 1), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch { /* best effort: a job carries on without */ }
    }
}

// Addresses on the person's own home network they let Gepetel open — their
// Home Assistant, a NAS page (the owner, 2026-10-16: "why cant you connect to
// servers in my local home?"). Private addresses stay refused otherwise: a web
// page could name http://192.168.1.1/admin to steer a job into their router.
// An address is allowed when it comes from them — named in their own words,
// kept here by host and port — never one a page or the model came up with.
// A small JSON file next to the site notes, readable by the person only;
// shown and removable in Manage Memories (Sites).
import fs from "node:fs";
import path from "node:path";

export type HomeHost = { host: string; added: string };

export class HomeHosts {
    private hosts: HomeHost[] = [];
    constructor(private file: string | null, private now: () => Date = () => new Date()) {
        try { if (file) { const j = JSON.parse(fs.readFileSync(file, "utf8")); if (Array.isArray(j?.hosts)) this.hosts = j.hosts.filter((h: any) => typeof h?.host === "string"); } } catch { /* none yet */ }
    }
    /** "homeassistant:8123", "192.168.86.34:8123" — as URL.host gives it, lowercased. */
    static key(host: string): string { return host.trim().toLowerCase().replace(/^\[|\]$/g, ""); }
    has(host: string): boolean { const k = HomeHosts.key(host); return this.hosts.some(h => h.host === k); }
    all(): HomeHost[] { return [...this.hosts]; }
    add(host: string): void {
        const k = HomeHosts.key(host);
        if (!k || this.has(k) || this.hosts.length >= 50) return;
        this.hosts.push({ host: k, added: this.now().toISOString() });
        this.save();
    }
    forget(host: string): boolean {
        const before = this.hosts.length;
        this.hosts = this.hosts.filter(h => h.host !== HomeHosts.key(host));
        if (this.hosts.length !== before) { this.save(); return true; }
        return false;
    }
    private save(): void {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ hosts: this.hosts }, null, 1), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch { /* best effort */ }
    }
}

/** Whether their own words name this host (with its port when it has one). */
export function namedIn(words: string, host: string): boolean {
    const k = HomeHosts.key(host).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !!k && new RegExp(`(^|[^\\w.-])${k}(?=$|[^\\w.-]|/)`, "i").test(words);
}

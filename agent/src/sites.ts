// What the agent remembers about sites between jobs: today, only which ones
// aren't made for phones. Jobs open sites as a phone would (asked for by the
// owner, 2026-10-12: phone layouts are lighter to read and they're what the
// person sees in the takeover); a site that doesn't fit a phone is shown as
// a desktop, and remembered here so the next job opens it that way at once.
//
// A small JSON file next to the recipes. Host names only — nothing a page said.
import fs from "node:fs";
import path from "node:path";

export class SiteMemory {
    private desktopHosts: Set<string>;

    constructor(private file: string | null) {
        let hosts: string[] = [];
        try { if (file) hosts = JSON.parse(fs.readFileSync(file, "utf8"))?.desktop ?? []; } catch { /* none yet */ }
        this.desktopHosts = new Set(hosts.filter(h => typeof h === "string").slice(0, 2000));
    }

    needsDesktop(host: string): boolean { return this.desktopHosts.has(host.toLowerCase()); }

    markDesktop(host: string): void {
        host = host.toLowerCase();
        if (!host || this.desktopHosts.has(host)) return;
        this.desktopHosts.add(host);
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({ desktop: [...this.desktopHosts] }, null, 1), { mode: 0o600 });
        } catch { /* a cache: the next job measures again */ }
    }
}

/** A phone's screen, in CSS pixels; the extension makes a page this narrow a
 *  phone (user agent, mobile layout, touch). */
export const PHONE = { width: 390, height: 844 };

/** In the page: does it fit a phone? A site made for phones declares a
 *  device-width viewport and lays out within the screen. One that doesn't
 *  gets a 980-pixel layout squeezed onto the phone, or runs off its side. */
export const FITS_PHONE = `() => {
  const vp = !!document.querySelector('meta[name=viewport][content*="device-width"]');
  const w = innerWidth, sw = document.documentElement.scrollWidth;
  return { vp, w, sw, fits: vp && w <= ${PHONE.width + 20} && sw <= w + 20 };
}`;

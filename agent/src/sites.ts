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

/** Phone mode: Gepetel's window made phone-wide (the owner's idea — no
 *  emulation, nothing about the page faked). Chrome's narrowest normal
 *  window is 500 px on a Mac (measured), which is a phone's layout for
 *  nearly every site. Desktop: a desktop-sized window. */
export const PHONE = { width: 500, height: 900 };
export const DESKTOP = { width: 1280, height: 900 };
/** A page laid out at least this wide is a desktop view, whatever the zoom. */
export const DESKTOP_FROM = 900;

/** In the page: does it fit a phone-wide window? One that doesn't scrolls
 *  sideways (a desktop layout wider than the window). */
export const FITS_PHONE = `() => {
  const vp = !!document.querySelector('meta[name=viewport][content*="device-width"]');
  const w = innerWidth, sw = document.documentElement.scrollWidth;
  // Not by the width alone: a site zoomed in Chrome (TripIt at 80%) lays a
  // 500 px window out 625 px wide, and fits it.
  return { vp, w, sw, fits: w <= ${DESKTOP_FROM} && sw <= w + 8 };
}`;

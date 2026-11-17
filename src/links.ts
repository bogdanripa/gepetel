// GEP-91: the server reads the links people share, so an unprompted post takes an event's
// date and name from the page itself rather than from the model's memory or a search result.
//
// The cost of fetching a URL that anyone in a group can type is an SSRF surface, and on this
// box it is real: Gepetel shares the dual-stack `coolify` Docker network with Sablier, Postgres
// and the other apps, on 10.0.1.0/24 *and* fddf:6e69:23a7::/48. So the address guard below is
// part of the feature. Three rules carry it:
//   1. An IP literal never goes through `lookup` (Node skips resolution for literals), so it is
//      checked explicitly, brackets and all.
//   2. IPv6 is checked as carefully as IPv4: everything outside 2000::/3 is refused (ULA
//      included), and IPv4 embedded in mapped / NAT64 / 6to4 forms is unwrapped and re-checked.
//   3. The address checked is the address connected to: the request's `lookup` hands back the
//      vetted address, so a second resolution can't rebind it. Every redirect hop is re-checked,
//      and no socket is reused across hops (`agent: false`).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import type { SharedLink } from "./util.js";

export type LinkRead =
    | { url: string; from: string; ok: true; title: string | null; startDate: string | null; endDate: string | null; location: string | null }
    | { url: string; from: string; ok: false; reason: "blocked" | "timeout" | "not-html" | "too-large" | "http-error" | "error" };

type FailReason = Extract<LinkRead, { ok: false }>["reason"];

const PER_LINK_TIMEOUT_MS = 5_000;
const OVERALL_BUDGET_MS = 8_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; Gepetel/1.0; +https://gepetel.com)";

// ---------------------------------------------------------------------------------------------
// Address guard

const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(addr, prefix, "ipv4");

/** 16 bytes of an IPv6 address (including one with a trailing dotted quad), or null. */
function ipv6Bytes(ip: string): number[] | null {
    let s = ip;
    const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
        if (net.isIPv4(v4[2]) === false) return null;
        const o = v4[2].split(".").map(Number);
        s = `${v4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
    const groups = [...head, ...Array(missing).fill("0"), ...tail];
    const bytes: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
        const n = parseInt(g, 16);
        bytes.push(n >> 8, n & 0xff);
    }
    return bytes;
}

const v4Of = (b: number[], at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;
const isPublicV4 = (ip: string) => !BLOCKED_V4.check(ip, "ipv4");

/**
 * True only for a globally routable unicast address. Anything unparseable is not public.
 * IPv6 must be in 2000::/3 (minus documentation and Teredo); IPv4 embedded in a mapped,
 * NAT64 or 6to4 address is judged as the IPv4 address it reaches.
 */
export function isPublicAddress(ip: string): boolean {
    const addr = String(ip ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const family = net.isIP(addr);
    if (family === 4) return isPublicV4(addr);
    if (family !== 6) return false;
    const b = ipv6Bytes(addr);
    if (!b) return false;
    // ::ffff:a.b.c.d — IPv4-mapped.
    if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff) return isPublicV4(v4Of(b, 12));
    // 64:ff9b::a.b.c.d — NAT64 well-known prefix.
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every(x => x === 0)) return isPublicV4(v4Of(b, 12));
    // Everything else must be global unicast, 2000::/3.
    if ((b[0] & 0xe0) !== 0x20) return false;
    // 2001:db8::/32 documentation, 2001::/32 Teredo.
    if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0x0d && b[3] === 0xb8) || (b[2] === 0 && b[3] === 0))) return false;
    // 2002::/16 — 6to4, the IPv4 address sits in bytes 2..5.
    if (b[0] === 0x20 && b[1] === 0x02) return isPublicV4(v4Of(b, 2));
    return true;
}

// ---------------------------------------------------------------------------------------------
// Page metadata

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
        }
        return NAMED_ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Decoded, whitespace-collapsed, capped. Page text goes into a prompt, so it is always bounded. */
function cleanText(s: unknown, cap = 200): string | null {
    if (typeof s !== "string") return null;
    const t = decodeEntities(s).replace(/\s+/g, " ").trim();
    if (!t) return null;
    return t.length > cap ? t.slice(0, cap - 1).trimEnd() + "…" : t;
}

/**
 * Attributes of one opening tag, in a single forward pass. A regex here backtracks over every
 * long run of name characters (`<meta aaaa…>`), which is quadratic in the tag's length.
 */
function attrs(tag: string): Record<string, string> {
    const out: Record<string, string> = {};
    const isName = (c: string) => /[-a-zA-Z0-9_:.]/.test(c);
    const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
    let i = 0;
    const n = tag.length;
    while (i < n) {
        if (!/[a-zA-Z_:]/.test(tag[i])) { i++; continue; }
        const start = i;
        while (i < n && isName(tag[i])) i++;
        const key = tag.slice(start, i).toLowerCase();
        let j = i;
        while (j < n && isSpace(tag[j])) j++;
        if (tag[j] !== "=") continue; // a bare attribute; resume after its name
        j++;
        while (j < n && isSpace(tag[j])) j++;
        const q = tag[j];
        if (q === '"' || q === "'") {
            const close = tag.indexOf(q, j + 1);
            if (close < 0) { i = j + 1; continue; }
            out[key] = tag.slice(j + 1, close);
            i = close + 1;
        } else {
            const vs = j;
            while (j < n && !isSpace(tag[j]) && tag[j] !== '"' && tag[j] !== "'" && tag[j] !== ">") j++;
            if (j > vs) out[key] = tag.slice(vs, j);
            i = Math.max(j, vs + 1);
        }
    }
    return out;
}

const isEventType = (t: unknown) => (Array.isArray(t) ? t : [t]).some(x => typeof x === "string" && /Event$/.test(x));

/** The first Event-typed node, walking top-level arrays, `@graph` and nested values. */
function findEvent(node: unknown, depth = 0): any | null {
    if (depth > 6 || node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
        for (const n of node) { const f = findEvent(n, depth + 1); if (f) return f; }
        return null;
    }
    const obj = node as Record<string, unknown>;
    if (isEventType(obj["@type"])) return obj;
    for (const [k, v] of Object.entries(obj)) {
        if (k === "@context") continue;
        const f = findEvent(v, depth + 1);
        if (f) return f;
    }
    return null;
}

function locationText(loc: unknown): string | null {
    const first = Array.isArray(loc) ? loc[0] : loc;
    if (typeof first === "string") return cleanText(first);
    if (!first || typeof first !== "object") return null;
    const l = first as Record<string, any>;
    const parts: string[] = [];
    const push = (v: unknown) => {
        const t = cleanText(v, 120);
        if (t && !parts.some(p => p.toLowerCase() === t.toLowerCase())) parts.push(t);
    };
    push(l.name);
    if (typeof l.address === "string") push(l.address);
    else if (l.address && typeof l.address === "object") {
        push(l.address.streetAddress);
        push(l.address.addressLocality);
        push(l.address.addressCountry?.name ?? l.address.addressCountry);
    }
    return parts.length ? cleanText(parts.join(", ")) : null;
}

/** ASCII-only lower-casing: keeps every index aligned with the original, unlike `toLowerCase()`. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, c => c.toLowerCase());

/** An opening tag longer than this is not a real `<script>`/`<meta>`/`<title>` tag; it is skipped. */
const MAX_TAG = 8192;

/**
 * Every `<name …>` tag (and, with `close`, its content up to `</name…>`) in one forward pass.
 *
 * Linear on purpose. A regex like `/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g` rescans to the end
 * of the document from every unclosed tag, which is O(n²): 800 KB of `<script ` took 35 s, all of
 * it synchronous on the event loop and out of reach of any request timeout. Here each search only
 * moves forward, and a missing `>` or closing tag ends the scan, because nothing later can close
 * either.
 */
function* scanTags(src: string, lower: string, name: string, close: boolean): Generator<{ tag: string; inner: string }> {
    const open = "<" + name;
    const end = "</" + name;
    let pos = 0;
    for (;;) {
        const at = lower.indexOf(open, pos);
        if (at < 0) return;
        const after = at + open.length;
        // `\b`: `<scripts>` or `<metadata>` is a different tag.
        if (after < lower.length && /[a-z0-9_-]/.test(lower[after])) { pos = after; continue; }
        const gt = lower.indexOf(">", after);
        if (gt < 0) return;
        let next = gt + 1;
        let inner = "";
        if (close) {
            const ce = lower.indexOf(end, next);
            if (ce < 0) return;
            const cgt = lower.indexOf(">", ce + end.length);
            if (cgt < 0) return;
            inner = src.slice(next, ce);
            next = cgt + 1;
        }
        if (gt - at <= MAX_TAG) yield { tag: src.slice(at, gt + 1), inner };
        pos = next;
    }
}

/**
 * Title, dates and place from a page's HTML. A date only ever comes from structured data
 * (JSON-LD `startDate`), never from body text, `article:published_time` or the title.
 * Runs synchronously on the event loop, so every scan here is linear in the page size.
 */
export function parsePageMeta(html: string): { title: string | null; startDate: string | null; endDate: string | null; location: string | null } {
    const src = String(html ?? "");
    const lower = asciiLower(src);
    let event: any = null;
    for (const { tag, inner } of scanTags(src, lower, "script", true)) {
        if (!/^application\/ld\+json$/i.test((attrs(tag.slice(7, -1)).type ?? "").trim())) continue;
        try {
            const body = inner.trim().replace(/^<!--/, "").replace(/-->$/, "");
            event = findEvent(JSON.parse(body));
        } catch { continue; } // malformed JSON-LD is skipped, not fatal
        if (event) break;
    }

    let title = event ? cleanText(event.name) : null;
    if (!title) {
        for (const { tag } of scanTags(src, lower, "meta", false)) {
            const a = attrs(tag);
            if ((a.property ?? a.name ?? "").toLowerCase() === "og:title") { title = cleanText(a.content); if (title) break; }
        }
    }
    if (!title) {
        for (const { inner } of scanTags(src, lower, "title", true)) { title = cleanText(inner); break; }
    }

    const date = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : null);
    return {
        title,
        startDate: event ? date(event.startDate) : null,
        endDate: event ? date(event.endDate) : null,
        location: event ? locationText(event.location) : null,
    };
}

// ---------------------------------------------------------------------------------------------
// Prompt block

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type WallClock = { y: number; mo: number; d: number; time: { h: number; mi: number } | null; offsetMin: number | null; offsetLabel: string | null };

/** The wall clock *as written* in an ISO string — never re-expressed in the server's timezone. */
function parseWallClock(s: string): WallClock | null {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/);
    if (!m) return null;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    if (m[4] === undefined) return { y, mo, d, time: null, offsetMin: null, offsetLabel: null };
    const h = +m[4], mi = +m[5];
    if (h > 23 || mi > 59) return null;
    let offsetMin: number | null = null, offsetLabel: string | null = null;
    if (m[6] === "Z") { offsetMin = 0; offsetLabel = "UTC"; }
    else if (m[6]) {
        const o = m[6].replace(":", "");
        offsetMin = (o[0] === "-" ? -1 : 1) * (+o.slice(1, 3) * 60 + +o.slice(3, 5));
        offsetLabel = `UTC${o.slice(0, 3)}:${o.slice(3, 5)}`;
    }
    return { y, mo, d, time: { h, mi }, offsetMin, offsetLabel };
}

/** Re-express `w` at `offsetMin` (used only to put an end time in the start's offset). */
function shiftTo(w: WallClock, offsetMin: number): WallClock {
    const t = Date.UTC(w.y, w.mo - 1, w.d, w.time!.h, w.time!.mi) - (w.offsetMin ?? 0) * 60_000 + offsetMin * 60_000;
    const x = new Date(t);
    return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), time: { h: x.getUTCHours(), mi: x.getUTCMinutes() }, offsetMin, offsetLabel: null };
}

const dayText = (w: WallClock) => `${WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]} ${w.d} ${MONTHS[w.mo - 1]} ${w.y}`;
const timeText = (w: WallClock) => `${String(w.time!.h).padStart(2, "0")}:${String(w.time!.mi).padStart(2, "0")}`;

function dateLine(startDate: string, endDate: string | null): string {
    const start = parseWallClock(startDate);
    if (!start) return `${cleanText(startDate, 64)} (as stated on the page)`;
    if (!start.time) return `${dayText(start)} (as stated on the page)`;
    let end = endDate ? parseWallClock(endDate) : null;
    if (end && (!end.time || (end.offsetMin === null) !== (start.offsetMin === null))) end = null;
    if (end && start.offsetMin !== null && end.offsetMin !== start.offsetMin) end = shiftTo(end, start.offsetMin);
    let text = `${dayText(start)}, ${timeText(start)}`;
    if (end) text += end.y === start.y && end.mo === start.mo && end.d === start.d ? `–${timeText(end)}` : ` – ${dayText(end)}, ${timeText(end)}`;
    return `${text} (${start.offsetLabel ? `${start.offsetLabel}, ` : ""}as stated on the page)`;
}

/** A URL without its query string or fragment — a query can carry a token, as in the logs. */
export function displayUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return String(url).split(/[?#]/)[0];
    }
}

/** The links block for the gossip prompt. "(none)" when there is nothing to show. */
export function formatLinksBlock(reads: LinkRead[]): string {
    if (!reads?.length) return "(none)";
    return reads.map(r => {
        const lines = [`- ${cleanText(r.from, 80) ?? "Someone"} shared ${displayUrl(r.url)}`];
        if (!r.ok) lines.push("  could not be read");
        else {
            if (r.title) lines.push(`  title: ${r.title}`);
            lines.push(`  date: ${r.startDate ? dateLine(r.startDate, r.endDate) : "not stated"}`);
            if (r.location) lines.push(`  place: ${r.location}`);
        }
        return lines.join("\n");
    }).join("\n");
}

// ---------------------------------------------------------------------------------------------
// Fetch

class ReadFail extends Error {
    constructor(public reason: FailReason) { super(reason); }
}

// Test-only seam (GEP-96): origins ("http://127.0.0.1:1234") whose requests skip the address and
// port checks, so the fetch path can be exercised against a local server. A module-level setter
// rather than an env var, so nothing in production configuration can switch the guard off.
let trustedOrigins = new Set<string>();
let perLinkTimeoutMs = PER_LINK_TIMEOUT_MS;
export function __setTestOverrides(o: { trustedOrigins?: string[]; timeoutMs?: number } = {}): void {
    trustedOrigins = new Set(o.trustedOrigins ?? []);
    perLinkTimeoutMs = o.timeoutMs ?? PER_LINK_TIMEOUT_MS;
}

/** Scheme, credentials, port and address checks for one hop; returns the vetted address to connect to. */
async function vet(u: URL): Promise<{ address: string; family: 4 | 6 } | null> {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new ReadFail("blocked");
    if (u.username || u.password) throw new ReadFail("blocked");
    if (trustedOrigins.has(u.origin)) return null; // test seam: connect normally
    if (!["", "80", "443"].includes(u.port)) throw new ReadFail("blocked");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const literal = net.isIP(host);
    if (literal) {
        // Node never calls `lookup` for a literal, so this check is the only one it gets.
        if (!isPublicAddress(host)) throw new ReadFail("blocked");
        return { address: host, family: literal as 4 | 6 };
    }
    let addrs: dns.LookupAddress[];
    try { addrs = await dns.promises.lookup(host, { all: true }); }
    catch { throw new ReadFail("error"); }
    if (!addrs.length || addrs.some(a => !isPublicAddress(a.address))) throw new ReadFail("blocked");
    return { address: addrs[0].address, family: addrs[0].family as 4 | 6 };
}

type Hop = { status: number; headers: http.IncomingHttpHeaders; res: http.IncomingMessage };

function request(u: URL, vetted: { address: string; family: 4 | 6 } | null, signal: AbortSignal): Promise<Hop> {
    const mod = u.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
        const req = mod.request(u, {
            method: "GET",
            agent: false, // no pooled socket: one connected elsewhere must never serve this hop
            signal,
            headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate, br" },
            // The address checked is the address used: hand back the vetted one, never re-resolve.
            ...(vetted ? {
                lookup: ((_h: string, opts: any, cb: any) => {
                    if (opts?.all) cb(null, [{ address: vetted.address, family: vetted.family }]);
                    else cb(null, vetted.address, vetted.family);
                }) as any,
            } : {}),
        }, res => resolve({ status: res.statusCode ?? 0, headers: res.headers, res }));
        req.on("error", reject);
        req.end();
    });
}

function readBody(hop: Hop): Promise<string> {
    return new Promise((resolve, reject) => {
        const enc = String(hop.headers["content-encoding"] ?? "").trim().toLowerCase();
        let stream: NodeJS.ReadableStream = hop.res;
        let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
        if (enc === "gzip" || enc === "x-gzip") decoder = zlib.createGunzip();
        else if (enc === "deflate") decoder = zlib.createInflate();
        else if (enc === "br") decoder = zlib.createBrotliDecompress();
        else if (enc && enc !== "identity") return reject(new ReadFail("error"));
        if (decoder) { hop.res.on("error", reject); stream = hop.res.pipe(decoder); }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
                hop.res.destroy();
                decoder?.destroy();
                reject(new ReadFail("too-large"));
                return;
            }
            chunks.push(c);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve(new TextDecoder("utf-8").decode(Buffer.concat(chunks))));
    });
}

async function readOne(link: SharedLink): Promise<LinkRead> {
    const base = { url: String(link?.url ?? ""), from: String(link?.from ?? "") };
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, perLinkTimeoutMs);
    const aborted = new Promise<never>((_, reject) => ctrl.signal.addEventListener("abort", () => reject(new ReadFail("timeout")), { once: true }));
    aborted.catch(() => {});
    // A promise that loses the race must not reject unobserved later and take the process down.
    const race = <T>(p: Promise<T>): Promise<T> => { p.catch(() => {}); return Promise.race([p, aborted]); };
    let hop: Hop | null = null;
    try {
        let u: URL;
        try { u = new URL(base.url); } catch { throw new ReadFail("error"); }
        for (let redirects = 0; ; redirects++) {
            const vetted = await race(vet(u));
            hop = await race(request(u, vetted, ctrl.signal));
            if ([301, 302, 303, 307, 308].includes(hop.status) && hop.headers.location) {
                hop.res.destroy();
                if (redirects >= MAX_REDIRECTS) throw new ReadFail("http-error");
                try { u = new URL(String(hop.headers.location), u); } catch { throw new ReadFail("error"); }
                continue;
            }
            break;
        }
        if (hop.status < 200 || hop.status > 299) throw new ReadFail("http-error");
        const type = String(hop.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "text/html" && type !== "application/xhtml+xml") throw new ReadFail("not-html");
        if (Number(hop.headers["content-length"]) > MAX_BODY_BYTES) throw new ReadFail("too-large");
        const html = await race(readBody(hop));
        return { ...base, ok: true, ...parsePageMeta(html) };
    } catch (e) {
        const reason: FailReason = timedOut ? "timeout" : e instanceof ReadFail ? e.reason : "error";
        return { ...base, ok: false, reason };
    } finally {
        clearTimeout(timer);
        hop?.res.destroy();
        ctrl.abort();
    }
}

/**
 * The one log line per group (GEP-91 rule 5): host and outcome only — never a path, query,
 * title or anything read from the page. e.g. `luma.com ok (titled, dated); example.org could
 * not be read (timeout)`.
 */
export function linksLogLine(reads: LinkRead[]): string {
    return (reads ?? []).map(r => {
        let host = "(bad url)";
        try { host = new URL(r.url).host.toLowerCase(); } catch { /* keep the placeholder */ }
        if (!r.ok) return `${host} could not be read (${r.reason})`;
        return `${host} ok (${r.title ? "titled" : "untitled"}, ${r.startDate ? "dated" : "undated"})`;
    }).join("; ");
}

/** Read each shared link, in parallel, behind the address guard. Never throws. */
export async function readLinks(links: SharedLink[]): Promise<LinkRead[]> {
    const list = Array.isArray(links) ? links : [];
    return Promise.all(list.map(link => {
        let timer: NodeJS.Timeout;
        const budget = new Promise<LinkRead>(resolve => {
            timer = setTimeout(() => resolve({ url: String(link?.url ?? ""), from: String(link?.from ?? ""), ok: false, reason: "timeout" }), OVERALL_BUDGET_MS);
        });
        return Promise.race([readOne(link).catch((): LinkRead => ({ url: String(link?.url ?? ""), from: String(link?.from ?? ""), ok: false, reason: "error" })), budget])
            .finally(() => clearTimeout(timer));
    }));
}

export default { isPublicAddress, parsePageMeta, formatLinksBlock, readLinks, displayUrl, linksLogLine };

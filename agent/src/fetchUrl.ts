// `fetch_url` — read a page on the Mac and hand back only what was asked for.
//
// The point is not that the Mac can fetch a URL; Gepetel's server already can
// (`read_url`). The point is **what comes back**. `read_url` sends the whole
// page's text into the model, so a 50 KB article is a 50 KB prompt, every time,
// and the answer is somewhere in the middle of it. Here the page is fetched,
// parsed and *ranked* on the Mac, and the model is handed a title plus the
// handful of passages that match the question — 3,000 characters by default.
// No model is involved in that choice (BM25, below), so the saving is real
// rather than moved.
//
// Two things shape the rest of the file:
//
//  - **The Mac is inside someone's home network.** A page can ask the model to
//    fetch another URL, so a tool that fetches whatever it is handed is a way
//    into the router's admin page from the public internet. Every destination
//    is checked against the private ranges, and every redirect hop is checked
//    again — see `guardUrl` and `get`.
//  - **Everything a page says is untrusted text.** It comes back as a tool
//    result and nothing else; it is never spliced into instructions.
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";

export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 5_000_000;
/** What the model gets back, in characters. The spec's budget, not a guess. */
export const DEFAULT_MAX_CHARS = 3000;
export const MAX_MAX_CHARS = 12_000;
const MIN_MAX_CHARS = 500;
const MAX_REDIRECTS = 5;
/** Big enough to hold a thought, small enough that ten of them fit the budget. */
const CHUNK_CHARS = 800;

export type FetchArgs = {
    url?: unknown; query?: unknown; max_chars?: unknown;
    /** Tests only, never set by the tool path: lets a fixture server on
     *  127.0.0.1 be fetched. It permits **loopback and nothing else**, so the
     *  home-network guard — including the guard on every redirect hop — stays
     *  under test rather than being switched off by the thing testing it. */
    allowLoopback?: boolean;
};

export type FetchResult = { ok: boolean; content: string; chars?: number; rawChars?: number };

// ---------------------------------------------------------------------------
// Where we are allowed to go

function isLoopback(ip: string): boolean {
    const bare = ip.toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");
    if (bare === "::1") return true;
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return net.isIPv4(bare) ? bare.startsWith("127.") : !!mapped && mapped[1].startsWith("127.");
}

function isPrivateAddress(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;          // link-local, incl. cloud metadata
        if (a === 100 && b >= 64 && b <= 127) return true; // carrier NAT
        if (a >= 224) return true;                         // multicast and up
        return false;
    }
    const ip6 = ip.toLowerCase().split("%")[0];
    if (ip6 === "::1" || ip6 === "::") return true;
    if (ip6.startsWith("fe80") || ip6.startsWith("fc") || ip6.startsWith("fd")) return true;
    // ::ffff:10.0.0.1 and friends: an IPv4 address wearing a v6 hat.
    const mapped = ip6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
}

/**
 * Decide whether a URL may be fetched at all.
 *
 * DNS is resolved here rather than left to fetch, because a hostname is not a
 * destination: `router.example.com` can resolve to 192.168.1.1, and a check
 * that only looks at the string would wave it through. (A name that changes its
 * answer between this lookup and the connection could still slip past — closing
 * that needs a pinned-IP dispatcher, which is a Phase 4 concern along with the
 * real browser.)
 */
export async function guardUrl(raw: string, allowLoopback = false): Promise<{ url: URL } | { why: string }> {
    let url: URL;
    try { url = new URL(String(raw)); } catch { return { why: "that is not a URL I can open" }; }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        // file: would read the Mac's disk, which is the one thing this tool
        // must never do — the sandbox exists for local work.
        return { why: `I can only open http and https links, not ${url.protocol.replace(":", "")}` };
    }
    if (url.username || url.password) return { why: "I won't open a link with a password in it" };
    const PRIVATE = "that address is inside a private network, so I won't open it";
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
        if (allowLoopback && isLoopback(host)) return { url };
        return isPrivateAddress(host) ? { why: PRIVATE } : { url };
    }
    if (/\.(local|internal|localhost|home|lan)$/i.test(host) || host === "localhost") {
        return allowLoopback && (host === "localhost") ? { url } : { why: PRIVATE };
    }
    let addrs: { address: string }[];
    try { addrs = await dns.lookup(host, { all: true }); }
    catch { return { why: `I couldn't find ${host}` }; }
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) {
        return { why: PRIVATE };
    }
    return { url };
}

// ---------------------------------------------------------------------------
// Fetching

/** The installed Chrome's own UA where we can read its version, so a site that
 *  varies by browser sees the browser this person actually has. */
let cachedUA: string | null = null;
export function userAgent(): string {
    if (cachedUA) return cachedUA;
    let version = "141.0.0.0";
    try {
        const plist = fs.readFileSync(
            "/Applications/Google Chrome.app/Contents/Info.plist", "utf8");
        const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([\d.]+)<\/string>/);
        if (m) version = m[1].split(".").slice(0, 3).join(".") + ".0";
    } catch { /* no Chrome, or a plist we can't read: the default stands */ }
    cachedUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    return cachedUA;
}

/**
 * GET the page, following redirects **by hand**.
 *
 * `fetch` follows them itself, and that would make the guard above decorative:
 * a public URL that 302s to 192.168.1.1 would be fetched without anything
 * checking the second address. So each hop is guarded in turn.
 */
async function get(start: URL, allowLoopback: boolean, deadline: number):
        Promise<{ res: Response; url: URL }> {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("timeout");
        const res = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(left),
            headers: {
                "user-agent": userAgent(),
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
                "accept-language": "en,ro;q=0.9",
            },
        });
        if (res.status < 300 || res.status > 399) return { res, url };
        const to = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!to) return { res, url };
        const next = new URL(to, url);
        const check = await guardUrl(next.href, allowLoopback);
        if ("why" in check) throw new Error(`redirect refused: ${check.why}`);
        url = check.url;
    }
    throw new Error("too many redirects");
}

/** Read the body with a hard byte cap, so a stream that never ends cannot fill
 *  the Mac's memory. Truncating mid-document is fine: the parser below is happy
 *  with a partial page, and a 5 MB article does not exist. */
async function readCapped(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        parts.push(value);
        size += value.byteLength;
        if (size >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
    }
    const buf = Buffer.concat(parts.map(p => Buffer.from(p)), Math.min(size, MAX_BYTES));
    const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
    const enc = (charset || "utf-8").toLowerCase();
    try { return new TextDecoder(enc).decode(buf); }
    catch { return buf.toString("utf8"); }
}

// ---------------------------------------------------------------------------
// Turning a page into passages

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
// Images carry no information once the page is text, and their URLs are long.
turndown.addRule("drop-images", { filter: ["img", "picture", "figure"], replacement: () => "" });
// Links keep their text and lose their target. Measured on the English
// Wikipedia article for Raspberry Pi: a single linked phrase costs ~90
// characters as `[random-access memory](https://en.wikipedia.org/wiki/Random-access_memory "Random-access memory")`
// and two words of it are content — so on a wiki page roughly half the budget
// was being spent on URLs the model cannot use without fetching them anyway.
// Anchor text that IS a URL survives, because then the URL is the content.
turndown.addRule("link-text-only", {
    filter: ["a"],
    replacement: (content: string) => content,
});
// Citation markers: [\[139\]](#cite_note-143) in markdown, pure noise in prose.
turndown.addRule("drop-citations", { filter: ["sup"], replacement: () => "" });

export function extract(html: string, url: string): { title: string; markdown: string } {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;
    const docTitle = doc.title || "";
    let article: { title?: string | null; content?: string | null; textContent?: string | null } | null = null;
    try { article = new Readability(doc).parse(); } catch { article = null; }
    // Readability gives up on pages that are not articles — a dashboard, a
    // search result, a wiki index. Falling back to the body's own text is worse
    // prose and better than nothing, and the ranking below does not care which
    // of the two it got.
    const html2 = article?.content || doc.body?.innerHTML || "";
    let markdown = turndown.turndown(html2).replace(/\n{3,}/g, "\n\n").trim();
    if (!markdown) markdown = (article?.textContent || doc.body?.textContent || "").trim();
    return { title: (article?.title || docTitle || "").trim(), markdown };
}

export type Chunk = { heading: string; text: string; at: number };

/**
 * Split the markdown into passages that each stand on their own.
 *
 * Headings are boundaries and are also carried along: a passage labelled
 * "Pricing > Teams" tells the model where in the page it came from, which is the
 * difference between a quote it can use and a quote it has to hedge about.
 */
export function chunk(markdown: string): Chunk[] {
    const out: Chunk[] = [];
    const path: string[] = [];
    let buf: string[] = [];
    let at = 0;
    const flush = () => {
        const text = buf.join("\n\n").trim();
        buf = [];
        // filter(Boolean): Readability lifts a page's <h1> into the title, so
        // the first heading in the markdown is usually an <h2> and level 1 is
        // never filled. Joining a sparse path put a bare " > " in front of every
        // label on such a page.
        if (text) out.push({ heading: path.filter(Boolean).join(" > "), text, at: at++ });
    };
    for (const block of markdown.split(/\n{2,}/)) {
        const h = /^(#{1,6})\s+(.*)$/.exec(block.trim());
        if (h) {
            flush();
            const depth = h[1].length;
            path.length = Math.min(path.length, depth - 1);
            path[depth - 1] = h[2].trim();
            continue;
        }
        buf.push(block.trim());
        if (buf.join("\n\n").length >= CHUNK_CHARS) flush();
    }
    flush();
    return out;
}

// ---------------------------------------------------------------------------
// Ranking: BM25, no model

// Diacritics are folded, so a question typed "intalnire" finds "întâlnire" —
// which is most questions, in this chat.
function tokens(s: string): string[] {
    return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
        .split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t));
}

const STOP = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had",
    "her", "was", "one", "our", "out", "has", "with", "that", "this", "from",
    "what", "when", "which", "does", "did", "how", "who", "why", "about",
    "si", "sa", "de", "la", "cu", "ce", "in", "pe", "un", "una", "este", "sunt",
    "pentru", "care", "din", "mai", "cum", "despre", "sau", "lui", "ale",
]);

const K1 = 1.5, B = 0.75;

/** Chunk indices, best first. An empty array means nothing matched at all. */
export function rank(chunks: Chunk[], query: string): { at: number; score: number }[] {
    const terms = [...new Set(tokens(query))];
    if (!terms.length || !chunks.length) return [];
    const docs = chunks.map(c => tokens(c.heading + " " + c.text));
    const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const t of terms) df.set(t, docs.filter(d => d.includes(t)).length);
    const scored = docs.map((d, i) => {
        let score = 0;
        for (const t of terms) {
            const n = df.get(t) || 0;
            if (!n) continue;
            const tf = d.filter(w => w === t).length;
            if (!tf) continue;
            const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
            score += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.length / avg)));
        }
        return { at: i, score };
    }).filter(s => s.score > 0);
    return scored.sort((a, b) => b.score - a.score || a.at - b.at);
}

// ---------------------------------------------------------------------------
// What the model actually receives

function cut(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, Math.max(0, max - 14)).trimEnd() + " …[truncated]";
}

/** Title, then the matching passages in page order — or the outline and the
 *  opening when there is no question to match against. */
export function compose(
    title: string, chunks: Chunk[], query: string, maxChars: number,
): { text: string; matched: boolean } {
    const head = title ? `# ${title}\n` : "";
    const budget = Math.max(MIN_MAX_CHARS, maxChars) - head.length;

    const hits = query ? rank(chunks, query) : [];
    if (query && hits.length) {
        const picked: Chunk[] = [];
        let used = 0;
        for (const h of hits) {
            const c = chunks[h.at];
            const cost = c.text.length + c.heading.length + 6;
            if (used + cost > budget && picked.length) break;
            picked.push(c);
            used += cost;
            if (used >= budget) break;
        }
        picked.sort((a, b) => a.at - b.at);
        const body = picked.map(c => (c.heading ? `[${c.heading}]\n` : "") + c.text).join("\n\n");
        return { text: head + cut(body, budget), matched: true };
    }

    // No query, or nothing in the page matched it. The outline is cheap and
    // tells the model what the page even is, which is usually enough for it to
    // ask a better question.
    const outline = [...new Set(chunks.map(c => c.heading.split(" > ").pop() || "")
        .filter(Boolean))].slice(0, 12);
    const lead = chunks.map(c => c.text).join("\n\n");
    const note = query ? "(nothing on the page matched that, so here is the start of it)\n" : "";
    const sections = outline.length ? `Sections: ${outline.join(" · ")}\n\n` : "";
    const rest = budget - note.length - sections.length;
    return { text: head + note + sections + cut(lead, Math.max(MIN_MAX_CHARS, rest)), matched: false };
}

// ---------------------------------------------------------------------------

const READABLE = /^(text\/html|application\/xhtml|text\/plain|text\/markdown|application\/xml|text\/xml|application\/json)/i;

function typeExcuse(contentType: string): string {
    const t = contentType.split(";")[0].trim().toLowerCase();
    if (t === "application/pdf") return "That link is a PDF — I can't read those yet.";
    if (t.startsWith("image/")) return "That link is an image, not a page I can read.";
    if (t.startsWith("audio/") || t.startsWith("video/")) return "That link is a media file, not a page I can read.";
    return `I can't read that kind of file yet (${t || "unknown type"}).`;
}

/**
 * The tool. Never throws: a failure is a result the model has to read and say
 * something sensible about, so it comes back as `ok:false` with a plain reason.
 */
export async function fetchUrl(args: FetchArgs): Promise<FetchResult> {
    const wanted = Number(args.max_chars);
    const maxChars = Math.min(MAX_MAX_CHARS,
        Math.max(MIN_MAX_CHARS, Number.isFinite(wanted) && wanted > 0 ? wanted : DEFAULT_MAX_CHARS));
    const query = typeof args.query === "string" ? args.query.trim() : "";

    const guard = await guardUrl(String(args.url ?? ""), !!args.allowLoopback);
    if ("why" in guard) return { ok: false, content: guard.why };

    const deadline = Date.now() + TIMEOUT_MS;
    let res: Response, url: URL;
    try {
        ({ res, url } = await get(guard.url, !!args.allowLoopback, deadline));
    } catch (e: any) {
        const why = e?.name === "TimeoutError" || /timeout/i.test(String(e?.message))
            ? `${guard.url.hostname} didn't answer within ${TIMEOUT_MS / 1000}s`
            : `I couldn't reach ${guard.url.hostname} (${e?.message || e})`;
        return { ok: false, content: why };
    }
    if (res.status >= 400) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, content: `${url.hostname} answered ${res.status} for that page.` };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!READABLE.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, content: typeExcuse(contentType) };
    }

    let raw: string;
    try { raw = await readCapped(res); }
    catch (e: any) { return { ok: false, content: `The page stopped mid-download (${e?.message || e}).` }; }
    if (!raw.trim()) return { ok: false, content: `${url.hostname} returned an empty page.` };

    const isHtml = /html|xml/i.test(contentType);
    const { title, markdown } = isHtml ? extract(raw, url.href) : { title: "", markdown: raw.trim() };
    if (!markdown) return { ok: false, content: "I opened the page but found no readable text on it." };

    const { text, matched } = compose(title, chunk(markdown), query, maxChars);
    // The two numbers the spec asks to be logged for the first 50 calls: what a
    // whole-page read would have cost the model, and what this cost instead.
    console.log(`fetch_url ${url.href} → ${text.length} chars from ${markdown.length}` +
        `${query ? ` (query ${matched ? "matched" : "found nothing"})` : ""}`);
    return { ok: true, content: text, chars: text.length, rawChars: markdown.length };
}

export default { fetchUrl, guardUrl, extract, chunk, rank, compose, userAgent,
    TIMEOUT_MS, MAX_BYTES, DEFAULT_MAX_CHARS, MAX_MAX_CHARS };

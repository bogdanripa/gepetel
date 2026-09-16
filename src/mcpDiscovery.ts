// Finding a service's MCP server without asking the person for a URL.
//
// "Connect TripIt" should not turn into "what is the MCP server URL?" — nobody
// outside this codebase knows what that means. So the server is looked for, in
// this order, and only a dead end goes back to the person:
//
//   1. the curated list (mcpRegistry.ts) — checked live, as before;
//   2. the official MCP registry (registry.modelcontextprotocol.io), for
//      entries whose remote URL sits on the service's own domain;
//   3. the addresses services conventionally use, on that same domain
//      (mcp.<domain>/mcp and friends), each probed with a real handshake;
//   4. a URL the model found in the service's own documentation — accepted
//      only if it is on the service's domain and answers the handshake.
//
// The rule underneath all four: a login is about to be handed to that address,
// so it must be the service's own. A community mirror, a per-user gateway, or
// a guess that merely returns 200 is never picked up on someone's behalf.
import axios from "axios";
import mcp from "./mcp.js";
import registry from "./mcpRegistry.js";

export const OFFICIAL_REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

export type Discovered = {
    url: string;
    source: "known" | "registry" | "convention" | "found_online";
    name: string;               // what to call it
    tried: string[];            // every address probed, for the log and the model
};

// "www.tripit.com" → "tripit.com"; "mcp.atlassian.com" → "atlassian.com";
// "foo.co.uk" → "foo.co.uk". A rough public-suffix rule is enough here: the
// point is to compare a candidate host against the service's own domain.
export function registrableDomain(hostOrUrl: string): string {
    let host = String(hostOrUrl || "").trim().toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) { try { host = new URL(host).hostname; } catch { return ""; } }
    host = host.replace(/^www\./, "").replace(/\.$/, "").replace(/:\d+$/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return "";
    const parts = host.split(".");
    const second = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);
    if (parts.length >= 3 && second.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) {
        return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
}

// Is this URL on the service's own domain (or a subdomain of it)?
export function onDomain(url: string, domain: string): boolean {
    const d = registrableDomain(domain);
    let host = "";
    try { const p = new URL(String(url || "")); if (p.protocol !== "https:") return false; host = p.hostname.toLowerCase(); } catch { return false; }
    return !!d && (host === d || host.endsWith("." + d));
}

// The official registry names servers by a DNS-verified reverse domain:
// "com.atlassian/atlassian-mcp-server" was published by whoever controls
// atlassian.com. "io.github.someone/x" is a GitHub user, not a company.
export function namespaceDomain(registryName: string): string {
    const ns = String(registryName || "").split("/")[0].toLowerCase();
    const parts = ns.split(".").filter(Boolean);
    if (parts.length < 2) return "";
    return parts.reverse().join(".");
}

// Where services put their MCP servers, most-common first.
export function candidateUrls(domain: string): string[] {
    const d = registrableDomain(domain);
    if (!d) return [];
    return [
        `https://mcp.${d}/mcp`,
        `https://mcp.${d}`,
        `https://mcp.${d}/v1/mcp`,
        `https://mcp.${d}/v1`,
        `https://api.${d}/mcp`,
        `https://${d}/mcp`,
        `https://${d}/api/mcp`,
        `https://mcp.${d}/sse`,
    ];
}

type RegistryFetch = (query: string) => Promise<any>;

async function fetchRegistry(query: string): Promise<any> {
    const res = await axios.get(OFFICIAL_REGISTRY, {
        params: { search: query, limit: 30 },
        timeout: 8_000,
        validateStatus: () => true,
    });
    return res.status === 200 ? res.data : null;
}

// Remote URLs from the official registry that sit on the service's domain.
// Streamable HTTP before SSE; latest versions before older ones; an entry
// published under the service's own namespace before anyone else's.
export async function searchOfficialRegistry(query: string, domain: string, fetch: RegistryFetch = fetchRegistry): Promise<string[]> {
    let data: any = null;
    try { data = await fetch(query); } catch { return []; }
    const servers: any[] = Array.isArray(data?.servers) ? data.servers : [];
    const d = registrableDomain(domain);
    if (!d) return [];
    const scored: { url: string; score: number }[] = [];
    for (const entry of servers) {
        const srv = entry?.server || entry || {};
        const official = entry?._meta?.["io.modelcontextprotocol.registry/official"] || {};
        if (official.status && official.status !== "active") continue;
        const ownNamespace = namespaceDomain(srv.name) === d;
        for (const r of (Array.isArray(srv.remotes) ? srv.remotes : [])) {
            const url = String(r?.url || "").trim();
            if (!onDomain(url, d)) continue;
            let score = 0;
            if (ownNamespace) score += 100;
            if (official.isLatest) score += 10;
            if (!/\/sse\/?$/.test(url) && String(r?.type || "") !== "sse") score += 5;
            scored.push({ url, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    const out: string[] = [];
    for (const s of scored) if (!out.includes(s.url)) out.push(s.url);
    return out;
}

type Probe = (url: string) => Promise<boolean>;

// The ladder. `domain` is the service's own website domain, as the model
// knows it ("tripit.com"); without it only the curated list is consulted.
export async function discoverMcpServer(
    label: string,
    domain: string,
    deps: { probe?: Probe; fetch?: RegistryFetch } = {}
): Promise<Discovered | null> {
    const probe = deps.probe || mcp.reachable;
    const tried: string[] = [];
    const check = async (url: string) => { tried.push(url); return probe(url); };

    const known = registry.findKnownMcpServer(label);
    if (known) {
        for (const url of known.urls) if (await check(url)) return { url, source: "known", name: known.name, tried };
    }

    const d = registrableDomain(domain);
    if (!d) return null;
    const name = String(label || "").trim() || d;

    const fromRegistry = await searchOfficialRegistry(name, d, deps.fetch);
    for (const url of fromRegistry) if (await check(url)) return { url, source: "registry", name, tried };

    // Conventions are probed together: eight sequential timeouts would be a
    // long silence for the person.
    const conventional = candidateUrls(d).filter(url => !tried.includes(url));
    tried.push(...conventional);
    const answers = await Promise.all(conventional.map(url => probe(url).catch(() => false)));
    const hit = conventional.find((_, i) => answers[i]);
    if (hit) return { url: hit, source: "convention", name, tried };
    return null;
}

// A URL the model found in the service's documentation: fine, if it is the
// service's own and something speaking MCP answers there.
export async function verifyFoundUrl(url: string, domain: string, probe: Probe = mcp.reachable): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!onDomain(url, domain)) return { ok: false, reason: `${url} is not on ${registrableDomain(domain) || "the service's own domain"} — only the service's own address may be handed a login` };
    if (!(await probe(url).catch(() => false))) return { ok: false, reason: `${url} does not answer as an MCP server` };
    return { ok: true };
}

export default { registrableDomain, onDomain, namespaceDomain, candidateUrls, searchOfficialRegistry, discoverMcpServer, verifyFoundUrl, OFFICIAL_REGISTRY };

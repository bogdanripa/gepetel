// Official remote MCP servers of well-known services, so that "connect Trello"
// needs no URL from the person. Every entry was checked live on 2026-09-06
// from the Pi: each answered the MCP handshake, either outright or with a 401
// that names its login. A URL still gets re-checked at connect time
// (mcp.reachable) before anything is sent to it — an entry that has moved
// falls back to asking for the URL, never to a guess.
//
// Only servers run by the service itself belong here. A community mirror or a
// per-user URL (Zapier's, for instance) is not something to hand a login to on
// someone's behalf.
export type KnownMcpServer = {
    name: string;            // how people say it
    aliases: string[];       // lower-case, matched as whole words or prefixes
    urls: string[];          // tried in order
    // A service that offers no self-registration for OAuth clients (GitHub,
    // Vercel, Supabase…) still works with a token in a header; this is what to
    // tell the person to fetch, when it comes to that.
    keyHint?: string;
};

export const KNOWN_MCP_SERVERS: KnownMcpServer[] = [
    { name: "Trello", aliases: ["trello"], urls: ["https://mcp.trello.com/v1"] },
    { name: "Jira", aliases: ["jira", "atlassian", "confluence"], urls: ["https://mcp.atlassian.com/v1/mcp"] },
    { name: "GitHub", aliases: ["github"], urls: ["https://api.githubcopilot.com/mcp/"], keyHint: "a GitHub personal access token (Settings → Developer settings → Personal access tokens)" },
    { name: "GitLab", aliases: ["gitlab"], urls: ["https://gitlab.com/api/v4/mcp"], keyHint: "a GitLab personal access token" },
    { name: "Linear", aliases: ["linear"], urls: ["https://mcp.linear.app/mcp"] },
    { name: "Notion", aliases: ["notion"], urls: ["https://mcp.notion.com/mcp"] },
    { name: "Asana", aliases: ["asana"], urls: ["https://mcp.asana.com/mcp", "https://mcp.asana.com/sse"] },
    { name: "Slack", aliases: ["slack"], urls: ["https://mcp.slack.com/mcp"] },
    { name: "Sentry", aliases: ["sentry"], urls: ["https://mcp.sentry.dev/mcp"] },
    { name: "Stripe", aliases: ["stripe"], urls: ["https://mcp.stripe.com"], keyHint: "a Stripe API key" },
    { name: "PayPal", aliases: ["paypal"], urls: ["https://mcp.paypal.com/mcp"] },
    { name: "Intercom", aliases: ["intercom"], urls: ["https://mcp.intercom.com/mcp"] },
    { name: "HubSpot", aliases: ["hubspot"], urls: ["https://mcp.hubspot.com/anthropic"] },
    { name: "Canva", aliases: ["canva"], urls: ["https://mcp.canva.com/mcp"] },
    { name: "Figma", aliases: ["figma"], urls: ["https://mcp.figma.com/mcp"], keyHint: "a Figma personal access token" },
    { name: "Miro", aliases: ["miro"], urls: ["https://mcp.miro.com/mcp"] },
    { name: "monday.com", aliases: ["monday", "monday.com"], urls: ["https://mcp.monday.com/mcp"] },
    { name: "ClickUp", aliases: ["clickup", "click up"], urls: ["https://mcp.clickup.com/mcp"] },
    { name: "Todoist", aliases: ["todoist"], urls: ["https://ai.todoist.net/mcp"] },
    { name: "Airtable", aliases: ["airtable"], urls: ["https://mcp.airtable.com/mcp"], keyHint: "an Airtable personal access token" },
    { name: "Webflow", aliases: ["webflow"], urls: ["https://mcp.webflow.com/mcp"] },
    { name: "Square", aliases: ["square", "squareup"], urls: ["https://mcp.squareup.com/mcp"] },
    { name: "Box", aliases: ["box"], urls: ["https://mcp.box.com"] },
    { name: "Vercel", aliases: ["vercel"], urls: ["https://mcp.vercel.com"], keyHint: "a Vercel access token" },
    { name: "Netlify", aliases: ["netlify"], urls: ["https://netlify-mcp.netlify.app/mcp"], keyHint: "a Netlify personal access token" },
    { name: "Supabase", aliases: ["supabase"], urls: ["https://mcp.supabase.com/mcp"], keyHint: "a Supabase personal access token" },
    { name: "Neon", aliases: ["neon"], urls: ["https://mcp.neon.tech/mcp"], keyHint: "a Neon API key" },
    { name: "Cloudflare docs", aliases: ["cloudflare"], urls: ["https://docs.mcp.cloudflare.com/mcp"] },
    { name: "Hugging Face", aliases: ["hugging face", "huggingface", "hf"], urls: ["https://huggingface.co/mcp"] },
    { name: "Context7", aliases: ["context7"], urls: ["https://mcp.context7.com/mcp"] },
    { name: "DeepWiki", aliases: ["deepwiki"], urls: ["https://mcp.deepwiki.com/mcp"] },
    { name: "Microsoft Learn", aliases: ["microsoft learn", "ms learn", "mslearn", "microsoft docs"], urls: ["https://learn.microsoft.com/api/mcp"] },
];

// "trello", "Trello board", "our Jira", "conectează Notion" → the entry, or null.
export function findKnownMcpServer(query: string): KnownMcpServer | null {
    const q = String(query || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
    if (!q) return null;
    const words = q.split(/[^a-z0-9.]+/).filter(Boolean);
    for (const entry of KNOWN_MCP_SERVERS) {
        for (const alias of entry.aliases) {
            if (q === alias) return entry;
            if (alias.includes(" ") ? q.includes(alias) : words.includes(alias)) return entry;
        }
    }
    return null;
}

export default { KNOWN_MCP_SERVERS, findKnownMcpServer };

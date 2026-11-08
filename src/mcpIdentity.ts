// Which account a private connection is signed in as, so it can be named
// after it: "Gmail (bogdan@genezio.com)" next to "Gmail (bogdanripa@gmail.com)"
// rather than "Gmail" and "Gmail (2)" (the owner, 2026-11-08).
//
// Asked of the service itself: a small model gets the connection's read-only
// tools (the same filter Pulse uses, mcp.listTools) and looks up the signed-in
// profile — Gmail's profile, Calendar's primary calendar, whatever that server
// offers. Nothing is written; if nothing tells, the name stays as it was.
// Private chats only: in a group the name is shown to everyone, and the
// address is the person's own.
import OpenAI from "openai";
import m from "./mongo.js";
import u from "./util.js";
import mcp from "./mcp.js";
import oai from "./oai.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ACCOUNT_SCHEMA = {
    type: "object", additionalProperties: false, required: ["account"],
    properties: { account: { type: "string" } },
};

/** The account a connection is signed in as ("ana@firma.ro"), or "". */
async function accountOf(entry: any): Promise<string> {
    const headers: Record<string, string> = entry.authorization ? { Authorization: `Bearer ${entry.authorization}` } : (entry.headers || {});
    const read = (await mcp.listTools(entry.server_url, headers)).filter(t => t.readOnly).map(t => t.name);
    if (!read.length) return "";
    const res: any = await client.responses.create({
        model: "gpt-5-mini",
        reasoning: { effort: "low" },
        tools: [{ ...entry, allowed_tools: read, require_approval: "never" }],
        instructions: "Find out which account this connection is signed in as. Call the one read-only tool most likely to return the signed-in user's own profile, account, or primary calendar (its id is usually the email address) — one or two calls, no more. Answer with JSON: account = that email address, or the username if there is no email; \"\" if nothing says. Never guess.",
        input: [{ role: "user", content: "Which account is this?" }],
        text: { format: { type: "json_schema", name: "account", schema: ACCOUNT_SCHEMA, strict: true } },
        store: false,
    });
    const account = String(JSON.parse(res.output_text || "{}").account || "").trim();
    // An address, or a plain handle; anything longer or stranger is not a name.
    return /^[^\s@()]+@[^\s@()]+\.[a-z]{2,}$/i.test(account) || /^[\w.\-]{2,40}$/.test(account) ? account.toLowerCase() : "";
}

/** Name one private connection after its account. Returns the new name, or null. */
export async function nameByAccount(chatId: string, connectorId: string): Promise<string | null> {
    if (!u.isPrivateChatId(chatId)) return null;
    try {
        const rows = await m.getMcpConnectorsForGroup(chatId);
        const row = rows.find(r => r.connector_id === connectorId);
        if (!row) return null;
        const entry = (await oai.mcpContextForGroup(chatId)).tools.find((t: any) => t.server_label === row.server_label);
        if (!entry) return null;
        const account = await accountOf(entry);
        if (!account) return null;
        const base = row.label.replace(/\s*\([^)]*\)\s*$/, "").trim() || row.label;
        return await m.renameMcpConnector(chatId, connectorId, `${base} (${account})`);
    } catch (e: any) {
        console.error(`naming connection ${connectorId}: ${e?.message || e}`);
        return null;
    }
}

/** Every private connection that isn't named after its account yet. */
export async function nameAllByAccount(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const chatId of await m.privateChatsWithConnectors()) {
        for (const row of await m.getMcpConnectorsForGroup(chatId)) {
            if (row.auth_kind !== "oauth" && row.auth_kind !== "headers") continue;
            if (/@|\(/.test(row.label) || /\/device\//.test(row.server_url)) continue;   // named already, or their computer
            out[`${u.phoneDigits(chatId).slice(-4)}:${row.label}`] = await nameByAccount(chatId, row.connector_id);
        }
    }
    return out;
}

export default { nameByAccount, nameAllByAccount };

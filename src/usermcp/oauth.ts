// The OAuth half of Gepetel's own MCP server: what Claude Code walks through
// when someone points it at https://gepetel.com/mcp.
//
// The unusual part is the login. There are no Gepetel accounts and no
// passwords — the only thing a person has is a WhatsApp number, and the only
// proof worth anything is that they can read a message sent to it. So the
// authorize page asks for the number, Gepetel sends a six-digit code IN
// WHATSAPP, and they type it back. Possession of the account is the identity,
// which is exactly the identity the tools need.
//
// Two refusals in here matter more than the happy path:
//   - a code can be asked for by anyone, deliberately: meeting Gepetel through
//     a client instead of a group is a way in, and a stranger who connects can
//     only message themselves and set their own reminders anyway. What stops
//     that being a spam machine is the caps in store.checkCodeLimits, the
//     global one most of all — the real loss is not one annoyed stranger, it
//     is this WhatsApp number getting banned;
//   - a redirect_uri that was not registered is refused, because that is the
//     field an attacker controls and the one that would send someone else's
//     code to them.
import type { Express, Request, Response } from "express";
import express from "express";
import m from "../mongo.js";
import u from "../util.js";
import say from "../say.js";
import store from "./store.js";
import { attemptsLocked, noteFailedAttempt, clearAttempts } from "../device/store.js";
import { sourceOf } from "../device/routes.js";

const SCOPE = "gepetel";

function base(): string { return u.publicBaseUrl(); }
export function resourceUrl(): string { return `${base()}/mcp`; }

const esc = (s: string) => String(s || "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

function page(title: string, body: string, status = 200, res?: Response): string {
    const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + `<title>${esc(title)}</title>`
        + '<body style="font:16px/1.5 system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#111">'
        + body + '</body>';
    if (res) res.status(status).type("html").send(html);
    return html;
}

const field = (name: string, value: string) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

// ─── discovery ──────────────────────────────────────────────────────────────

/** What the resource says about itself: who can issue tokens for it. This is
 *  the document the 401 from /mcp points at, and the first thing a client
 *  reads. */
function protectedResourceDoc() {
    return {
        resource: resourceUrl(),
        authorization_servers: [base()],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
    };
}

function authServerDoc() {
    return {
        issuer: base(),
        authorization_endpoint: `${base()}/oauth/mcp/authorize`,
        token_endpoint: `${base()}/oauth/mcp/token`,
        registration_endpoint: `${base()}/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // S256 only. Declaring "plain" as well would let a client pick the one
        // that proves nothing.
        code_challenge_methods_supported: ["S256"],
        // A desktop client cannot keep a secret, so it holds none; PKCE is what
        // makes that safe.
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
    };
}

// ─── the login ──────────────────────────────────────────────────────────────

/** Has Gepetel met this number before?
 *
 *  Not a gate any more — anyone may connect — but it still decides what the
 *  code message says. Being written to out of nowhere by a bot you have never
 *  heard of deserves a sentence explaining what it is, and someone who already
 *  talks to him does not need it. */
async function knownPerson(phone: string): Promise<boolean> {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 8) return false;
    try {
        if (await m.getPersonName(digits).catch(() => null)) return true;
        const groups = await m.getGroupsByParticipant(`${digits}@s.whatsapp.net`).catch(() => []);
        return groups.length > 0;
    } catch {
        return false;
    }
}

function askForNumber(res: Response, login_id: string, note = "") {
    page("Connect Gepetel", `
        <h1 style="font-size:1.3rem;margin:0 0 .25rem">Connect Gepetel</h1>
        <p style="color:#555;margin:.25rem 0 1.5rem">Gepetel will send a code to your WhatsApp to check it is you.</p>
        ${note ? `<p style="color:#b00;margin:0 0 1rem">${esc(note)}</p>` : ""}
        <form method="post" action="/oauth/mcp/authorize/phone">
          ${field("login_id", login_id)}
          <label for="phone" style="display:block;margin-bottom:.35rem">Your WhatsApp number, with country code</label>
          <input id="phone" name="phone" inputmode="tel" autocomplete="tel" placeholder="+40 7xx xxx xxx" required
                 style="width:100%;padding:.6rem;font-size:1rem;border:1px solid #bbb;border-radius:.4rem">
          <button type="submit" style="margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;border:0;border-radius:.4rem;background:#111;color:#fff">
            Send me a code
          </button>
        </form>`, 200, res);
}

function askForCode(res: Response, login_id: string, phone: string, note = "") {
    const masked = phone.replace(/\d(?=\d{2})/g, "•");
    page("Enter your code", `
        <h1 style="font-size:1.3rem;margin:0 0 .25rem">Check WhatsApp</h1>
        <p style="color:#555;margin:.25rem 0 1.5rem">Gepetel sent a six-digit code to ${esc(masked)}.</p>
        ${note ? `<p style="color:#b00;margin:0 0 1rem">${esc(note)}</p>` : ""}
        <form method="post" action="/oauth/mcp/authorize/code">
          ${field("login_id", login_id)}
          <label for="code" style="display:block;margin-bottom:.35rem">The code</label>
          <input id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required
                 style="width:100%;padding:.6rem;font-size:1.4rem;letter-spacing:.3em;text-align:center;border:1px solid #bbb;border-radius:.4rem">
          <button type="submit" style="margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;border:0;border-radius:.4rem;background:#111;color:#fff">
            Connect
          </button>
        </form>
        <form method="post" action="/oauth/mcp/authorize/phone" style="margin-top:1rem">
          ${field("login_id", login_id)}${field("phone", phone)}
          <button type="submit" style="width:100%;padding:.5rem;font-size:.9rem;background:none;border:0;color:#555;text-decoration:underline">
            Send it again
          </button>
        </form>`, 200, res);
}

const failed = (res: Response, title: string, detail: string, status = 400) =>
    page(title, `<h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(detail)}</p>`, status, res);

// ─── routes ─────────────────────────────────────────────────────────────────

export function registerOAuthRoutes(app: Express): void {
    const form = express.urlencoded({ extended: false });

    app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(protectedResourceDoc()));
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(protectedResourceDoc()));
    app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authServerDoc()));
    app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(authServerDoc()));

    // Dynamic client registration (RFC 7591). Open, as it must be for a desktop
    // client nobody has pre-arranged — which is safe because a client_id grants
    // nothing on its own: every token still comes from a person reading a code
    // in WhatsApp.
    app.post("/oauth/mcp/register", async (req, res) => {
        const body: any = req.body || {};
        const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
        if (!uris.length) {
            res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" });
            return;
        }
        // http is allowed only for a loopback callback, which is how a desktop
        // client receives the code. Anything else on the open internet must be
        // https or it is a downgrade waiting to happen.
        for (const uri of uris) {
            let parsed: URL;
            try { parsed = new URL(uri); } catch {
                res.status(400).json({ error: "invalid_redirect_uri", error_description: `not a URL: ${uri}` });
                return;
            }
            const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
            if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
                res.status(400).json({ error: "invalid_redirect_uri", error_description: `must be https, or http on loopback: ${uri}` });
                return;
            }
        }
        try {
            const client = await store.registerClient({ client_name: body.client_name, redirect_uris: uris });
            res.status(201).json({
                client_id: client.client_id,
                client_name: client.client_name,
                redirect_uris: client.redirect_uris,
                token_endpoint_auth_method: "none",
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
            });
        } catch (e) {
            console.error("mcp client registration failed:", e);
            res.status(500).json({ error: "server_error" });
        }
    });

    app.get("/oauth/mcp/authorize", async (req, res) => {
        const q: any = req.query || {};
        const client_id = String(q.client_id || "");
        const redirect_uri = String(q.redirect_uri || "");
        const client = await store.getClient(client_id).catch(() => null);
        // These two are shown as a page rather than redirected: with an
        // unregistered redirect_uri there is nowhere safe to send anybody.
        if (!client) { failed(res, "Unknown app", "This app is not registered with Gepetel. Add the server again from your client."); return; }
        if (!client.redirect_uris.includes(redirect_uri)) {
            failed(res, "Unexpected redirect", "This app asked to be sent somewhere it did not register. Nothing has been shared.");
            return;
        }
        const challenge = String(q.code_challenge || "");
        const method = String(q.code_challenge_method || "");
        if (String(q.response_type || "") !== "code" || !challenge || method !== "S256") {
            failed(res, "Unsupported request", "Gepetel only supports the authorization code flow with PKCE (S256).");
            return;
        }
        try {
            const login_id = await store.startLogin({ client_id, redirect_uri, state: String(q.state || ""), code_challenge: challenge });
            askForNumber(res, login_id);
        } catch (e) {
            console.error("starting an MCP login failed:", e);
            failed(res, "Something went wrong", "Try again in a moment.", 500);
        }
    });

    app.post("/oauth/mcp/authorize/phone", form, async (req, res) => {
        const login_id = String(req.body?.login_id || "");
        const login = await store.getLogin(login_id).catch(() => null);
        if (!login) { failed(res, "This page has expired", "Start again from your client — a login is good for fifteen minutes."); return; }

        // The one place in this codebase where a human types a number, so the
        // one place that has to cope with how people write their own.
        const parsed = u.normalizePhone(req.body?.phone);
        if (!parsed.ok) {
            askForNumber(res, login_id, parsed.reason === "national"
                // Said precisely, because "invalid number" would have them
                // retyping the same thing: the number is fine, the country is
                // missing, and only they know it.
                ? "That is your number without its country code. Start with the country — +40 721 000 000, not 0721 000 000."
                : "That does not look like a full number with its country code.");
            return;
        }
        const digits = parsed.digits;
        if (attemptsLocked(`mcp-login:${digits}`)) {
            askForNumber(res, login_id, "Too many tries for that number. Wait a few minutes.");
            return;
        }
        // The caps, before anything is sent. Anyone may ask for a code; nobody
        // may ask for many.
        const limit = await store.checkCodeLimits(digits, sourceOf(req)).catch(() => ({ ok: true } as const));
        if (!limit.ok) {
            askForNumber(res, login_id, limit.reason === "phone"
                ? "That number has been sent its codes for today. Try again tomorrow."
                : limit.reason === "ip"
                ? "Too many codes from here in the last hour. Try again later."
                : "Gepetel is sending a lot of codes right now. Try again in a little while.");
            return;
        }
        const code = store.newLoginCode();
        try {
            await store.putLoginCode(login_id, digits, code);
            const chatId = `${digits}@s.whatsapp.net`;
            const language = u.inferLanguage([digits]);
            // Someone he has never written to gets told who is writing and why.
            // The same text to a regular would be odd, so they do not get it.
            const met = await knownPerson(digits);
            const text = language === "Romanian"
                ? (met
                    ? `Codul tău pentru conectarea Gepetel: *${code}*\nScrie-l în pagina care ți l-a cerut. Expiră în 15 minute. Dacă nu tu ai cerut-o, ignoră mesajul — nu se întâmplă nimic.`
                    : `Salut! Sunt Gepetel. Cineva a cerut un cod ca să mă conecteze la acest număr.\nCodul: *${code}* — expiră în 15 minute.\nDacă nu tu ai cerut-o, ignoră mesajul; nu se întâmplă nimic și nu îți mai scriu.`)
                : (met
                    ? `Your Gepetel connection code: *${code}*\nType it into the page that asked for it. It expires in 15 minutes. If this wasn't you, ignore this — nothing happens.`
                    : `Hi — I'm Gepetel. Someone asked for a code to connect me to this number.\nThe code: *${code}* — it expires in 15 minutes.\nIf this wasn't you, ignore this; nothing happens and I won't write again.`);
            const sent = await say.sayAndRemember(chatId, text);
            if (!sent) { askForNumber(res, login_id, "Gepetel could not message that number on WhatsApp."); return; }
            // Counted only now: a send that failed cost its owner nothing.
            await store.noteCodeSent(digits, sourceOf(req)).catch(() => {});
            askForCode(res, login_id, digits);
        } catch (e) {
            console.error("sending an MCP login code failed:", e);
            failed(res, "Something went wrong", "Try again in a moment.", 500);
        }
    });

    app.post("/oauth/mcp/authorize/code", form, async (req, res) => {
        const login_id = String(req.body?.login_id || "");
        const login = await store.getLogin(login_id).catch(() => null);
        if (!login || !login.phone) { failed(res, "This page has expired", "Start again from your client."); return; }

        const { ok, dead } = await store.checkLoginCode(login_id, String(req.body?.code || "").replace(/\D/g, ""));
        if (!ok) {
            if (dead) {
                await store.dropLogin(login_id).catch(() => {});
                failed(res, "Too many wrong codes", "That login is closed. Start again from your client and Gepetel will send a new code.");
                return;
            }
            askForCode(res, login_id, login.phone, "That code is not right.");
            return;
        }
        clearAttempts(`mcp-login:${login.phone}`);
        try {
            const code = await store.issueAuthCode({
                client_id: login.client_id, chat_id: `${login.phone}@s.whatsapp.net`,
                redirect_uri: login.redirect_uri, code_challenge: login.code_challenge,
            });
            await store.dropLogin(login_id).catch(() => {});
            const back = new URL(login.redirect_uri);
            back.searchParams.set("code", code);
            if (login.state) back.searchParams.set("state", login.state);
            res.redirect(302, back.toString());
        } catch (e) {
            console.error("issuing an MCP authorization code failed:", e);
            failed(res, "Something went wrong", "Try again in a moment.", 500);
        }
    });

    app.post("/oauth/mcp/token", form, async (req, res) => {
        // Clients send this form-encoded per the spec, but a JSON body costs
        // nothing to accept and saves an afternoon when one does not.
        const body: any = { ...(req.body || {}) };
        const grant = String(body.grant_type || "");
        const client_id = String(body.client_id || "");
        res.set("Cache-Control", "no-store");
        try {
            if (grant === "authorization_code") {
                const owner = await store.consumeAuthCode(String(body.code || ""), {
                    client_id, redirect_uri: String(body.redirect_uri || ""), code_verifier: String(body.code_verifier || ""),
                });
                if (!owner) { res.status(400).json({ error: "invalid_grant" }); return; }
                const tokens = await store.issueTokens({ client_id, chat_id: owner.chat_id });
                res.json({ token_type: "Bearer", scope: SCOPE, ...tokens });
                return;
            }
            if (grant === "refresh_token") {
                const tokens = await store.refreshTokens(String(body.refresh_token || ""), client_id);
                if (!tokens) { res.status(400).json({ error: "invalid_grant" }); return; }
                res.json({ token_type: "Bearer", scope: SCOPE, ...tokens });
                return;
            }
            res.status(400).json({ error: "unsupported_grant_type" });
        } catch (e) {
            console.error("MCP token exchange failed:", e);
            res.status(500).json({ error: "server_error" });
        }
    });
}

export default { registerOAuthRoutes, resourceUrl };

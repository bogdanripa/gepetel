// A sign-in form on the phone (Phase 10). When a site asks a job for a
// username and password and none is saved on the Mac, the person gets a
// one-time link in the chat (the owner, 2026-10-15: "when a website asks for
// a user and/or password, just get gepetel to ask the user via whatsapp").
// The password is typed into this page, not into the chat: a chat message
// stays in WhatsApp's history and goes through the model; this goes straight
// through to the Mac over its socket and nowhere else.
//
//  - the token is 32 random bytes, kept in memory only, as a hash, 15
//    minutes, one use; a relay restart ends every link (the job then hands
//    the sign-in over as before);
//  - what's sent is never logged, stored or answered back — the log says
//    "sent" and the job;
//  - the page loads nothing from anywhere, can't be framed, sends only to
//    its own address.
import express, { type Express, type Request, type Response } from "express";
import u from "../util.js";
import { bridge } from "./takeover.js";
import { newToken, tokenShaped, hashToken as hash, linkHeaders as headers } from "./linkToken.js";

export const TTL_MS = 15 * 60_000;
type Link = { job_id: string; device_id: string; site: string; username: string; needUser: boolean; ro: boolean; expires: number };
const links = new Map<string, Link>();   // token hash → link

/** A link for a job's sign-in. An earlier one for the same job stops working. */
export function mint(l: Omit<Link, "expires">, now = Date.now()): string {
    for (const [h, x] of links) if (x.job_id === l.job_id || x.expires <= now) links.delete(h);
    const { token, hash: h } = newToken();
    links.set(h, { ...l, site: l.site.slice(0, 120), username: l.username.slice(0, 200), expires: now + TTL_MS });
    return `${u.publicBaseUrl()}/s/${token}`;
}

function usable(token: string, now = Date.now()): [string, Link] | null {
    if (!tokenShaped(token)) return null;
    const h = hash(token);
    const l = links.get(h);
    if (!l) return null;
    if (l.expires <= now) { links.delete(h); return null; }
    return [h, l];
}

export function endJob(jobId: string): void {
    for (const [h, x] of links) if (x.job_id === jobId) links.delete(h);
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#1d1d1b;--mute:#6b6b66;--line:#d9d8d2;--acc:#1f6f4a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eeede8;--mute:#a09f99;--line:#3a3a37;--acc:#4fbf8a}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.45 -apple-system,system-ui,sans-serif}
main{max-width:420px;margin:0 auto;padding:28px 16px}
h1{font-size:21px;margin:0 0 6px}p{color:var(--mute);margin:0 0 18px;font-size:15px}
label{display:block;font-size:14px;color:var(--mute);margin:14px 0 6px}
input[type=text],input[type=password],input[type=email]{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg)}
.row{display:flex;gap:8px;align-items:center;margin-top:16px;font-size:15px}
button{margin-top:22px;width:100%;padding:14px;font-size:17px;border:0;border-radius:12px;background:var(--acc);color:#fff}
button:disabled{opacity:.5}.err{color:#c0392b;font-size:14px;min-height:20px;margin-top:10px}
</style></head><body><main>${body}</main></body></html>`;

export function page(l: Link): string {
    // Text that goes into the inline script goes in as JSON string literals:
    // a quote in it ("That didn't work") once broke the whole script, so the
    // English form never sent anything (2026-10-15).
    const t = l.ro
        ? { h: `Conectare pe ${esc(l.site)}`, p: "Merge direct la Mac-ul tău, doar pentru conectarea asta. Nu trece prin chat și nu-l vede nimeni altcineva.", u: "Utilizator sau e-mail", pw: "Parola", keep: "Ține-le minte pe Mac (criptate), ca data viitoare să nu te mai întreb", go: "Trimite la Mac", sent: "Trimis. Mac-ul te conectează acum — poți închide pagina.", fail: "N-a mers: " }
        : { h: `Sign in on ${esc(l.site)}`, p: "This goes straight to your Mac, for this sign-in only. It doesn't go through the chat, and no one else sees it.", u: "Username or email", pw: "Password", keep: "Remember on my Mac (encrypted), so I don't ask next time", go: "Send to my Mac", sent: "Sent. Your Mac is signing you in — you can close this page.", fail: "That didn't work: " };
    return shell(t.h, `<h1>${t.h}</h1><p>${t.p}</p>
<div id="f">
${l.needUser ? `<label for="u">${t.u}</label><input id="u" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${esc(l.username)}">` : ""}
<label for="p">${t.pw}</label><input id="p" type="password" autocomplete="current-password">
<label class="row"><input id="k" type="checkbox" checked> ${t.keep}</label>
<button id="go">${t.go}</button><div class="err" id="e"></div></div>
<script>
var go=document.getElementById('go'),e=document.getElementById('e');
go.onclick=function(){var u=document.getElementById('u'),p=document.getElementById('p').value;if(!p){p=null;document.getElementById('p').focus();return;}
go.disabled=true;e.textContent='';
fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:u?u.value:null,password:p,remember:document.getElementById('k').checked})})
.then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);document.getElementById('f').innerHTML='<p>'+${JSON.stringify(t.sent)}+'</p>';});})
.catch(function(x){go.disabled=false;e.textContent=${JSON.stringify(t.fail)}+x.message;});};
</script>`);
}

export function registerSignInRoutes(app: Express): void {
    app.get("/s/:token", (req: Request, res: Response) => {
        headers(res);
        const got = usable(String(req.params.token || ""));
        if (!got) { res.status(410).type("html").send(shell("Gepetel", "<h1>This link has ended</h1><p>It was already used, or it expired. Ask again in the chat.</p>")); return; }
        res.type("html").send(page(got[1]));
    });
    app.post("/s/:token", express.json({ limit: "8kb" }), (req: Request, res: Response) => {
        headers(res);
        const got = usable(String(req.params.token || ""));
        if (!got) { res.status(410).json({ error: "this link has ended" }); return; }
        const [h, l] = got;
        const password = typeof req.body?.password === "string" ? req.body.password : "";
        const username = typeof req.body?.username === "string" ? req.body.username.trim() : l.username;
        if (!password || password.length > 500 || username.length > 300) { res.status(400).json({ error: "a password is needed" }); return; }
        const sent = bridge.toDevice(l.device_id, { t: "secret", job: l.job_id, username, password, remember: req.body?.remember === true });
        if (!sent) { res.status(503).json({ error: "your Mac is offline" }); return; }
        links.delete(h);   // one use
        console.log(`sign-in for ${l.job_id}: sent to the Mac`);
        res.json({ ok: true });
    });
}

export default { mint, endJob, registerSignInRoutes, page, TTL_MS };

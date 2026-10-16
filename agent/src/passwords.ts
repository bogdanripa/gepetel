// Sign-ins (Phase 10, the owner on 2026-10-15: "build your own local password
// manager. something very simple. and when a website asks for a user and/or
// password, just get gepetel to ask the user via whatsapp"). The Gepetel app
// keeps them, encrypted, the key in the Keychain (Passwords.swift); the agent
// asks for one at the moment of typing it and never keeps it. The model never
// sees a password, a saved username, or that one is being typed — the job
// does it in code.
//
// Asked in one `@passwords {json}` line on stdout, answered with one
// `{"t":"passwords-done", …}` line on stdin (as people.ts). Only under the app.

import { appChannel } from "./appChannel.js";

export type Login = { site: string; username: string; password: string };
type Req = { op: "has" | "get"; site: string; username?: string } | { op: "set"; site: string; username: string; password: string } | { op: "forget"; site: string; username?: string };
type Res = { ok: boolean; why: string; site?: string; username?: string; password?: string };

const channel = appChannel<Req, Res>({ tag: "passwords", done: "passwords-done", idPrefix: "w", timeoutMs: 5000,
    read: msg => ({ ok: msg.ok === true, why: String(msg.why || ""),
        ...(typeof msg.site === "string" ? { site: msg.site } : {}),
        ...(typeof msg.username === "string" ? { username: msg.username } : {}),
        ...(typeof msg.password === "string" ? { password: msg.password } : {}) }) });

export const enablePasswords = channel.enable;
export const passwordsAvailable = channel.available;
/** One request; the app logs the op only. */
const askPasswords = channel.ask;
/** A line from the app on stdin: true when it was an answer to us. */
export const passwordsAnswer = channel.answer;

/** For browse.ts: the saved sign-in for a host (exact host, else the same
 *  site's other host — the app decides), or null. */
export async function savedLogin(site: string): Promise<Login | null> {
    const r = await askPasswords({ op: "get", site });
    return r.ok && typeof r.password === "string" ? { site: r.site || site, username: r.username || "", password: r.password } : null;
}

export async function saveLogin(l: Login): Promise<boolean> {
    return (await askPasswords({ op: "set", site: l.site, username: l.username, password: l.password })).ok;
}

export async function forgetLogin(site: string, username: string): Promise<boolean> {
    return (await askPasswords({ op: "forget", site, username })).ok;
}

/** The page says the password (or the pair) was wrong — and didn't before
 *  it was typed. */
const WRONG = /(incorrect|wrong|invalid|isn't right|is not right|is not correct|doesn't match|didn't match|did not match|not recogni[sz]ed)[^.\n"]{0,40}(password|passcode|credentials|username|e-?mail|login|details)|(password|passcode|credentials)[^.\n"]{0,30}(incorrect|wrong|invalid|isn't right|not correct)|parol[ăa][^.\n"]{0,20}(greșit|gresit|incorect|invalid)|(date|datele) de (autentificare|conectare)[^.\n"]{0,20}(incorecte|invalide|greșite|gresite)|utilizator sau parol[ăa] (greșit|gresit|incorect)/i;
export function wrongPassword(snapshot: string, before = ""): boolean {
    const now = snapshot.match(WRONG)?.[0];
    return !!now && !(before && WRONG.test(before) && before.match(WRONG)?.[0] === now);
}

// API keys (the owner, 2026-10-15: "sometimes it might be easier to go and
// fetch an api key and save it … and call a service with it"). Kept in the
// same encrypted store, under the site, as a sign-in whose username is
// API_KEY_USER. A sandbox command names one as ‹api key: openweathermap.org›;
// the agent puts the key in as it runs and takes it out of what comes back,
// so the model, the chat and the logs only ever see the stand-in.

export const API_KEY_USER = "(api key)";

export function apiKeyPlaceholders(text: string): { whole: string; site: string }[] {
    return [...text.matchAll(/‹api key:\s*([^‹›\s]{1,120})\s*›/gi)].map(m => ({ whole: m[0], site: m[1].toLowerCase() }));
}

export async function savedApiKey(site: string): Promise<string | null> {
    const r = await askPasswords({ op: "get", site, username: API_KEY_USER });
    return r.ok && typeof r.password === "string" && r.password ? r.password : null;
}

export async function saveApiKey(site: string, key: string): Promise<boolean> {
    return (await askPasswords({ op: "set", site, username: API_KEY_USER, password: key })).ok;
}

/** Whether a page's text is plausibly an API key: one token, long enough,
 *  no spaces — not a sentence, not a masked "••••". */
export function looksLikeApiKey(v: string): boolean {
    const t = v.trim();
    return /^[A-Za-z0-9_\-.:]{16,200}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t);
}

/** A sandbox command with its ‹api key: site› stand-ins filled in; null and
 *  the missing site when one isn't kept. */
export async function fillApiKeys(command: string, get: (site: string) => Promise<string | null> = savedApiKey): Promise<{ command: string; keys: Map<string, string> } | { missing: string }> {
    const keys = new Map<string, string>();
    let out = command;
    for (const p of apiKeyPlaceholders(command)) {
        const k = await get(p.site).catch(() => null);
        if (!k) return { missing: p.site };
        keys.set(p.whole, k);
        out = out.split(p.whole).join(k);
    }
    return { command: out, keys };
}

// What a sign-in page asks for, read from its snapshot (aria lines).

const PASSWORD_FIELD = /password|parol|passwort|mot de passe|contraseña|passcode/i;
const USER_FIELD = /e-?mail|user ?name|username|login|log in|sign in|account|phone|mobile|telefon|utilizator|nume de utilizator|adresa de e-?mail|identifier|email or phone/i;
const CODE_FIELD = /\bcode\b|\bcod\b|verification|verificare|one[- ]time|\botp\b|\bpin\b|security code|6-digit|digit code|cod de securitate|enter code/i;

export type Field = { ref: string; name: string };
const textboxes = (snapshot: string): Field[] =>
    [...snapshot.matchAll(/- (?:textbox|searchbox|spinbutton) "([^"]*)"[^\n]*\[ref=([\w-]+)\]/g)].map(m => ({ name: m[1], ref: m[2] }));

/** The password and username boxes on a page, when it is a sign-in form. */
export function signInFields(snapshot: string): { user?: Field; password?: Field } {
    const boxes = textboxes(snapshot);
    const password = boxes.find(b => PASSWORD_FIELD.test(b.name) && !CODE_FIELD.test(b.name));
    const user = boxes.find(b => b !== password && USER_FIELD.test(b.name) && !PASSWORD_FIELD.test(b.name) && !/search|caut/i.test(b.name));
    // A username box alone is a sign-in only on a sign-in page (Google's
    // first step); the caller decides that.
    return { ...(user ? { user } : {}), ...(password ? { password } : {}) };
}

/** A page asking for a code it sent (two-step sign-in): the box, and where
 *  the code went — "sms" with the number's last digits, "email" with the
 *  shown address, or "app" (an authenticator) / "" (can't tell). */
export function codeRequest(snapshot: string): { field?: Field; via: "sms" | "email" | "app" | ""; last?: string; email?: string; send?: Field } | null {
    const text = snapshot.replace(/\[ref=[\w-]+\]/g, "");
    const asks = /verification code|enter (the )?code|code (we|was) sent|sent (you )?a code|we (just )?(sent|texted|emailed)|one[- ]time (pass)?code|2-step|two-step|two-factor|2fa|cod(ul)? de verificare|am trimis (un )?cod|introdu codul|security code|confirm (it'?s|that it'?s) you/i.test(text);
    const field = textboxes(snapshot).find(b => CODE_FIELD.test(b.name) && !PASSWORD_FIELD.test(b.name));
    // Words saying a code was sent, or a box named for one: a lone "Code"
    // box (a password field labelled so; a promo code) is not a sign-in code.
    if (!asks && !(field && /verification|one[- ]time|\botp\b|security code|sign[- ]in code|login code|sms code|cod de (verificare|securitate)/i.test(field.name))) return null;
    // A button that sends the code ("Text me", "Send code to •••• 34").
    const send = [...snapshot.matchAll(/- (?:button|link) "([^"]*)"[^\n]*\[ref=([\w-]+)\]/g)]
        .map(m => ({ name: m[1], ref: m[2] }))
        .find(b => /^(send|text me|get (a )?code|trimite|send code|send sms|text)\b/i.test(b.name.trim()) || /send (a )?code|send sms|trimite codul/i.test(b.name));
    const email = text.match(/\b([\w.+-]*[•*·…][\w.•*·…+-]*@[\w.-]+\.\w+|[\w.+-]+@[\w-]+\.[\w.]+)\b/)?.[1];
    const phone = text.match(/(?:[•*·x]{2,}|\.\.\.|…)[\s-]*(\d{2,4})\b|ending (?:in|with) (\d{2,4})\b|se termină în (\d{2,4})\b|\+\d[\d\s]*[•*x]{2,}[\s•*x]*(\d{2,4})\b/i);
    const last = phone ? (phone[1] || phone[2] || phone[3] || phone[4]) : undefined;
    const app = /authenticator|authentication app|aplicați[ae] de autentificare|google authenticator|authy/i.test(text);
    const via = app ? "app" : email && /e-?mail|inbox|sent to|trimis pe/i.test(text) ? "email" : last || /\bsms\b|text message|texted|mesaj text/i.test(text) ? "sms" : /e-?mail/i.test(text) ? "email" : "";
    return { ...(field ? { field } : {}), via, ...(last ? { last } : {}), ...(email ? { email } : {}), ...(send ? { send } : {}) };
}

/** A sign-in option that sends a code or a link instead of asking for a
 *  password — "Email me a sign-in link", "Send me a code", "Sign in with a
 *  one-time code". Preferred to handing the screen back (the owner,
 *  2026-10-16: "it is more automated"). */
export function codeOrLinkOption(snapshot: string): Field | null {
    const re = /\b(e-?mail|send|text|whatsapp|sms)\b[^"]{0,25}\b(link|code)\b|\b(sign|log)[- ]?in with (a |an )?(one[- ]time )?(code|link|e-?mail)\b|\b(magic|login|sign[- ]?in) link\b|\bone[- ]time code\b|\b(use|get) a (one[- ]time )?code\b|trimite(-mi)?[^"]{0,15}\b(link|cod)\b|cod (prin|pe) (e-?mail|sms)/i;
    for (const m of snapshot.matchAll(/- (?:button|link) "([^"]*)"[^\n]*\[ref=([\w-]+)\]/g)) {
        if (m[1].length < 70 && re.test(m[1]) && !/password|parol/i.test(m[1].replace(/without (a )?password|fără parolă/i, ""))) return { name: m[1], ref: m[2] };
    }
    return null;
}

/** A page saying a sign-in link was emailed (no code box to type into). */
export function linkSent(snapshot: string): boolean {
    const text = snapshot.replace(/\[ref=[\w-]+\]/g, "");
    return /(we('ve| have)? (sent|emailed)|check your (e-?mail|inbox)|sent you an? (e-?mail|link)|am trimis (un )?link|verifică(-ți)? (e-?mailul|inbox))/i.test(text)
        && /\blink\b/i.test(text) && !/- textbox "[^"]*(code|cod)\b/i.test(snapshot);
}

/** A sign-in link from a site in an email's text: an https address on the
 *  site's own domain (or a subdomain of it), never anything else. */
export function signInLinkIn(text: string, site: string): string | null {
    const reg = site.replace(/^www\./, "").split(".").slice(-2).join(".");
    for (const m of text.matchAll(/https:\/\/[^\s"'<>)\]]+/g)) {
        const url = m[0].replace(/&amp;/g, "&").replace(/[.,;]+$/, "");
        try { const h = new URL(url).hostname; if ((h === reg || h.endsWith(`.${reg}`)) && /(login|signin|sign-in|auth|magic|token|verify|confirm|session|link)/i.test(url)) return url; } catch { /* not one */ }
    }
    return null;
}

/** Whether a number's last digits are one of the person's numbers'. */
export function isTheirNumber(last: string, numbers: string[]): boolean {
    if (!/^\d{2,4}$/.test(last)) return false;
    return numbers.some(n => n.replace(/\D/g, "").endsWith(last));
}

/** A code in an email's subject or snippet — the digits next to "code" (or
 *  the only run of 4–8 digits). */
export function codeIn(text: string): string | null {
    const near = text.match(/(?:code|cod|codul|pin|otp|passcode)[^\d]{0,40}(\d{4,8})\b|\b(\d{4,8})\b[^\d]{0,30}(?:is your|este codul|e codul)/i);
    if (near) return near[1] || near[2];
    const all = [...text.matchAll(/\b\d{4,8}\b/g)].map(m => m[0]).filter(d => !/^(19|20)\d\d$/.test(d));
    return all.length === 1 ? all[0] : null;
}

/** Gmail's feed of unread mail (the person's own, through their Chrome
 *  session): entries newer than `sinceMs`, from or about `site`. */
export function codeFromFeed(xml: string, site: string, sinceMs: number): string | null {
    const name = site.replace(/^www\./, "").split(".").slice(-2, -1)[0] || site;
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
    for (const e of entries) {
        const issued = Date.parse(e.match(/<issued>([^<]+)<\/issued>/)?.[1] || e.match(/<modified>([^<]+)<\/modified>/)?.[1] || "");
        if (!(issued >= sinceMs - 60_000)) continue;
        const dec = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const title = dec(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "");
        const summary = dec(e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "");
        const from = dec(`${e.match(/<name>([\s\S]*?)<\/name>/)?.[1] || ""} ${e.match(/<email>([\s\S]*?)<\/email>/)?.[1] || ""}`);
        if (!new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(`${from} ${title} ${summary}`)) continue;
        const c = codeIn(`${title} ${summary}`);
        if (c) return c;
    }
    return null;
}

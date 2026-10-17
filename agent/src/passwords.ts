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
const USER_FIELD = /e-?mail|user ?name|username|login|log in|sign in|account|phone|mobile|telefon|utilizator|nume de utilizator|adresa de e-?mail|identifier|email or phone|logare|user ?id|login id|customer (id|number)|client (id|number)|cod (de )?client/i;
const CODE_FIELD = /\bcode\b|\bcod\b|verification|verificare|one[- ]time|\botp\b|\bpin\b|security code|6-digit|digit code|cod de securitate|enter code/i;

export type Field = { ref: string; name: string };
const textboxes = (snapshot: string): Field[] =>
    [...snapshot.matchAll(/- (?:textbox|searchbox|spinbutton) "([^"]*)"[^\n]*\[ref=([\w-]+)\]/g)].map(m => ({ name: m[1], ref: m[2] }));

/** A form to change a password — "Current password", "New password",
 *  "Confirm password" — is not a sign-in: they're signed in already. Taken
 *  for one on Home Assistant's Security page, the job asked for their
 *  password and pressed the page's "Enable" (2026-10-16). */
export const CHANGE_PASSWORD = /\b(new|current|old|existing|confirm(ed)?|repeat|retype|re-enter|verify)\b[^"\n]{0,15}password|password[^"\n]{0,10}\b(again|confirm(ation)?)\b|parol(a|ă)[^"\n]{0,12}(nou(ă|a)|curent(ă|a)|veche|actual(ă|a))|(confirm(ă|a)|repet(ă|a))[^"\n]{0,12}parol/i;
export const changesPassword = (snapshot: string): boolean => textboxes(snapshot).some(b => CHANGE_PASSWORD.test(b.name));

/** The password and username boxes on a page, when it is a sign-in form. */
export function signInFields(snapshot: string): { user?: Field; password?: Field } {
    if (changesPassword(snapshot)) return {};
    const boxes = textboxes(snapshot);
    const password = boxes.find(b => PASSWORD_FIELD.test(b.name) && !CODE_FIELD.test(b.name));
    const user = boxes.find(b => b !== password && USER_FIELD.test(b.name) && !PASSWORD_FIELD.test(b.name) && !/search|caut/i.test(b.name));
    // A username box alone is a sign-in only on a sign-in page (Google's
    // first step); the caller decides that.
    return { ...(user ? { user } : {}), ...(password ? { password } : {}) };
}

/** Every text box in a snapshot, named or not — a box whose label is only
 *  text next to it (no <label>, no aria) has no name there. */
export function allTextboxRefs(snapshot: string): string[] {
    return [...snapshot.matchAll(/- (?:textbox|searchbox)(?: "[^"]*")?[^\n]*\[ref=([\w-]+)\]/g)].map(m => m[1]);
}

/** What the page itself says about those boxes (browse.ts asks it): the
 *  input's type, and its hints — autocomplete, id, name, placeholder, the
 *  text beside it. */
export type BoxProbe = { ref: string; type: string; hint: string; visible: boolean };

/** The sign-in fields, from the page's own word: a visible password-type box,
 *  and the text box before it (or one whose hints say username). For forms
 *  whose labels the snapshot can't see — a bank's (BT Pay, 2026-10-16) had
 *  "ID-ul tău de logare" and "Parola ta" as loose text, so the job never knew
 *  it was looking at a sign-in. */
export function fieldsFromProbe(probes: BoxProbe[]): { user?: Field; password?: Field } {
    const shown = probes.filter(p => p.visible);
    if (shown.some(p => CHANGE_PASSWORD.test(p.hint))) return {};
    const pi = shown.findIndex(p => p.type === "password" && !CODE_FIELD.test(p.hint));
    const textish = (p: BoxProbe) => /^(text|email|tel|)$/.test(p.type) && !/search|caut/i.test(p.hint);
    const named = shown.find(p => textish(p) && USER_FIELD.test(p.hint) && !PASSWORD_FIELD.test(p.hint));
    const before = pi > 0 ? [...shown.slice(0, pi)].reverse().find(textish) : undefined;
    const user = named ?? before;
    const name = (p: BoxProbe) => p.hint.slice(0, 60) || p.type;
    return {
        ...(user && (pi >= 0 || named) ? { user: { ref: user.ref, name: name(user) } } : {}),
        ...(pi >= 0 ? { password: { ref: shown[pi].ref, name: name(shown[pi]) } } : {}),
    };
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

// Sending a sign-in form: its own button, pressed as a person would — not
// Enter (the owner, 2026-10-16: "dont be smart and use the keyboard. clicking a
// button is a lot more reliable"). BT Pay's form, sent by Enter without its
// button, came back empty: "Te rugăm să introduci ID-ul de logare".
const NOT_SUBMIT = /enable|disable|activ|dezactiv|delete|remove|șterge|sterge|elimin|forg[eo]t|uitat|reset|recuper|show|hide|arată|arata|ascunde|cancel|anulea|back|înapoi|inapoi|sign ?up|register|înregistr|inregistr|create (an )?account|creează|creeaza|cont nou|help|ajutor|cookie|politic|privacy|terms/i;

/** Words of a button that sends a sign-in. */
export const SIGN_IN_GO = /sign ?in|log ?in|continue|next|submit|\bgo\b|\bok\b|verify|confirm|send|conect|autentific|intr(ă|a)|merg|continu|trimite|verific|anmelden|weiter|connexion|suivant|acceder|entrar|accedi/i;

/** The form's button after a box in a snapshot. `own`: the name of the
 *  submit button of the box's own form, as the page said (browse.ts asks it);
 *  that one, after the box. Without it, only a button that reads as sending
 *  a sign-in, and never "forgot password", "show", "enable"… — the first
 *  button after HA's password box was the next section's "Enable". */
export function submitAfter(snapshot: string, fieldRef: string, own?: string | null): Field | null {
    const at = snapshot.search(new RegExp(`\\[ref=${fieldRef.replace(/[^\w-]/g, "")}\\]`));
    if (at < 0) return null;
    const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
    for (const m of snapshot.slice(at).matchAll(/- button "([^"]+)"[^\n]*\[ref=([\w-]+)\]/g)) {
        if (m[1].length > 60 || NOT_SUBMIT.test(m[1])) continue;
        if (own ? norm(m[1]) === norm(own) : SIGN_IN_GO.test(m[1])) return { name: m[1], ref: m[2] };
    }
    return null;
}

/** The same on a page read by the extension: the nearest button just below
 *  the box and across from it. Its index, or -1. */
export function submitBelow(box: number[], buttons: { name: string; rect: number[] }[]): number {
    const [x, y, w, h] = box;
    let best = -1, bestGap = Infinity;
    buttons.forEach((b, i) => {
        const [bx, by, bw] = b.rect;
        const gap = by - (y + h);
        const across = bx < x + w && bx + bw > x;
        if (gap < -h / 2 || gap > 220 || !across || b.name.length > 60 || NOT_SUBMIT.test(b.name) || !SIGN_IN_GO.test(b.name)) return;
        if (gap < bestGap) { best = i; bestGap = gap; }
    });
    return best;
}

/** A username box with no password beside it is a sign-in's first step only
 *  where its own form or section says so — the text around it (labels,
 *  headings, its buttons). On the bank's information page the job took the
 *  footer's newsletter box ("Abonează-te la newsletter", an e-mail box and
 *  "Trimite") for one, and typed their login ID into it (2026-10-17). */
const SIGN_IN_AREA = /sign ?in|log ?in|login|logare|autentific|conect|parol|password|passcode|your account|contul (tău|tau)|account id|user ?id|username|utilizator|anmelden|connexion|iniciar sesi|accedi/i;
const NOT_SIGN_IN_AREA = /newsletter|abonea|abon(are|ament)|subscri|unsubscri|search|caut(ă|a)|contact|feedback|comment|coment|cupon|coupon|promo|voucher|track(ing)? (number|order)|urmărește|alert(e|s)? de pre/i;
export function signInArea(text: string): boolean {
    const t = text.replace(/\s+/g, " ").slice(0, 800);
    return SIGN_IN_AREA.test(t) && !NOT_SIGN_IN_AREA.test(t);
}

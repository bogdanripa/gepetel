// What each form on a page is for, read from the page itself — not guessed
// from its address or from a flat list of boxes. The owner, 2026-10-17: "screen
// understanding is something we do badly". The job had typed a bank login ID
// into the footer's newsletter box (the address said "login"), taken a
// change-password form for a sign-in, and pressed the next section's "Enable"
// as a form's submit. Browser agents elsewhere leave a form's purpose to the
// model; here it's plain rules on what password managers look at
// (autocomplete, how many password boxes, the button, the heading, the
// region), so it costs no model call and is the same every time.
//
// One script per page with form controls: every box and button the snapshot
// has a ref for is tagged in the page (a property, nothing added to the DOM's
// attributes), then one pass groups them by form (or, without a <form>, by the
// nearest section with a heading) and reads each group's region, heading and
// boxes' labels — the label from <label>, aria-labelledby, placeholder, or the
// text beside the box (a bank's "ID-ul tău de logare" was a loose span).

export type Control = { ref: string; kind: string; label: string; autocomplete: string; visible: boolean; filled: boolean };
export type FormGroup = {
    region: string;          // main, header, nav, aside, footer, dialog, …
    heading: string;
    controls: Control[];
    buttons: { ref: string; name: string; submit: boolean }[];
    text: string;            // the group's own text, short
    title?: string;          // the page's title
};
export type Purpose = "sign-in" | "sign-in step" | "code" | "change-password" | "sign-up" | "search" | "newsletter" | "payment" | "other";
export type Form = FormGroup & { purpose: Purpose; sure: boolean };

/** Refs worth tagging: boxes and buttons (links are many and seldom in forms). */
export function controlRefs(snapshot: string, max = 140): string[] {
    const out: string[] = [];
    for (const m of snapshot.matchAll(/- (textbox|searchbox|combobox|spinbutton|checkbox|radio|button)\b[^\n]*\[ref=([A-Za-z0-9_]+)\]/g)) {
        out.push(m[2]);
        if (out.length >= max) break;
    }
    return out;
}

/** Has the page anything to fill in at all? (Else no script runs.) */
export const hasControls = (snapshot: string) => /- (textbox|searchbox|combobox|spinbutton)\b/.test(snapshot);

/** The script: tags the refs, then reads the groups. Never a value — only
 *  whether a box is filled. */
export function formMapCode(refs: string[]): string {
    const safe = refs.filter(r => /^[A-Za-z0-9_]{1,24}$/.test(r)).slice(0, 140);
    return `async (page) => {
  for (const ref of ${JSON.stringify(safe)}) await page.locator('aria-ref=' + ref).evaluate((el, r) => { el.__gref = r; }, ref).catch(() => {});
  return await page.evaluate(() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
    const shown = el => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const REGION = 'footer,[role=contentinfo],header,[role=banner],nav,[role=navigation],aside,[role=complementary],dialog,[role=dialog],[aria-modal=true],main,[role=main]';
    const regionOf = el => { const r = el.closest(REGION); if (!r) return 'page'; const t = (r.getAttribute('role') || r.tagName).toLowerCase(); return ({ contentinfo: 'footer', banner: 'header', navigation: 'nav', complementary: 'aside' })[t] || (r.getAttribute('aria-modal') === 'true' ? 'dialog' : t); };
    const labelOf = el => {
      let t = clean(el.labels && el.labels[0] && el.labels[0].innerText);
      if (!t && el.getAttribute('aria-labelledby')) t = clean(el.getAttribute('aria-labelledby').split(/\\s+/).map(id => (document.getElementById(id) || {}).innerText || '').join(' '));
      if (!t) t = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'));
      // The text beside it: a sibling, else the parent's own words.
      for (let s = el.previousElementSibling, i = 0; !t && s && i < 3; s = s.previousElementSibling, i++) t = clean(s.innerText);
      for (let s = el.nextElementSibling, i = 0; !t && s && i < 2; s = s.nextElementSibling, i++) if (!/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(s.tagName)) t = clean(s.innerText);
      if (!t && el.parentElement) t = clean(el.parentElement.innerText);
      return t.slice(0, 80);
    };
    const headingOf = (box) => {
      const h = box.querySelector('legend,h1,h2,h3,h4,h5,[role=heading]');
      if (h && clean(h.innerText)) return clean(h.innerText).slice(0, 80);
      if (box.getAttribute && box.getAttribute('aria-label')) return clean(box.getAttribute('aria-label')).slice(0, 80);
      // The nearest heading above it, within a few levels.
      for (let p = box, i = 0; p && i < 4; p = p.parentElement, i++) {
        for (let s = p.previousElementSibling, j = 0; s && j < 4; s = s.previousElementSibling, j++) {
          const hh = s.matches('h1,h2,h3,h4,h5,[role=heading],legend') ? s : s.querySelector && s.querySelector('h1,h2,h3,h4,h5,[role=heading]');
          if (hh && clean(hh.innerText)) return clean(hh.innerText).slice(0, 80);
        }
      }
      return '';
    };
    const groupOf = el => el.form || el.closest('form,[role=form],[role=search],fieldset,dialog,[role=dialog],section,aside,footer,header,nav') || document.body;
    const groups = new Map();
    for (const el of document.querySelectorAll('input,textarea,select,button,[role=button],[role=textbox],[role=combobox]')) {
      if (!el.__gref) continue;
      const g = groupOf(el);
      if (!groups.has(g)) groups.set(g, { el: g, controls: [], buttons: [] });
      const grp = groups.get(g);
      const tag = el.tagName, type = (el.getAttribute('type') || '').toLowerCase();
      const isButton = tag === 'BUTTON' || el.getAttribute('role') === 'button' || (tag === 'INPUT' && /^(submit|button|image|reset)$/.test(type));
      if (isButton) {
        const name = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title')).slice(0, 60);
        const submit = !!el.form && (type === 'submit' || (tag === 'BUTTON' && !type) || (tag === 'INPUT' && (type === 'submit' || type === 'image')));
        grp.buttons.push({ ref: el.__gref, name, submit });
      } else {
        const kind = tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : (type || (el.getAttribute('role') || 'text'));
        if (/^(hidden)$/.test(kind)) continue;
        grp.controls.push({ ref: el.__gref, kind, label: labelOf(el), autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase().slice(0, 40), visible: shown(el), filled: !!(el.value && String(el.value).length) });
      }
    }
    const out = [];
    for (const g of groups.values()) {
      if (!g.controls.some(c => c.visible)) continue;
      out.push({ region: regionOf(g.el), heading: headingOf(g.el), controls: g.controls, buttons: g.buttons, text: clean(g.el === document.body ? '' : g.el.innerText).slice(0, 300), title: clean(document.title).slice(0, 100) });
      if (out.length >= 12) break;
    }
    return out;
  });
}`;
}

const PW_KINDS = new Set(["password"]);
const SIGN_UP = /sign ?up|register|create (an |your )?account|join\b|înregistr|inregistr|creează cont|creeaza cont|cont nou|new account/i;
const CHANGE = /\b(new|current|old|existing|confirm(ed)?|repeat|retype|re-enter)\b[^"\n]{0,15}password|password[^"\n]{0,10}\b(again|confirm)|parol(a|ă)[^"\n]{0,12}(nou(ă|a)|curent(ă|a)|veche|actual(ă|a))|(confirm(ă|a)|repet(ă|a))[^"\n]{0,12}parol|schimb(ă|a) parola|change password/i;
const SEARCH = /search|caut(ă|a)|find|găsește|gaseste|suche|recherche|buscar/i;
const NEWSLETTER = /newsletter|abonea|abon(are|ament)|subscri|noutăți|noutati|stay (up to date|in touch)|updates by e-?mail/i;
const SIGN_IN = /sign ?in|log ?in|login|logare|autentific|conect|parol|password|your account|contul (tău|tau)|account id|user ?id|username|utilizator|anmelden|connexion|iniciar sesi|accedi/i;
const USERNAME = /e-?mail|user ?name|username|login|logare|user ?id|account|phone|mobile|telefon|utilizator|identifier|client|customer/i;
const CODE = /\bcode\b|\bcod\b|verification|verificare|one[- ]time|\botp\b|security code|6-digit/i;
const CARD = /card number|număr(ul)? card|numar(ul)? card|cvv|cvc|expir|iban|cardholder|titular/i;

/** A group's purpose, by rules. `sure`: the rules agree with themselves; else
 *  a small model may be asked (browse.ts). */
export function purposeOf(g: FormGroup): { purpose: Purpose; sure: boolean } {
    const vis = g.controls.filter(c => c.visible);
    const words = `${g.heading} ${g.text} ${vis.map(c => c.label).join(" ")} ${g.buttons.map(b => b.name).join(" ")}`;
    const pw = vis.filter(c => PW_KINDS.has(c.kind));
    const ac = vis.map(c => c.autocomplete).join(" ");
    const texty = vis.filter(c => /^(text|email|tel|textbox|)$/.test(c.kind));
    if (vis.some(c => CARD.test(c.label) || /cc-(number|exp|csc)/.test(c.autocomplete))) return { purpose: "payment", sure: true };
    if (pw.length >= 2 || /new-password/.test(ac) || pw.some(c => CHANGE.test(c.label))) {
        // Only a box for the current password makes it a change of password;
        // "repeat password" is on sign-up forms too.
        const current = pw.some(c => /current|old|existing|curent(ă|a)|veche|actual(ă|a)/i.test(c.label) || /current-password/.test(c.autocomplete));
        return { purpose: SIGN_UP.test(words) && !current ? "sign-up" : "change-password", sure: true };
    }
    if (pw.length === 1) {
        if (SIGN_UP.test(`${g.heading} ${g.buttons.map(b => b.name).join(" ")}`) && !SIGN_IN.test(g.heading)) return { purpose: "sign-up", sure: false };
        return { purpose: "sign-in", sure: true };
    }
    if (vis.some(c => /one-time-code/.test(c.autocomplete) || (CODE.test(c.label) && !/promo|coupon|voucher|cupon|discount|reducere|postal|zip|poștal|postal/i.test(c.label)))) return { purpose: "code", sure: /one-time-code/.test(ac) };
    if (vis.some(c => c.kind === "search") || SEARCH.test(`${g.heading} ${vis.map(c => c.label).join(" ")}`)) return { purpose: "search", sure: true };
    if (NEWSLETTER.test(words)) return { purpose: "newsletter", sure: true };
    if (texty.length === 1 && vis.length <= 2 && g.region === "footer" && /email/.test(texty[0].kind + " " + texty[0].label.toLowerCase())) return { purpose: "newsletter", sure: false };
    // A username box alone: the first step of a sign-in only where the
    // group says so, and never in a footer or a nav.
    if (texty.length === 1 && (/username|webauthn/.test(ac) || USERNAME.test(texty[0].label)) && !/^(footer|nav)$/.test(g.region)) {
        if (SIGN_IN.test(words) || /username|webauthn/.test(ac)) return { purpose: "sign-in step", sure: /username|webauthn/.test(ac) || SIGN_IN.test(g.heading) };
        // The page's title as a tie-breaker (a sign-in page whose form is only
        // "Email" and "Next"), never against what the form itself says.
        if (g.title && SIGN_IN.test(g.title) && !NEWSLETTER.test(words) && !SEARCH.test(words)) return { purpose: "sign-in step", sure: false };
        return { purpose: "other", sure: false };
    }
    return { purpose: "other", sure: true };
}

export function classify(groups: FormGroup[]): Form[] {
    return groups.map(g => ({ ...g, ...purposeOf(g) }));
}

/** The form's own button that sends it: its submit, else a button of the
 *  group that reads as sending it. Never another section's. */
export function submitOf(f: Form): { ref: string; name: string } | null {
    const own = f.buttons.find(b => b.submit && b.name);
    if (own) return own;
    const go = f.buttons.find(b => /sign ?in|log ?in|continue|next|submit|send|verify|confirm|go\b|ok\b|conect|autentific|intr(ă|a)|merg|continu|trimite|verific|search|caut/i.test(b.name)
        && !/forg[eo]t|uitat|reset|show|hide|cancel|anule|back|înapoi|sign ?up|register|enable|disable|delete|șterge|sterge/i.test(b.name));
    return go ?? null;
}

/** The forms, for the model: one line each — what it's for, where, its
 *  boxes with their labels, the button that sends it. */
export function formsText(forms: Form[]): string {
    if (!forms.length) return "";
    const lines = forms.slice(0, 8).map(f => {
        const boxes = f.controls.filter(c => c.visible).slice(0, 8).map(c => `${c.kind === "password" ? "password" : c.kind === "select" ? "dropdown" : "box"} "${c.label || "(no label)"}" [ref=${c.ref}]${c.filled ? " (filled)" : ""}`).join(", ");
        const go = submitOf(f);
        return `- ${f.purpose}${f.sure ? "" : "?"} [${f.region}]${f.heading ? ` "${f.heading}"` : ""}: ${boxes}${go ? `; sent with "${go.name}" [ref=${go.ref}]` : ""}`;
    });
    return `Forms on this page (what each is for, read from the page):\n${lines.join("\n")}\nType a login, a password or a code only into a form marked sign-in or code. A form is sent only with its own button.`;
}

/** Nameless boxes in a snapshot get the label the page shows beside them. */
export function labelSnapshot(snapshot: string, forms: Form[]): string {
    const labels = new Map<string, string>();
    for (const f of forms) for (const c of f.controls) if (c.label) labels.set(c.ref, c.label.replace(/"/g, "'"));
    if (!labels.size) return snapshot;
    return snapshot.replace(/- (textbox|searchbox|combobox|spinbutton)( \[[^\]]*\])* \[ref=([A-Za-z0-9_]+)\]/g, (all, role, _s, ref) => {
        const l = labels.get(ref);
        return l ? all.replace(`- ${role}`, `- ${role} "${l}"`) : all;
    });
}

/** The sign-in fields, from the forms: a form for signing in (or its first
 *  step), its username box and password box. */
export function signInFrom(forms: Form[]): { user?: { ref: string; name: string }; password?: { ref: string; name: string }; form?: Form } {
    const f = forms.find(x => x.purpose === "sign-in" && x.region !== "footer")
        ?? forms.find(x => x.purpose === "sign-in")
        ?? forms.find(x => x.purpose === "sign-in step");
    if (!f) return {};
    const vis = f.controls.filter(c => c.visible);
    const pi = vis.findIndex(c => c.kind === "password");
    const texty = (c: Control) => /^(text|email|tel|textbox|)$/.test(c.kind);
    const user = (pi > 0 ? [...vis.slice(0, pi)].reverse().find(texty) : undefined) ?? vis.find(c => texty(c) && (USERNAME.test(c.label) || /username/.test(c.autocomplete)));
    return {
        ...(user ? { user: { ref: user.ref, name: user.label || "username" } } : {}),
        ...(pi >= 0 ? { password: { ref: vis[pi].ref, name: vis[pi].label || "password" } } : {}),
        form: f,
    };
}

/** For a small model when the rules aren't sure (browse.ts): what this form is for. */
export function formPurposeRequest(model: string | undefined, f: FormGroup): any {
    const text = [
        `Region: ${f.region}`, f.heading ? `Heading: ${f.heading}` : "",
        `Boxes: ${f.controls.filter(c => c.visible).map(c => `${c.kind} "${c.label}"${c.autocomplete ? ` (autocomplete ${c.autocomplete})` : ""}`).join("; ")}`,
        `Buttons: ${f.buttons.map(b => b.name).join("; ")}`,
        f.text ? `Its text: ${f.text}` : "",
    ].filter(Boolean).join("\n");
    return {
        model,
        instructions: "What is this web form for? sign-in (signing into an account, or its first step asking for the username), code (a one-time code), change-password, sign-up, search, newsletter, payment, or other. Only what the form itself shows.",
        input: [{ role: "user", content: [{ type: "input_text", text }] }],
        tools: [{ type: "function", name: "form_purpose", description: "The form's purpose.", strict: true,
            parameters: { type: "object", additionalProperties: false, required: ["purpose"],
                properties: { purpose: { type: "string", enum: ["sign-in", "code", "change-password", "sign-up", "search", "newsletter", "payment", "other"] } } } }],
        tool_choice: { type: "function", name: "form_purpose" }, parallel_tool_calls: false,
        reasoning: { effort: "minimal" }, max_output_tokens: 150,
    };
}

export function readFormPurpose(out: any): Purpose | null {
    const fc = (out?.output || []).find((o: any) => o?.type === "function_call" && o?.name === "form_purpose");
    try { const p = JSON.parse(fc?.arguments || "{}").purpose; return typeof p === "string" ? (p as Purpose) : null; } catch { return null; }
}

/** After a form was sent: is the same form still there, as it was? Then it
 *  didn't go — the page's words near it say why (a missing field, an error). */
export function stillThere(before: Form, after: Form[]): Form | null {
    const sig = (f: FormGroup) => `${f.region}|${f.heading}|${f.controls.filter(c => c.visible).map(c => `${c.kind}:${c.label}`).join(",")}`;
    return after.find(f => sig(f) === sig(before)) ?? null;
}

export default { controlRefs, hasControls, formMapCode, purposeOf, classify, submitOf, formsText, labelSnapshot, signInFrom, formPurposeRequest, readFormPurpose, stillThere };

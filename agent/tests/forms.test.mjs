// forms.ts: what each form on a page is for, by rules — and the same read from
// a real page (browse.test.mjs has the page script in a browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { purposeOf, submitOf, formsText, labelSnapshot, signInFrom, classify, controlRefs, stillThere } from "../dist/forms.js";

const box = (ref, kind, label, extra = {}) => ({ ref, kind, label, autocomplete: "", visible: true, filled: false, ...extra });
const g = (o) => ({ region: "main", heading: "", controls: [], buttons: [], text: "", ...o });

test("purposes, the way password managers read them (BT, the footer newsletter, HA's Security page, 2026-10-17)", () => {
  assert.equal(purposeOf(g({ heading: "Autentifică-te în contul tău", controls: [box("e1", "text", "ID-ul tău de logare"), box("e2", "password", "Parola ta de Internet Banking")], buttons: [{ ref: "e3", name: "MERG MAI DEPARTE", submit: true }] })).purpose, "sign-in");
  assert.equal(purposeOf(g({ region: "footer", heading: "Abonează-te la newsletter", controls: [box("e9", "email", "Adresa de e-mail")], buttons: [{ ref: "e10", name: "Trimite", submit: true }] })).purpose, "newsletter");
  assert.equal(purposeOf(g({ region: "footer", controls: [box("e9", "email", "Your email")], buttons: [{ ref: "e10", name: "→", submit: true }] })).purpose, "newsletter", "an e-mail box alone in a footer");
  assert.equal(purposeOf(g({ heading: "Change password", controls: [box("a", "password", "Current password*"), box("b", "password", "New password*"), box("c", "password", "Confirm new password*")] })).purpose, "change-password");
  assert.equal(purposeOf(g({ heading: "Create your account", controls: [box("a", "email", "Email"), box("b", "password", "Password", { autocomplete: "new-password" }), box("c", "password", "Repeat password")] })).purpose, "sign-up");
  assert.equal(purposeOf(g({ heading: "Sign in", controls: [box("a", "email", "Email or phone", { autocomplete: "username" })], buttons: [{ ref: "n", name: "Next", submit: false }] })).purpose, "sign-in step");
  assert.equal(purposeOf(g({ controls: [box("a", "search", "Search")] })).purpose, "search");
  assert.equal(purposeOf(g({ controls: [box("a", "text", "Enter the code we sent", { autocomplete: "one-time-code" })] })).purpose, "code");
  assert.equal(purposeOf(g({ controls: [box("a", "text", "Promo code")] })).purpose, "other", "a promo code isn't a sign-in code");
  assert.equal(purposeOf(g({ controls: [box("a", "text", "Card number"), box("b", "text", "CVV")] })).purpose, "payment");
  assert.equal(purposeOf(g({ region: "nav", controls: [box("a", "email", "Email")] })).purpose !== "sign-in step", true, "never a username step in a nav");
});

test("a form is sent only with its own button — never the next section's \"Enable\"; the sign-in boxes only from a sign-in form", () => {
  const forms = classify([
    g({ heading: "Change password", controls: [box("a", "password", "Current password"), box("b", "password", "New password")], buttons: [{ ref: "s", name: "Submit", submit: true }] }),
    g({ heading: "Multi-factor authentication", controls: [box("x", "text", "Name")], buttons: [{ ref: "en", name: "Enable", submit: false }] }),
    g({ region: "footer", heading: "Newsletter", controls: [box("m", "email", "Email")], buttons: [{ ref: "t", name: "Subscribe", submit: true }] }),
  ]);
  assert.deepEqual(signInFrom(forms), {}, "no sign-in form here");
  assert.equal(submitOf(forms[1]), null, "Enable sends nothing");
  const bt = classify([g({ controls: [box("e48", "text", "ID-ul tău de logare"), box("e51", "password", "Parola ta")], buttons: [{ ref: "e60", name: "Mi-am uitat parola", submit: false }, { ref: "e53", name: "MERG MAI DEPARTE", submit: true }] })]);
  const s = signInFrom(bt);
  assert.equal(s.user.ref, "e48"); assert.equal(s.password.ref, "e51");
  assert.deepEqual(submitOf(bt[0]), { ref: "e53", name: "MERG MAI DEPARTE", submit: true });
  const text = formsText([...forms, ...bt]);
  assert.match(text, /change-password \[main\] "Change password"/);
  assert.match(text, /newsletter \[footer\]/);
  assert.match(text, /sign-in \[main\]: box "ID-ul tău de logare" \[ref=e48\], password "Parola ta" \[ref=e51\]; sent with "MERG MAI DEPARTE" \[ref=e53\]/);
});

test("nameless boxes get their labels; refs for boxes and buttons only; a form still there after its button", () => {
  const snap = `- textbox [ref=e48]\n- textbox [ref=e51]\n- link "Home" [ref=e1]\n- button "Go" [ref=e2]`;
  const forms = classify([g({ controls: [box("e48", "text", "ID-ul tău de logare"), box("e51", "password", "Parola ta")] })]);
  assert.match(labelSnapshot(snap, forms), /- textbox "ID-ul tău de logare" \[ref=e48\]/);
  assert.deepEqual(controlRefs(snap), ["e48", "e51", "e2"]);
  assert.ok(stillThere(forms[0], forms));
  assert.equal(stillThere(forms[0], []), null);
});

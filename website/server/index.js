// Gepetel website — backend.
//
// Serves the static marketing site (../client) and a MOCK payment flow:
//   GET  /pay?groupId=...&userId=...   → a fake checkout page
//   POST /pay/complete                 → forwards to the bot's /payment/callback
//                                        (which applies the new dailyReplyLimit)
//
// The real limit-update logic lives in the main gepetel app's POST
// /payment/callback; this site is just the checkout UI + a forwarder. The mock
// just lets you pick a limit and "pay" — no real charge.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(__dirname, "..", "client");

const PORT = process.env.PORT || 8080;
const PAYMENT_SECRET = process.env.PAYMENT_SECRET || "";
const BOT_CALLBACK_URL = process.env.BOT_CALLBACK_URL
  || "https://gepetel-qvhatkgsaq-ey.a.run.app/payment/callback";
const MAX_LIMIT = 10000;
const PRESETS = [128, 256, 512, 1024];

const app = express();
app.use(express.urlencoded({ extended: true }));

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:3rem auto;padding:0 1.2rem;color:#1a1a1a}
  h1{font-size:1.4rem} .card{border:1px solid #e6e6e6;border-radius:14px;padding:1.4rem;margin-top:1rem}
  .opt{display:block;border:1px solid #ddd;border-radius:10px;padding:.7rem .9rem;margin:.4rem 0;cursor:pointer}
  .opt:has(input:checked){border-color:#6b3fd4;background:#f4efff}
  input[type=number]{width:7rem;padding:.4rem}
  button{background:#6b3fd4;color:#fff;border:0;border-radius:10px;padding:.8rem 1.4rem;font-size:1rem;cursor:pointer;margin-top:1rem}
  .muted{color:#888;font-size:.85rem} .ok{color:#0a7d28} a{color:#6b3fd4}
</style></head><body>${body}</body></html>`;
}

// --- Mock checkout ---
app.get("/pay", (req, res) => {
  const groupId = String(req.query.groupId || "");
  const userId = String(req.query.userId || "");
  if (!groupId || !userId) {
    res.status(400).send(page("Missing info", `<h1>Missing payment details</h1><p class="muted">This link needs a groupId and userId.</p>`));
    return;
  }
  const opts = PRESETS.map((n, i) =>
    `<label class="opt"><input type="radio" name="limit" value="${n}" ${i === 1 ? "checked" : ""}> ${n} messages / day</label>`
  ).join("");
  res.send(page("Extend Gepetel's daily limit", `
    <h1>Extend Gepetel's daily limit 🤖</h1>
    <p class="muted">Choose how many messages Gepetel can send per day in this group, then "pay" (this is a mock — no real charge).</p>
    <div class="card">
      <form method="POST" action="/pay/complete">
        <input type="hidden" name="groupId" value="${esc(groupId)}">
        <input type="hidden" name="userId" value="${esc(userId)}">
        ${opts}
        <label class="opt">Custom: <input type="number" name="customLimit" min="1" max="${MAX_LIMIT}" placeholder="e.g. 2000"></label>
        <button type="submit">Pay (mock)</button>
      </form>
    </div>
    <p class="muted">Group: ${esc(groupId)}</p>
  `));
});

// --- Process the mock payment → call the bot callback ---
app.post("/pay/complete", async (req, res) => {
  const groupId = String(req.body.groupId || "");
  const userId = String(req.body.userId || "");
  const limit = Number(req.body.customLimit) >= 1 ? Number(req.body.customLimit) : Number(req.body.limit);

  if (!groupId || !userId || !(limit >= 1) || limit > MAX_LIMIT) {
    res.status(400).send(page("Invalid", `<h1>Invalid payment</h1><p class="muted">Missing or out-of-range values.</p>`));
    return;
  }
  try {
    const r = await fetch(BOT_CALLBACK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Payment-Secret": PAYMENT_SECRET },
      body: JSON.stringify({ groupId, userId, limit }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("Bot callback failed:", r.status, txt);
      res.status(502).send(page("Payment problem", `<h1>Hmm, that didn't go through</h1>
        <p class="muted">Gepetel couldn't apply the new limit (status ${r.status}). Please try again later.</p>`));
      return;
    }
    res.send(page("Payment successful", `
      <h1 class="ok">Payment successful ✅</h1>
      <div class="card">
        <p>Gepetel can now send up to <b>${limit} messages/day</b> in that group.</p>
        <p class="muted">Head back to WhatsApp — Gepetel will announce it in the group and message you a confirmation.</p>
      </div>`));
  } catch (e) {
    console.error("Payment forward error:", e);
    res.status(502).send(page("Payment problem", `<h1>Couldn't reach Gepetel</h1><p class="muted">Please try again later.</p>`));
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "gepetel-website-server", callbackConfigured: !!PAYMENT_SECRET });
});

// Static marketing site (index.html, faq.html, privacy.html, assets).
app.use(express.static(CLIENT_DIR));

app.listen(PORT, () => {
  console.log(`Gepetel website server listening on :${PORT}`);
});

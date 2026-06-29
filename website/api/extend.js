// Vercel serverless function: receives the (mock) checkout submission and forwards
// it to the bot's /payment/callback, which actually applies the one-time free
// limit extension. No real charge happens.
//
// Env (set in the Vercel project):
//   PAYMENT_SECRET    — must match the bot's PAYMENT_SECRET (Secret Manager)
//   BOT_CALLBACK_URL  — the bot's callback (defaults to the prod Cloud Function)

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { groupId, userId, additional, email } = body || {};
  const add = Number(additional);

  if (!groupId || !userId || ![100, 200, 500].includes(add)) {
    res.status(400).json({ error: "invalid_parameters" });
    return;
  }

  const url = process.env.BOT_CALLBACK_URL
    || "https://gepetel-qvhatkgsaq-ey.a.run.app/payment/callback";

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Payment-Secret": process.env.PAYMENT_SECRET || "" },
      body: JSON.stringify({ groupId, userId, additional: add, email: email || "" }),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);   // relay the bot's status (200 / 409 already_extended / etc.)
  } catch (e) {
    console.error("Forward to bot callback failed:", e);
    res.status(502).json({ error: "upstream_unreachable" });
  }
}

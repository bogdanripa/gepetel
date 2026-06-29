# Gepetel website

Marketing + onboarding site for [Gepetel](https://github.com/bogdanripa/gepetel),
the WhatsApp group bot. Lets visitors add Gepetel to a group and explains what it
does once it's in. Deploys to **gepetel.bogdanripa.com**.

```
website/
├── client/     # the website itself
│   ├── index.html        # landing page (entry point)
│   ├── faq.html
│   ├── privacy.html
│   └── assets/gepetel.png
└── server/     # Node.js (Express) backend — hello-world for now
```

## Client

Static, hand-written HTML pages — all content lives in the markup (no client-side
rendering), so they load instantly and are fully readable by crawlers and LLMs.
The landing page is `index.html` — point your host's root at it. Pages link to
each other with relative URLs and share an identical sticky header. The "Add to a
group" CTA opens a `wa.me` chat with Gepetel (number `+40 750 271 099`) pre-filled
with a friendly first message; the home page also shows a scannable QR for the same.

To change the WhatsApp number or pre-filled message, update the `wa.me` links
(and the sticky-note message on `index.html`) directly in the HTML.

## Server

See `server/README.md`. Serves the static client and a **mock payment flow**
(`/pay` checkout → forwards to the bot's `/payment/callback`, which applies the
new daily limit).

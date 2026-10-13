# Chrome Web Store submission — Gepetel for Chrome

Everything the Developer Dashboard asks for, in the order it asks. The package is
`store/gepetel-chrome-<version>.zip` (`npm run zip`): `dist/` without the
development `key` (the store assigns its own key and id — see "After publishing").

## Store listing

**Name:** Gepetel for Chrome

**Summary** (132 characters max):
> Lets Gepetel use your Chrome for what you ask in your chat: its own tab group, your OK before anything that pays or sends.

(122 characters — the same text is the manifest's `description`, which the store caps at 132.)

**Description:**

> Gepetel is an assistant you talk to in your own chat. With the Gepetel app on your Mac, it can
> also do things in your Chrome for you: check the status of an order, read a bill, look something
> up on a site where you're signed in.
>
> This extension is how the Gepetel app on your Mac reaches Chrome. It works only with that app,
> on that Mac:
>
> • The first time the app connects, Chrome asks you: "Allow Gepetel to use this browser?" Nothing
>   connects without that yes, and a different app or key is asked about again.
> • Gepetel works in its own window and tab group. Your own tabs and windows are left alone.
> • Anything that pays, books, sends or deletes waits for your OK in the chat.
> • Gepetel never types a password or a card number. When a site needs you to sign in or solve a
>   check, it asks you, and you can do it from your phone with a one-time link, or on the Mac.
> • Nothing the extension sees leaves your Mac except through your own Gepetel app, to your own
>   chat. It has no servers of its own and shows no ads.
>
> You need the Gepetel app for Mac: gepetel.com/computer
>
> Based on Microsoft's Playwright Extension (Apache-2.0).

**Category:** Productivity · **Language:** English

**Graphics** (in `store/`):
- Icon: `icons/icon-128.png` (already in the package)
- Screenshots, 1280×800: `screenshot-1-allow.png`, `screenshot-2-window.png`
- Small promo tile, 440×280: `promo-small.png`

## Privacy practices

**Single purpose:**
> Let the Gepetel app on the person's own Mac use their Chrome, in a tab group of its own, to do
> what they ask Gepetel in their chat.

**Permission justifications:**

| Permission | Why |
|---|---|
| `debugger` | The Gepetel app drives the tabs in Gepetel's own group through the Chrome DevTools Protocol (Playwright): opening pages, reading them, clicking and typing for the person. Only tabs in Gepetel's group, only while the app is connected and the person has allowed it. |
| `tabs` | To open, find and close the tabs in Gepetel's group, and to follow a sign-in popup that one of them opens. |
| `tabGroups` | Gepetel works in a tab group of its own, kept apart from the person's tabs. |
| `scripting` | When another extension (a password manager) is active on a sign-in page, the debugger can't be used there; the person's taps and typing from their phone are delivered to that page by a short script instead, and its text fields located so the phone's keyboard opens. |
| `storage` | To remember which window is Gepetel's between jobs. |
| `identity`, `identity.email` | To tell the Gepetel app which Chrome profile the extension is in, so it opens pages in that profile and not another one. The email is only passed to the app on the same Mac. |
| Host permission `<all_urls>` | The person can ask Gepetel to do things on any site they use; a content script (only active in Gepetel's own tabs) takes other extensions' frames out of those tabs so the page stays usable. |

**Remote code:** No. All code is in the package. (Pages are driven over the DevTools Protocol by
the app on the same Mac; no code is fetched or run from elsewhere.)

**Data usage** — the dashboard's checkboxes:
- Collected: **Website content** and **User activity** (pages Gepetel opens, and the person's taps
  and typing during a takeover), **only** to provide the feature, sent **only** to the Gepetel
  app on the same Mac (127.0.0.1).
- Not collected: personally identifiable information beyond the Chrome profile's email (passed
  to the local app only), health, financial, authentication information (passwords are never
  read; a password the person types during a takeover goes straight into the page), personal
  communications, location.
- Certify: not sold to third parties; not used or transferred for purposes unrelated to the
  single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:** https://gepetel.com/privacy (the "Your computer" section).

## Review notes (for the reviewer)

> The extension does nothing on its own. It works only when the Gepetel app for Mac connects to it
> over a local WebSocket (Playwright's extension protocol), and only after the person clicks
> "Allow" on the extension's own connect page. To try it: install the app from
> gepetel.com/computer, pair it with a chat, choose "Connect Chrome…" in its menu.

## After publishing

The store gave the extension its id: `fegpkhbbnkdhfkjmmpcjhekmpembllbk`. Its public key is
`store/store-public-key.pem` (checked: the key's SHA-256 gives that id). Once it's approved:
1. Put that key's base64 body into `manifest.json` (`key`), so unpacked development builds get the
   same id, and the id into `agent/src/extension.ts`.
2. In the Mac app, "Connect Chrome…" sends people to the store listing instead of the developer
   build.
3. Release the app.

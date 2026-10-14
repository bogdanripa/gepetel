# Acceptance run: a fresh Mac in under 5 minutes (GEP-30, Phase 8)

> A fresh Mac with no developer tools goes from download to "is my computer on?" in under 5
> minutes, with the only clicks being install, Add to Chrome and typing the code.

Run it once the extension is on the Chrome Web Store (`chrome/store/listing.md`): "Add to Chrome"
is one of the three clicks.

## The Mac

A new macOS user account on any Mac is fresh enough: no Gepetel, no Chrome profile, no
developer tools in its PATH, no Keychain items. (System Settings → Users & Groups → Add User;
a standard account, not an administrator.) Install Chrome in it first, and sign in to Chrome
with any Google account. That's the starting point, and it isn't timed.

## Timed, from the first click

| # | Step | Expect | Time |
|---|---|---|---|
| 1 | Open gepetel.com/computer, download the app | The .dmg, signed and notarized: no warning when it opens | |
| 2 | Drag Gepetel to Applications, open it | A menu-bar icon; no "install developer tools?" dialog | |
| 3 | In the private chat with Gepetel: "connect my computer" | A pairing code | |
| 4 | Gepetel menu → Connect to Gepetel… → type the code | "Connected — Gepetel can use this Mac" | |
| 5 | Gepetel menu → Connect Chrome… → Add to Chrome (the store page) → Allow | "Chrome Connected" | |
| 5b | Right after: "Let Gepetel use the mouse and keyboard" — why, in a sentence → Continue → macOS's dialog → turn on Gepetel under Accessibility | "Done" from Gepetel, by itself (it checks) | |
| 6 | In the chat: "is my computer on?" | Yes, with the Mac's name | |

**Pass:** step 6 answered within 5 minutes of step 1, and the only clicks beyond typing the code
were install (step 2), Add to Chrome and Allow (step 5), and the Accessibility switch (5b) —
macOS's own, which no app can flip for you.

## Also note

- Anything macOS asked (Keychain, Login Items, notifications) and whether it was expected.
- How long the download took, separately: a slow network isn't the app's fault.
- The Gepetel log (menu → Show Log) if anything went wrong; it holds no secrets.
- Then ask a browse task ("what's on the front page of example.com?") to see Chrome in use.

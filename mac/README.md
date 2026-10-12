# Gepetel for Mac

The menu-bar app. It bundles Node and the agent in `../agent`, so installing it
needs nothing else: no Node, no Homebrew, no Terminal. Pairing is typing the
six-digit code from the WhatsApp chat into the app.

## What it does

- Runs the agent (`node agent/dist/index.js run`) as a child process and keeps
  it running. The agent prints `@status {json}` lines when `GEPETEL_APP=1`, and
  the menu reflects those. Its stdin is a pipe from the app, so if the app dies
  the agent stops too.
- Menu: connection state, Connect… (the code box) or Disconnect…, Let Commands
  Use the Internet (`shell_network` in `agent.json`), Open Workspace Folder,
  Check the Sandbox… (`selftest`), Open at Login (`SMAppService`, on by default
  at first run), Show Log (`~/Library/Logs/Gepetel/agent.log`), Quit.
- Keeps the Mac from idle-sleeping while a job runs.
- Offers to move itself to Applications when opened from the disk image.
- **Updates itself without asking** (`Sources/Gepetel/Updater.swift`). Every
  six hours it checks for the highest `mac-v*` GitHub release. It installs the
  new app only if the app is signed by the same Apple Team ID as the running
  one and Gatekeeper accepts it (so Apple notarized it). It waits until no job
  is running, then swaps the app in place and relaunches. An ad-hoc build never
  updates itself.

## Build

```bash
mac/scripts/build.sh
```

That gives an ad-hoc-signed `mac/build/Gepetel.app` and `Gepetel.dmg`, which run
on this Mac only. Command Line Tools are enough; Xcode is not needed. With
`SIGN_IDENTITY` and the `NOTARY_*` variables set, the same script signs and
notarizes (see the header of the script).

`Gepetel.app/Contents/MacOS/Gepetel --self-check` checks the updater's version
comparison and prints the team the build is signed by.

## Release

```bash
git tag mac-v0.4.0 && git push origin mac-v0.4.0
```

The tag must match `agent/package.json`, and `.github/workflows/mac.yml`
checks it. Pushing the tag builds, signs, notarizes and publishes the release,
and every installed app picks it up within six hours. So bump the version
first: an app only updates to a higher number.

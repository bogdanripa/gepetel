#!/usr/bin/env node
// Opens the test-call page (src/voiceTestPage.ts) in the default browser.
// The call runs on the live relay; this only opens the page. Log in with
// any username and CRON_SECRET as the password (same as /groups/).
// Usage: node scripts/voice-local.mjs [base-url]
import { spawn } from "node:child_process";
const base = (process.argv[2] || process.env.GEPETEL_URL || "https://gepetel.com").replace(/\/+$/, "");
const url = `${base}/voice/test`;
console.log(`Opening ${url}`);
const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();

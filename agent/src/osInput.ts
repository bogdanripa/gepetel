// Real input from macOS, done by the Gepetel app (mac/Sources/Gepetel/OSInput.swift).
//
// For a Chrome tab the debugger can't reach (another extension's frame in it
// — iCloud Passwords on every sign-in page), the extension can only click from
// inside the page: not a user gesture, and "Sign in with Google" did nothing
// from the owner's phone (2026-10-14). The app moves the actual pointer and
// presses real keys instead. Asked for in one `@input {json}` line on stdout;
// answered with one `{"t":"input-done", …}` line on stdin. Only under the app.

import { appChannel } from "./appChannel.js";

export type OsInputReq = { op: "check" | "tap" | "text" | "key" | "scroll" | "drag" | "passkey"; [k: string]: unknown };
/** found: the title of a passkey window the app cancelled ("passkey"). */
export type OsInputRes = { ok: boolean; why: string; geo?: string; found?: string };

const channel = appChannel<OsInputReq, OsInputRes>({ tag: "input", done: "input-done", idPrefix: "i", timeoutMs: 20_000,
    read: m => ({ ok: m.ok === true, why: String(m.why || ""), ...(m.geo ? { geo: String(m.geo).slice(0, 300) } : {}), ...(m.found ? { found: String(m.found).slice(0, 120) } : {}) }) });

/** Under the app: requests go out on stdout. */
export const enableOsInput = channel.enable;
export const osInputAvailable = channel.available;
/** One request; never logged with what's typed (the app logs the op only). */
export const osInput = channel.ask;
/** A line from the app on stdin: true when it was an answer to us. */
export const osInputAnswer = channel.answer;

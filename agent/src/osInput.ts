// Real input from macOS, done by the Gepetel app (mac/Sources/Gepetel/OSInput.swift).
//
// For a Chrome tab the debugger can't reach (another extension's frame in it
// — iCloud Passwords on every sign-in page), the extension can only click from
// inside the page: not a user gesture, and "Sign in with Google" did nothing
// from the owner's phone (2026-10-14). The app moves the actual pointer and
// presses real keys instead. Asked for in one `@input {json}` line on stdout;
// answered with one `{"t":"input-done", …}` line on stdin. Only under the app.

export type OsInputReq = { op: "check" | "tap" | "text" | "key" | "scroll" | "drag"; [k: string]: unknown };
export type OsInputRes = { ok: boolean; why: string };

const waiting = new Map<string, (r: OsInputRes) => void>();
let seq = 0;
let write: ((line: string) => void) | null = null;

/** Under the app: requests go out on stdout. */
export function enableOsInput(out: (line: string) => void = l => process.stdout.write(l + "\n")): void { write = out; }

export function osInputAvailable(): boolean { return !!write; }

/** One request; never logged with what's typed (the app logs the op only). */
export function osInput(req: OsInputReq, timeoutMs = 20_000): Promise<OsInputRes> {
    if (!write) return Promise.resolve({ ok: false, why: "not running under the Gepetel app" });
    const id = `i${++seq}`;
    return new Promise(resolve => {
        const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, why: "the app didn't answer" }); }, timeoutMs);
        waiting.set(id, r => { clearTimeout(timer); resolve(r); });
        write!(`@input ${JSON.stringify({ ...req, id })}`);
    });
}

/** A line from the app on stdin: true when it was an answer to us. */
export function osInputAnswer(msg: any): boolean {
    if (msg?.t !== "input-done") return false;
    const done = waiting.get(String(msg.id || ""));
    if (done) { waiting.delete(String(msg.id)); done({ ok: msg.ok === true, why: String(msg.why || "") }); }
    return true;
}

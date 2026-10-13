// A minimal MCP client over stdio, for exactly one server: Playwright MCP.
//
// The agent is that server's only client — nothing else on the Mac talks to
// it — so this is JSON-RPC over newline-delimited stdio and nothing more: no
// SDK, no transport negotiation, one dependency fewer in an app that ships its
// own node_modules.
//
// The child runs in a folder of its own: Playwright MCP writes snapshot and
// console files into its working directory, and those must land in a private
// scratch folder, not wherever the agent happened to start.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

/** An address fit for a log: site and path, never the query or the
 *  fragment — where a form's fields, a password or a sign-in code can be. */
export function logUrl(url: string | undefined): string {
    if (!url) return "-";
    try { const u = new URL(url); return /^(https?|chrome-extension):$/.test(u.protocol) ? (`${u.protocol}//${u.host}${u.pathname}`).slice(0, 120) : url.slice(0, 40); } catch { return "(an address)"; }
}

export type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
export type McpResult = { content: McpContent[]; isError?: boolean };

export class McpClient {
    private child: ChildProcess | null = null;
    private seq = 0;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private buf = "";
    private stderr = "";

    constructor(private cmd: string, private args: string[], private opts: { cwd: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }) {}

    async start(): Promise<void> {
        fs.mkdirSync(this.opts.cwd, { recursive: true });
        this.child = spawn(this.cmd, this.args, {
            cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout!.on("data", d => this.onData(String(d)));
        this.child.stdin!.on("error", e => this.opts.log?.(`mcp stdin: ${e.message}`));   // never an uncaught crash
        this.child.stderr!.on("data", d => {
            this.stderr = (this.stderr + String(d)).slice(-4000);
            for (const l of String(d).split("\n")) if (l.trim()) this.opts.log?.(`mcp stderr: ${l.slice(0, 300)}`);
        });
        this.child.on("exit", code => {
            this.opts.log?.(`mcp exited (${code})`);
            for (const [, w] of this.waiting) { clearTimeout(w.timer); w.reject(new Error(`the browser connection ended (${code})${this.stderr ? `: ${this.stderr.trim().split("\n").pop()}` : ""}`)); }
            this.waiting.clear();
            this.child = null;
        });
        await this.request("initialize", {
            protocolVersion: "2025-06-18", capabilities: {},
            // The name the extension shows on Gepetel's tab group.
            clientInfo: { name: "Gepetel", version: "1" },
        }, 30_000);
        this.notify("notifications/initialized");
    }

    async call(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpResult> {
        // Every browser action in the log, with how long it took — while this
        // is being developed, the log is how a run on someone's Mac is read.
        // Successful takeover frames are left out: four a second would bury
        // everything else.
        const t0 = Date.now();
        const brief = () => JSON.stringify(args, (k, v) => k === "code" || k === "function" ? String(v).slice(0, 80) : k === "url" ? logUrl(String(v)) : v).slice(0, 200);
        try {
            const r = await this.request("tools/call", { name, arguments: args }, timeoutMs);
            const out: McpResult = { content: Array.isArray(r?.content) ? r.content : [], isError: !!r?.isError };
            // The pointer drifting while the model thinks (human.ts) isn't logged either.
            const quiet = name === "browser_take_screenshot" || String(args.code ?? "").startsWith("/*quiet*/");
            if (out.isError || !quiet) {
                const url = out.content.map(c => c.text || "").join("\n").match(/- Page URL: (.+)/)?.[1];
                this.opts.log?.(`mcp ${name} ${brief()} → ${out.isError ? "ERROR " + out.content.map(c => c.text).join(" ").slice(0, 200) : "ok"}${url ? ` @ ${logUrl(url)}` : ""} (${Date.now() - t0} ms)`);
            }
            return out;
        } catch (e: any) {
            this.opts.log?.(`mcp ${name} ${brief()} → FAILED ${String(e?.message || e).slice(0, 200)} (${Date.now() - t0} ms)`);
            throw e;
        }
    }

    close(): void {
        this.closing = true;
        try { this.child?.stdin?.end(); } catch { /* gone */ }
        const c = this.child;
        if (c) setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref?.();
    }

    private closing = false;

    private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
        // After close: a late call (the takeover putting the page size back
        // as the job ends) wrote into a closed pipe, and the "write after end"
        // error took the whole agent down.
        if (!this.child || this.closing) return Promise.reject(new Error("the browser connection is not running"));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                reject(new Error(`the browser did not answer ${method} in ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            this.waiting.set(id, { resolve, reject, timer });
            this.child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
    }

    private notify(method: string): void {
        this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
    }

    private onData(chunk: string): void {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let msg: any;
            try { msg = JSON.parse(line); } catch { continue; }
            const w = typeof msg?.id === "number" ? this.waiting.get(msg.id) : undefined;
            if (!w) continue;   // a notification, or a request from the server we do not serve
            clearTimeout(w.timer);
            this.waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(String(msg.error?.message || "browser error")));
            else w.resolve(msg.result);
        }
    }
}

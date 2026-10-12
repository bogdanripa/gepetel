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

export type McpContent = { type: string; text?: string; data?: string; mimeType?: string };
export type McpResult = { content: McpContent[]; isError?: boolean };

export class McpClient {
    private child: ChildProcess | null = null;
    private seq = 0;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private buf = "";
    private stderr = "";

    constructor(private cmd: string, private args: string[], private opts: { cwd: string; env?: NodeJS.ProcessEnv }) {}

    async start(): Promise<void> {
        fs.mkdirSync(this.opts.cwd, { recursive: true });
        this.child = spawn(this.cmd, this.args, {
            cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stdout!.on("data", d => this.onData(String(d)));
        this.child.stderr!.on("data", d => { this.stderr = (this.stderr + String(d)).slice(-4000); });
        this.child.on("exit", code => {
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
        const r = await this.request("tools/call", { name, arguments: args }, timeoutMs);
        return { content: Array.isArray(r?.content) ? r.content : [], isError: !!r?.isError };
    }

    close(): void {
        try { this.child?.stdin?.end(); } catch { /* gone */ }
        const c = this.child;
        if (c) setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, 2000).unref?.();
    }

    private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
        if (!this.child) return Promise.reject(new Error("the browser connection is not running"));
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

// `send_file` — put a picture made on the Mac into the chat.
//
// Without it, a chart drawn in the sandbox existed only as a file in the
// workspace, and the model, with no way to show it, improvised a chart out of
// text characters and told the person a file name. What they asked for was the
// picture.
//
// The bytes go to the relay alongside the result, never inside it: the relay
// sends them to WhatsApp and the model is told only "sent". An image in the
// model's context would be billed on every reply for as long as it stayed in
// the window.
//
// The rules, all checked here and again on the relay:
//  - **Only the workspace.** The path is resolved to its real location, so a
//    symlink in the workspace pointing at ~/.ssh is refused like the key itself.
//  - **Only images, by their bytes.** PNG, JPEG, GIF and WebP go as they are; a
//    file named .png that is not one is refused.
//  - **SVG is rendered, in the sandbox.** WhatsApp cannot show SVG, and it is the
//    one image format a script can write with nothing installed. macOS renders
//    it (the app's `--render-svg`, AppKit's own SVG support); that runs under the
//    same Seatbelt policy as any command, so a hostile SVG is parsed by a
//    process that cannot read the person's files.
//  - **5 MB at most**, which is what WhatsApp takes.
import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "./sandbox.js";

export const MAX_BYTES = 5 * 1024 * 1024;

export type Image = { mime: string; b64: string; name: string };
export type SendResult = { ok: boolean; content: string; image?: Image };

/** What the bytes are, not what the name says. */
export function sniff(head: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "svg" | null {
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString("latin1"))) return "image/gif";
    if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
    const text = head.toString("utf8").replace(/^﻿/, "").trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
    return null;
}

/** The file the model named, as a real path inside the workspace — or why not.
 *  Accepts the forms a model writes: `chart.png`, `/workspace/chart.png`,
 *  `~/Gepetel/workspace/chart.png`, or the absolute path. */
export function resolveInWorkspace(workspace: string, asked: string): { file: string } | { why: string } {
    let p = String(asked ?? "").trim();
    if (!p) return { why: "Say which file to send." };
    const root = fs.realpathSync(workspace);
    p = p.replace(/^~\/Gepetel\/workspace\/?/, "").replace(/^\/workspace\/?/, "");
    const candidate = path.isAbsolute(p) ? p : path.join(root, p);
    let real: string;
    try { real = fs.realpathSync(candidate); }
    catch { return { why: `There is no ${path.basename(p) || "such file"} in the working folder.` }; }
    if (real !== root && !real.startsWith(root + path.sep)) {
        return { why: "Only files in the computer's working folder can be sent." };
    }
    const st = fs.statSync(real);
    if (!st.isFile()) return { why: `${path.basename(real)} is not a file.` };
    return { file: real };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function sendFile(args: { path?: unknown; caption?: unknown }, opts: {
    workspace: string;
    sandbox: Sandbox | null;
    /** The app's own executable, which can render SVG. Absent when the agent
     *  runs on its own from a checkout. */
    renderer?: string;
}): Promise<SendResult> {
    const where = resolveInWorkspace(opts.workspace, String(args.path ?? ""));
    if ("why" in where) return { ok: false, content: where.why };
    const file = where.file;
    const name = path.basename(file);
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES) return { ok: false, content: `${name} is ${(size / 1048576).toFixed(1)} MB; the most that can be sent is 5 MB.` };

    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(1024);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const kind = sniff(head.subarray(0, n));
    if (!kind) return { ok: false, content: `${name} is not an image (PNG, JPEG, GIF, WebP or SVG), so it can't be shown in the chat.` };

    let bytes: Buffer, mime: string, sentName = name;
    if (kind === "svg") {
        if (!opts.renderer || !fs.existsSync(opts.renderer)) {
            return { ok: false, content: "This computer can't turn an SVG into a picture; make a PNG instead." };
        }
        if (!opts.sandbox) return { ok: false, content: "The sandbox isn't set up on this computer, so the SVG can't be rendered." };
        const outDir = path.join(opts.sandbox.toolbox, "render");
        fs.mkdirSync(outDir, { recursive: true });
        const out = path.join(outDir, `${name.replace(/\.svg$/i, "")}-${Date.now().toString(36)}.png`);
        // By its real path: the sandbox allows the renderer's resolved bundle,
        // and exec through a symlink outside it is refused.
        const renderer = fs.realpathSync(opts.renderer);
        const r = await opts.sandbox.run(`${q(renderer)} --render-svg ${q(file)} ${q(out)}`, 30);
        if (!r.ok || !fs.existsSync(out)) {
            return { ok: false, content: `Couldn't render ${name}: ${r.content.split("\n").slice(-2).join(" ").slice(0, 200)}` };
        }
        bytes = fs.readFileSync(out);
        fs.rmSync(out, { force: true });
        if (sniff(bytes.subarray(0, 16)) !== "image/png") return { ok: false, content: `Couldn't render ${name}.` };
        if (bytes.length > MAX_BYTES) return { ok: false, content: `${name} renders larger than 5 MB; make it smaller.` };
        mime = "image/png";
        sentName = name.replace(/\.svg$/i, "") + ".png";
    } else {
        bytes = fs.readFileSync(file);
        mime = kind;
    }
    return {
        ok: true,
        content: "Sent to the chat.",
        image: { mime, b64: bytes.toString("base64"), name: sentName },
    };
}

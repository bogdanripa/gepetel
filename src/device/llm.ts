// `POST /device/llm` — the only way the computer reaches a model.
//
// The browser loop runs on the Mac (that is where the browser is) but thinks
// with a model, and the Mac must never hold an OpenAI key: it is someone
// else's machine. So the agent asks here, with its device token, and we call
// OpenAI with ours.
//
// Which makes this the place every limit lives, because a device token that
// leaks must not become an open OpenAI account:
//
//  - **Models:** an allowlist. Default luna; nano for cheap checks.
//  - **Tools:** plain function tools only — the loop's own. No hosted tools
//    (web search, code interpreter, MCP, file search): those would let the
//    caller spend on things that are not this loop.
//  - **Size:** input capped in characters before anything is sent, output
//    capped in tokens.
//  - **Budget:** a daily token allowance per device, checked before a call and
//    charged after it. Over it, the answer is a 429 in words the agent passes
//    on, not a silent failure.
//  - **Accounting:** every call is logged per device and per job, which is
//    what the spec's cost telemetry and any future billing read.
import express, { type Express, type Request, type Response } from "express";
import mongoose from "mongoose";
import OpenAI from "openai";
import store from "./store.js";
import jobs from "./jobs.js";

export const MODELS = ["gpt-5.6-luna", "gpt-5-nano"] as const;
export const DEFAULT_MODEL = "gpt-5.6-luna";
/** Characters of input, all of it (instructions + messages + tool schemas). */
export const MAX_INPUT_CHARS = 400_000;
export const MAX_OUTPUT_TOKENS = 4_000;
/** Per device per UTC day, input + output. Overridable for one person. */
export const DAILY_TOKENS = Number(process.env.DEVICE_LLM_DAILY_TOKENS) || 2_000_000;

const usageSchema = new mongoose.Schema({
    device_id: { type: String, required: true },
    day: { type: String, required: true },   // YYYY-MM-DD, UTC
    calls: { type: Number, default: 0 },
    input_tokens: { type: Number, default: 0 },
    output_tokens: { type: Number, default: 0 },
    created_at: { type: Date, default: Date.now, expires: 90 * 24 * 3600 },
});
usageSchema.index({ device_id: 1, day: 1 }, { unique: true });
const DeviceUsage = mongoose.model("DeviceUsage", usageSchema);

export const usage = {
    async today(deviceId: string, day = new Date().toISOString().slice(0, 10)): Promise<number> {
        const row: any = await DeviceUsage.findOne({ device_id: deviceId, day }).lean();
        return row ? (row.input_tokens || 0) + (row.output_tokens || 0) : 0;
    },
    async charge(deviceId: string, input: number, output: number, day = new Date().toISOString().slice(0, 10)): Promise<void> {
        await DeviceUsage.updateOne({ device_id: deviceId, day },
            { $inc: { calls: 1, input_tokens: input, output_tokens: output } }, { upsert: true });
    },
};

/** Per-job totals, for the spec's per-job telemetry. Best effort. */
export const jobUsage = {
    async charge(jobId: string, input: number, output: number): Promise<void> {
        await mongoose.connection.collection("devicejobs").updateOne({ job_id: jobId },
            { $inc: { llm_calls: 1, input_tokens: input, output_tokens: output } });
    },
};

let client: OpenAI | null = null;
export const openai = {
    create: async (req: any): Promise<any> => {
        client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        return client.responses.create(req);
    },
};

/**
 * The request we will actually send, built from only what the loop may ask
 * for — or why not. Everything not named here is dropped, not passed through.
 */
export function sanitize(body: any): { req: any } | { status: number; why: string } {
    const model = body?.model === undefined ? DEFAULT_MODEL : String(body.model);
    if (!(MODELS as readonly string[]).includes(model)) return { status: 400, why: `model not allowed: ${model}` };
    if (!Array.isArray(body?.input) && typeof body?.input !== "string") return { status: 400, why: "input is required" };

    const tools = body?.tools === undefined ? undefined : body.tools;
    if (tools !== undefined) {
        if (!Array.isArray(tools) || tools.length > 32) return { status: 400, why: "tools must be a list of at most 32" };
        for (const t of tools) {
            if (t?.type !== "function" || typeof t?.name !== "string") {
                return { status: 400, why: "only function tools are allowed" };
            }
        }
    }
    const req: any = {
        model,
        input: body.input,
        store: false,
        max_output_tokens: Math.min(MAX_OUTPUT_TOKENS, Math.max(16, Number(body?.max_output_tokens) || 1500)),
    };
    if (typeof body?.instructions === "string") req.instructions = body.instructions;
    if (tools) req.tools = tools;
    if (body?.tool_choice === "auto" || body?.tool_choice === "required" || body?.tool_choice === "none") req.tool_choice = body.tool_choice;
    if (body?.parallel_tool_calls === false) req.parallel_tool_calls = false;
    const effort = body?.reasoning?.effort;
    if (["minimal", "low", "medium", "high"].includes(effort)) req.reasoning = { effort };

    const size = JSON.stringify([req.instructions ?? "", req.input, req.tools ?? []]).length;
    if (size > MAX_INPUT_CHARS) return { status: 413, why: `input too large (${size} chars, max ${MAX_INPUT_CHARS})` };
    return { req };
}

async function handleLlm(req: Request, res: Response): Promise<void> {
    const hdr = String(req.get("authorization") || "");
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    const device = token ? await store.deviceForToken(token).catch(() => null) : null;
    if (!device) { res.status(401).json({ error: "not paired" }); return; }

    const clean = sanitize(req.body);
    if ("why" in clean) { res.status(clean.status).json({ error: clean.why }); return; }

    const spent = await usage.today(device.device_id).catch(() => 0);
    if (spent >= DAILY_TOKENS) {
        console.warn(`device ${device.device_id} llm refused: daily budget spent (${spent})`);
        res.status(429).json({ error: "This computer has used today's thinking budget. It resets at midnight UTC." });
        return;
    }

    // A job id the device names is only counted against it if it is this
    // device's job — accounting must not be pointable at someone else's row.
    const jobId = String(req.body?.job_id || "");
    const job = jobId ? await jobs.getJob(jobId).catch(() => null) : null;
    const ownJob = job && job.device_id === device.device_id ? job.job_id : "";

    try {
        const out = await openai.create(clean.req);
        const input = Number(out?.usage?.input_tokens) || 0;
        const output = Number(out?.usage?.output_tokens) || 0;
        await usage.charge(device.device_id, input, output).catch((e: any) => console.error("llm usage not charged:", e?.message || e));
        if (ownJob) await jobUsage.charge(ownJob, input, output).catch(() => {});
        console.log(`device ${device.device_id} llm ${clean.req.model}${ownJob ? ` job ${ownJob}` : ""} in=${input} out=${output}`);
        res.json({ output: out?.output ?? [], output_text: out?.output_text ?? "", usage: { input_tokens: input, output_tokens: output } });
    } catch (e: any) {
        console.error(`device ${device.device_id} llm failed:`, e?.status || "", e?.message || e);
        res.status(502).json({ error: "the model could not be reached" });
    }
}

export function registerLlmRoute(app: Express): void {
    // 3 MB: a page snapshot is ~50 KB, a screenshot a few hundred; the
    // character cap in sanitize() is what actually bounds what is sent on.
    app.post("/device/llm", express.json({ limit: "3mb" }), handleLlm);
}

export default { registerLlmRoute, sanitize, usage, jobUsage, openai, MODELS, DAILY_TOKENS };

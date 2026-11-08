// What the models cost us, per day and model, kept where a deploy can't wipe it.
//
// The [usage] log line was the only record, and every deploy replaced the
// container and its logs with it — so "can we afford a bigger model?" had no
// numbers behind it (2026-11-08). Every OpenAI client in the relay goes
// through meter(); one $inc per call, never awaited by the reply.
import mongoose from "mongoose";

const usageSchema = new mongoose.Schema({
    day: { type: String, required: true },      // YYYY-MM-DD, UTC
    model: { type: String, required: true },
    calls: { type: Number, default: 0 },
    input: { type: Number, default: 0 },
    cached: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    at: { type: Date, default: Date.now },
});
usageSchema.index({ day: 1, model: 1 }, { unique: true });
usageSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });
export const LlmUsage = mongoose.models.LlmUsage || mongoose.model("LlmUsage", usageSchema);

/** Dollars per million tokens: input, cached input, output (standard tier, 2026-11-08). */
export const PRICES: Record<string, [number, number, number]> = {
    "gpt-5.6-sol": [4, 0.4, 20],
    "gpt-5.6-terra": [2, 0.2, 12],
    "gpt-5.6-luna": [0.2, 0.02, 1.2],
    "gpt-5-mini": [0.25, 0.025, 2],
    "gpt-5-nano": [0.05, 0.005, 0.4],
};

/** What a call cost, in dollars; 0 for a model we have no price for. */
export function costOf(model: string, input: number, cached: number, output: number): number {
    const p = PRICES[model];
    if (!p) return 0;
    return ((input - cached) * p[0] + cached * p[1] + output * p[2]) / 1e6;
}

/** The counts in one response's usage block. */
export function tokensOf(res: any): { input: number; cached: number; output: number } {
    const u = res?.usage || {};
    return {
        input: u.input_tokens ?? 0,
        cached: u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
        output: u.output_tokens ?? 0,
    };
}

/** Count one response. Logs it, adds it to today's row; never throws. */
export function record(model: string, res: any): void {
    try {
        const t = tokensOf(res);
        const pct = t.input ? Math.round((100 * t.cached) / t.input) : 0;
        console.log(`[usage] model=${model} in=${t.input} cached=${t.cached} (${pct}%) out=${t.output}`);
        if (mongoose.connection.readyState !== 1) return;
        const day = new Date().toISOString().slice(0, 10);
        LlmUsage.updateOne({ day, model },
            { $inc: { calls: 1, input: t.input, cached: t.cached, output: t.output }, $set: { at: new Date() } },
            { upsert: true }).catch(() => {});
    } catch { /* never let counting break a reply */ }
}

/** Wrap a client's responses.create so every call is counted. */
export function meter<T extends { responses: { create: any } }>(client: T): T {
    const raw = client.responses.create.bind(client.responses);
    (client.responses as any).create = async (req: any, ...rest: any[]) => {
        const res = await raw(req, ...rest);
        record(String(req?.model || "?"), res);
        return res;
    };
    return client;
}

export default { meter, record, costOf, tokensOf, PRICES, LlmUsage };

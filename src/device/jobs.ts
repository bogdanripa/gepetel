// Jobs: work on the person's computer that outlived the reply that asked for it.
//
// A call becomes a job when it runs past CALL_TIMEOUT_MS, or the moment the
// agent asks the person a question — either way the model's turn has ended and
// the work goes on. From then on this row is what "how's that going?",
// "cancel that" and "it's Bogdan" are answered against, and it answers while
// the Mac is asleep, because it lives here and not there.
//
// It also remembers which events it has already delivered. The agent keeps an
// outbox and resends anything we did not acknowledge — so after a reconnect the
// same `done` can arrive twice, and the person must still see it once.
import mongoose from "mongoose";

export type JobStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

const jobSchema = new mongoose.Schema({
    job_id: { type: String, required: true, unique: true },
    device_id: { type: String, required: true, index: true },
    // Copied from the device when the job starts, and re-checked against the
    // device before anything is delivered: a job never outlives its pairing.
    chat_id: { type: String, required: true, index: true },
    tool: { type: String, default: "" },
    /** What it is, in a line: the command or the address. For status answers. */
    what: { type: String, default: "" },
    status: { type: String, default: "running" },
    question: { type: String, default: "" },
    progress: { type: String, default: "" },
    result: { type: String, default: "" },
    /** Event ids already handled, so a resent event is not delivered twice. */
    events_seen: { type: [String], default: [] },
    created_at: { type: Date, default: Date.now, expires: 30 * 24 * 3600 },
    updated_at: { type: Date, default: Date.now },
});
const DeviceJob = mongoose.model("DeviceJob", jobSchema);

export type JobRow = {
    job_id: string; device_id: string; chat_id: string; tool: string; what: string;
    status: JobStatus; question: string; progress: string; result: string;
    created_at: Date; updated_at: Date;
};

const asRow = (d: any): JobRow | null => d ? {
    job_id: d.job_id, device_id: d.device_id, chat_id: d.chat_id, tool: d.tool || "", what: d.what || "",
    status: d.status, question: d.question || "", progress: d.progress || "", result: d.result || "",
    created_at: d.created_at, updated_at: d.updated_at,
} : null;

/** A line saying what a call is, from its arguments. Never the whole thing. */
export function describeCall(tool: string, args: Record<string, unknown>): string {
    const what = tool === "shell" ? args.command : tool === "fetch_url" ? args.url : tool === "send_file" ? args.path : "";
    return String(what ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Record a job. Idempotent: promotion and an early question can race. */
export async function startJob(job: { job_id: string; device_id: string; chat_id: string; tool: string; what: string; status?: JobStatus; question?: string }): Promise<void> {
    await DeviceJob.updateOne(
        { job_id: job.job_id },
        {
            $setOnInsert: {
                job_id: job.job_id, device_id: job.device_id, chat_id: job.chat_id,
                tool: job.tool, what: job.what, created_at: new Date(),
            },
            $set: {
                status: job.status || "running",
                ...(job.question ? { question: job.question.slice(0, 1000) } : {}),
                updated_at: new Date(),
            },
        },
        { upsert: true },
    );
}

export async function getJob(jobId: string): Promise<JobRow | null> {
    return asRow(await DeviceJob.findOne({ job_id: String(jobId || "") }).lean());
}

/** The jobs a chat has that are not finished, newest first. */
export async function openJobs(chatId: string, limit = 5): Promise<JobRow[]> {
    const rows = await DeviceJob.find({ chat_id: chatId, status: { $in: ["running", "waiting"] } })
        .sort({ created_at: -1 }).limit(limit).lean();
    return rows.map(asRow).filter(Boolean) as JobRow[];
}

/** The chat's most recent job, finished or not — for "how did that go?". */
export async function latestJob(chatId: string): Promise<JobRow | null> {
    return asRow(await DeviceJob.findOne({ chat_id: chatId }).sort({ created_at: -1 }).lean());
}

/**
 * Note an event against its job, once.
 *
 * Returns false when this event id was already handled — the agent resent it
 * after a reconnect — and the caller must not deliver it again. The check and
 * the write are one update, so two copies arriving together cannot both win.
 */
export async function noteEvent(jobId: string, eventId: string, set: Partial<Pick<JobRow, "status" | "question" | "progress" | "result">>): Promise<boolean> {
    const clean: any = { updated_at: new Date() };
    if (set.status) clean.status = set.status;
    if (set.question !== undefined) clean.question = set.question.slice(0, 1000);
    if (set.progress !== undefined) clean.progress = set.progress.slice(0, 300);
    if (set.result !== undefined) clean.result = set.result.slice(0, 1500);
    const res = await DeviceJob.updateOne(
        { job_id: jobId, events_seen: { $ne: eventId } },
        { $set: clean, $push: { events_seen: { $each: [eventId], $slice: -100 } } },
    );
    return (res.matchedCount || 0) > 0;
}

export async function setStatus(jobId: string, status: JobStatus, extra: { question?: string } = {}): Promise<void> {
    await DeviceJob.updateOne({ job_id: jobId }, {
        $set: { status, updated_at: new Date(), ...(extra.question !== undefined ? { question: extra.question } : {}) },
    });
}

/** "running for 3m", "waiting for you", "done 2m ago". */
export function describeJob(j: JobRow, now = Date.now()): string {
    const ago = (d: Date) => {
        const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
        return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
    };
    const what = j.what ? ` \`${j.what}\`` : "";
    switch (j.status) {
        case "running": return `${j.job_id}: running for ${ago(j.created_at)}${what}${j.progress ? ` — ${j.progress}` : ""}`;
        case "waiting": return `${j.job_id}: waiting for their answer${what} — asked: ${j.question}`;
        case "done": return `${j.job_id}: done ${ago(j.updated_at)} ago${what}`;
        case "failed": return `${j.job_id}: failed ${ago(j.updated_at)} ago${what}`;
        case "cancelled": return `${j.job_id}: cancelled${what}`;
    }
}

export default { startJob, getJob, openJobs, latestJob, noteEvent, setStatus, describeCall, describeJob };

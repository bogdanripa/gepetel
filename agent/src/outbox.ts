// The outbox: what the computer has to tell the person, kept until Gepetel
// says it has it.
//
// An event — a result, a question — is written here before it is sent, and
// removed only when the relay acknowledges it. A Mac that loses its connection
// halfway (Wi-Fi drops, the lid closes, the server restarts) sends everything
// still here as soon as it is back, so a finished job's answer is never lost
// in the gap. The relay de-duplicates by event id, so a resend that crosses
// an acknowledgement in flight is harmless.
//
// Bounded, because a Mac that never reconnects must not grow a file forever:
// the newest 200 events, none older than a week.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type OutEvent = {
    t: "event"; id: string; job: string; tool?: string;
    kind: "progress" | "question" | "done" | "failed";
    text: string; at: number;
    /** A numbered screenshot that goes with a question. */
    image?: { mime: string; b64: string };
    /** The relay adds a one-time link to drive the tab from the phone. */
    takeover?: boolean;
};

const MAX_EVENTS = 200;
const MAX_AGE_MS = 7 * 24 * 3600_000;

export class Outbox {
    private events: OutEvent[] = [];

    constructor(private file: string) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Array.isArray(raw)) this.events = raw.filter(e => e && e.id && e.job);
        } catch { /* nothing kept, or unreadable: start empty */ }
        this.prune();
    }

    /** Keep an event, then hand it back to be sent. */
    add(e: Omit<OutEvent, "t" | "id" | "at">): OutEvent {
        const ev: OutEvent = { t: "event", id: `e_${crypto.randomBytes(6).toString("hex")}`, at: Date.now(), ...e };
        this.events.push(ev);
        this.prune();
        this.save();
        return ev;
    }

    /** The relay has it: forget it. */
    ack(id: string): void {
        const before = this.events.length;
        this.events = this.events.filter(e => e.id !== id);
        if (this.events.length !== before) this.save();
    }

    /** Everything not yet acknowledged, oldest first — what to resend. */
    pending(): OutEvent[] { return [...this.events]; }

    private prune(): void {
        const cutoff = Date.now() - MAX_AGE_MS;
        this.events = this.events.filter(e => e.at >= cutoff).slice(-MAX_EVENTS);
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
            const tmp = `${this.file}.tmp`;
            // 0600: an event can carry a command's output.
            fs.writeFileSync(tmp, JSON.stringify(this.events), { mode: 0o600 });
            fs.renameSync(tmp, this.file);
        } catch (e: any) {
            console.error(`outbox not saved: ${e?.message || e}`);
        }
    }
}

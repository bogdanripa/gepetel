// Requests to the Gepetel app, and its answers: one `@<tag> {json}` line on
// stdout, one `{"t":"<done>", "id", …}` line back on stdin. Real input
// (osInput.ts), people's details (people.ts) and sign-ins (passwords.ts) all
// talk to the app this way; this is the plumbing they share. Only under the
// app — elsewhere every request answers "not running under the Gepetel app".

export type AppAnswer = { ok: boolean; why: string };

export function appChannel<Req extends object, Res extends AppAnswer>(o: {
    /** The stdout line's tag: "input" → `@input {…}`. */
    tag: string;
    /** The answer's `t`: "input-done". */
    done: string;
    /** Request ids' prefix, for reading logs: i1, p1, w1. */
    idPrefix: string;
    /** The answer, checked and cut to size — never trusted as it came. */
    read: (msg: any) => Res;
    timeoutMs: number;
}) {
    const waiting = new Map<string, (r: Res) => void>();
    let seq = 0;
    let write: ((line: string) => void) | null = null;
    const fail = (why: string) => ({ ok: false, why }) as Res;
    return {
        /** Under the app: requests go out on stdout. */
        enable(out: (line: string) => void = l => process.stdout.write(l + "\n")): void { write = out; },
        available(): boolean { return !!write; },
        /** One request; the app logs its op only, never a value. */
        ask(req: Req, timeoutMs = o.timeoutMs): Promise<Res> {
            if (!write) return Promise.resolve(fail("not running under the Gepetel app"));
            const id = `${o.idPrefix}${++seq}`;
            return new Promise(resolve => {
                const timer = setTimeout(() => { waiting.delete(id); resolve(fail("the app didn't answer")); }, timeoutMs);
                waiting.set(id, r => { clearTimeout(timer); resolve(r); });
                write!(`@${o.tag} ${JSON.stringify({ ...req, id })}`);
            });
        },
        /** A line from the app on stdin: true when it was an answer to us. */
        answer(msg: any): boolean {
            if (msg?.t !== o.done) return false;
            const id = String(msg.id || "");
            const done = waiting.get(id);
            if (done) { waiting.delete(id); done(o.read(msg)); }
            return true;
        },
    };
}

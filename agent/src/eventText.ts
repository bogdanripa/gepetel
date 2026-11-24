/** What the person reads in WhatsApp when a long job finishes.
 *
 *  The agent writes it, not the model: delivery costs no tokens and nothing is
 *  re-worded on the way. One line saying which command it was — a result that
 *  arrives minutes later with no idea what it answers is a puzzle, not news.
 *
 *  That line says how it ended, and there are three ways, not two. A job
 *  that ran to its end and came back with "I couldn't reach the account or
 *  the payment" was headed "Done:" — the owner: "And why would you say
 *  'done' here?" (2026-11-24). `ok` only means the job gave an answer; whether
 *  what was asked got done is the answer's own business (browse: the model
 *  says so when it finishes), and when it didn't, the line doesn't claim it. */
export function eventText(call: any, out: { ok: boolean; content: string; meta?: Record<string, unknown> }): string {
    // A browse job has no url but a start_url: its site, then. Nothing at
    // all: no empty quotes ("Done: ``" on the owner's phone).
    const site = (u: unknown) => { try { return new URL(String(u)).host.replace(/^www\./, ""); } catch { return ""; } };
    const what = String(call?.tool === "shell" ? (call?.args?.command ?? "") : (call?.args?.url ?? site(call?.args?.start_url))).slice(0, 120);
    const ro = String(call?.chat_lang || "") === "Romanian";
    const q = what ? ` \`${what}\`` : "";
    const notDone = out.ok && out.meta?.not_done === true;
    const head = ro
        ? (!out.ok ? `N-a mers:${q}` : notDone ? `N-am reușit:${q}` : `Gata:${q}`)
        : (!out.ok ? `Failed:${q}` : notDone ? `Couldn't do it:${q}` : `Done:${q}`);
    return `${head}\n${out.content}`.slice(0, 1500);
}

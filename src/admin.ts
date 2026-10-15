// The review pages: what Gepetel said where, and the scheduled tasks — behind
// Basic auth with CRON_SECRET as the password. Moved out of app.ts as it was
// (2026-10-15); app.ts mounts it with registerAdminRoutes.
import express from "express";
import m from "./mongo.js";
import u from "./util.js";
import { scheduledTaskDeps } from "./cron.js";

const router = express.Router();
type Deps = { processIncomingMessage: (chatId: string, text: string, author: string, groupName: string | undefined, messageId: string) => Promise<unknown> };
let deps: Deps = { processIncomingMessage: async () => { throw new Error("admin routes not registered"); } };

// Escape user content before putting it into the review HTML.
export function escapeHtml(s: any): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Basic-auth gate for the review pages (password = CRON_SECRET, any username).
export function reviewAuthOk(req: any, res: any): boolean {
    // Constant time, and the whole password: one with a ':' in it was cut
    // at the colon and never matched (2026-10-15).
    if (u.secretEquals(u.basicAuthPassword(req.get("authorization")), process.env.CRON_SECRET)) return true;
    res.set("WWW-Authenticate", 'Basic realm="gepetel-review"');
    res.status(401).send("Authentication required");
    return false;
}

router.get('/groups/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const gl = await m.getGroupList();

    // `lastReplyAt` is when GEPETEL last spoke here — not the group's last
    // message. It's the field the reply gate measures silence from, so it's also
    // the honest answer to "is he still active in there?".
    const rows = gl.map((g: any) => ({
        id: String(g._id),
        chatId: g.chatId,
        name: g.name || "",
        participants: g.numParticipants,
        lastMessageAt: g.lastReplyAt || null,
        lastMessageAgo: u.timeAgo(g.lastReplyAt),
        lastMessageText: g.lastReplyText || "",
        botPresent: g.botPresent !== false,
    }));

    if (req.get("accept")?.includes("application/json")) {
        res.json({ groups: rows });
        return;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Groups</title>
        <style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}a{color:#0a58ca;text-decoration:none}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.4rem .6rem .4rem 0;vertical-align:top}</style>
        </head><body>
            <h1>Groups (${rows.length})</h1>
            <p style="margin:.2rem 0 1rem"><a href="/scheduled-tasks/">scheduled tasks →</a></p>
            <table>
                <tr style="border-bottom:1px solid #ddd"><th>Group</th><th>Members</th><th>Gepetel last spoke</th></tr>
                ${rows.map(r => `<tr style="border-top:1px solid #eee">
                    <td><a href="/groups/${r.id}">${escapeHtml(r.name || r.chatId)}</a>
                        ${r.botPresent ? "" : '<br><span style="color:#b00;font-size:.8em">not a member any more</span>'}</td>
                    <td style="white-space:nowrap">${r.participants}</td>
                    <td style="white-space:nowrap"${r.lastMessageAt ? "" : ' style="color:#888"'}>${escapeHtml(r.lastMessageAgo)}
                        ${r.lastMessageAt ? `<br><span style="color:#888;font-size:.8em">${new Date(r.lastMessageAt).toISOString().replace("T", " ").slice(0, 16)}</span>` : ""}
                        ${r.lastMessageText ? `<br><span style="color:#0a58ca;font-size:.8em">${escapeHtml(r.lastMessageText.slice(0, 60))}</span>` : ""}</td>
                </tr>`).join('')}
            </table>
        </body></html>
    `);
});

router.get('/groups/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const groupId = req.params.id;
    const group = await m.getGroupById(groupId);
    if (!group) {
        res.status(404).send('Group not found');
        return;
    }
    // ?since=1d / 24h / 30m / 2w / a bare number of days; "all" (or anything
    // unparseable) keeps the whole retained window. ?limit raises the row cap.
    const since = typeof req.query.since === "string" ? req.query.since : "";
    const sinceMs = u.parseSince(since);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "300"), 10) || 300, 1), 2000);
    const interactions = await m.getInteractions(group.chatId, limit, sinceMs);

    // The same view, machine-readable. The page is for a human scrolling it;
    // this is for the daily review job, which would otherwise have to scrape
    // tags out of the HTML and would break the first time a style changed.
    // `action` is the honest record: "replied", "greeting", "unprompted", or
    // "silent:<why>" — which is most of what a reviewer needs to judge whether
    // he behaved well, so it is not flattened away here.
    if (req.get("accept")?.includes("application/json")) {
        res.json({
            group: {
                id: String(group._id),
                chatId: group.chatId,
                name: group.name || "",
                participants: group.numParticipants,
            },
            since: since || "all",
            count: interactions.length,
            messages: interactions.map((it: any) => ({
                at: new Date(it.createdAt).toISOString(),
                author: it.author || "",
                incoming: it.incoming || "",
                action: it.action || "",
                reply: it.reply || "",
            })),
        });
        return;
    }

    const rows = interactions.map((it: any) => {
        const when = new Date(it.createdAt).toISOString().replace('T', ' ').slice(0, 16);
        const replied = it.action === "replied" || it.action === "greeting" || it.action === "unprompted" || it.action === "scheduled";
        const actionColor = replied ? "#0a7d28" : "#888";
        return `<tr style="border-top:1px solid #eee;vertical-align:top">
            <td style="white-space:nowrap;color:#888;padding:.4rem .6rem .4rem 0">${when}</td>
            <td style="padding:.4rem .6rem .4rem 0"><b>${escapeHtml(it.author || "—")}</b><br><span style="color:#333">${escapeHtml(it.incoming)}</span></td>
            <td style="padding:.4rem 0"><span style="color:${actionColor};font-size:.8em">${escapeHtml(it.action)}</span>${it.reply ? `<br><span style="color:#0a58ca">${escapeHtml(it.reply)}</span>` : ""}</td>
        </tr>`;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>${escapeHtml(group.chatId)}</title>
        <style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}a{color:#0a58ca;text-decoration:none}</style>
        </head><body>
            <p><a href="/groups/">← all groups</a></p>
            <h1>${escapeHtml(group.chatId)}</h1>
            <p>${group.numParticipants} participants · last checked ${escapeHtml(group.lastChecked)}</p>
            <p style="margin:.6rem 0"><input id="message" placeholder="send a test message…" style="width:60%;padding:.4rem"/> <button onclick="sendMessage()">Send</button></p>
            <p style="margin:.8rem 0;font-size:.9em">
                Show: ${["1h","6h","1d","3d","7d","all"].map(p => {
                    const on = (since || "all") === p;
                    return `<a href="?since=${p}" style="margin-right:.6rem;${on ? "font-weight:700;color:#111;text-decoration:underline" : ""}">${p === "all" ? "everything" : "last " + p}</a>`;
                }).join("")}
            </p>
            <h2 style="margin-top:1rem">${sinceMs ? `Last ${escapeHtml(since)}` : "Everything kept"} (${interactions.length}${interactions.length === limit ? "+, capped" : ""})</h2>
            <p style="color:#888;font-size:.85em;margin:.2rem 0 .8rem">Interactions are deleted automatically after 14 days, so nothing older exists to show.</p>
            <table>${rows || '<tr><td style="color:#888;padding:1rem 0">No interactions logged yet.</td></tr>'}</table>
            <script>
                async function sendMessage() {
                    const message = document.getElementById('message').value;
                    const r = await fetch(window.location.pathname, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message }) });
                    alert(await r.text()); location.reload();
                }
            </script>
        </body></html>
    `);
});

router.post('/groups/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const groupId = req.params.id;
    const g = await m.getGroupById(groupId);
    if (!g) {
        res.status(404).send('Group not found');
        return;
    }
    const text = req.body.message;
    const from = "me";
    try {
        const reply = await deps.processIncomingMessage(g?.chatId || '', text, from, 'groupName', '1234567890');
        res.send(reply);
    } catch (error) {
        console.error(`Error processing test message in group ${groupId}:`, error);
        res.status(500).json({ error: 'Failed to process message' });
    }
});

// --- Scheduled tasks (admin) ---
// Recurring things Gepetel posts into a group (poll / fixed message / generated).
// Normally created from a 1:1 chat; these routes exist to inspect and debug them.

router.get('/scheduled-tasks/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    const chatId = typeof req.query.chatId === "string" ? req.query.chatId : undefined;
    const tasks = await m.listScheduledTasks(chatId, { admin: true });

    if (req.get("accept")?.includes("application/json")) {
        res.json({ tasks });
        return;
    }

    const rows = tasks.map((t: any) => `<tr style="border-top:1px solid #eee;vertical-align:top">
        <td style="padding:.4rem .6rem .4rem 0"><b>${escapeHtml(t.title)}</b><br>
            <span style="color:#888;font-size:.85em">${escapeHtml(t.kind)} · ${escapeHtml(t.chat_id)}</span></td>
        <td style="padding:.4rem .6rem .4rem 0;white-space:nowrap">${escapeHtml(t.schedule)}</td>
        <td style="padding:.4rem .6rem .4rem 0;color:${t.active ? "#0a7d28" : "#888"}">${t.active ? "active" : "paused"}<br>
            <span style="color:#888;font-size:.85em">${t.last_fired_at ? "last: " + new Date(t.last_fired_at).toISOString().replace("T", " ").slice(0, 16) : "never fired"}</span></td>
        <td style="padding:.4rem 0;white-space:nowrap"><button onclick="run('${escapeHtml(t.task_id)}')">run now</button> ${t.active ? "" : `<button onclick="reactivate('${escapeHtml(t.task_id)}')">reactivate</button> `}<button onclick="del('${escapeHtml(t.task_id)}')">delete</button></td>
    </tr>`).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="en"><head><meta charset="UTF-8"><title>Scheduled tasks</title>
        <style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}a{color:#0a58ca;text-decoration:none}</style>
        </head><body>
            <p><a href="/groups/">← all groups</a></p>
            <h1>Scheduled tasks (${tasks.length})</h1>
            <table>${rows || '<tr><td style="color:#888;padding:1rem 0">Nothing scheduled yet.</td></tr>'}</table>
            <script>
                async function run(id) {
                    if (!confirm('Post this into the group right now?')) return;
                    const r = await fetch('/scheduled-tasks/' + id + '/run', { method: 'POST' });
                    alert(await r.text()); location.reload();
                }
                async function reactivate(id) {
                    const r = await fetch('/scheduled-tasks/' + id + '/reactivate', { method: 'POST' });
                    if (!r.ok) alert(await r.text());
                    location.reload();
                }
                async function del(id) {
                    if (!confirm('Delete this scheduled task?')) return;
                    const r = await fetch('/scheduled-tasks/' + id, { method: 'DELETE' });
                    alert(await r.text()); location.reload();
                }
            </script>
        </body></html>
    `);
});

router.post('/scheduled-tasks/', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        const task = await m.createScheduledTask(req.body || {}, { admin: true });
        res.json({ status: 'ok', task });
    } catch (error: any) {
        // Validation errors are the expected case here — surface the message.
        res.status(400).json({ error: String(error?.message || error) });
    }
});

router.delete('/scheduled-tasks/:id', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        res.send(await m.deleteScheduledTask(req.params.id, { admin: true }));
    } catch (error: any) {
        res.status(404).send(String(error?.message || error));
    }
});

// Undo an auto-pause. Nothing else changes, so the normal due/missed-run rules
// in fireDueScheduledTasks apply — no catch-up burst.
router.post('/scheduled-tasks/:id/reactivate', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        await m.updateScheduledTask(req.params.id, { active: true }, { admin: true });
        res.json({ ok: true });
    } catch (error: any) {
        res.status(404).json({ ok: false, error: String(error?.message || error) });
    }
});

// Post a task right now, ignoring its schedule — for testing without waiting for
// its hour. Does not consume the day's slot.
router.post('/scheduled-tasks/:id/run', async (req, res) => {
    if (!reviewAuthOk(req, res)) return;
    try {
        const r = await m.runScheduledTaskNow(req.params.id, scheduledTaskDeps(), { admin: true });
        res.send(r.sent ? `Sent: ${r.text}` : `Not sent (${r.reason})`);
    } catch (error: any) {
        res.status(400).send(String(error?.message || error));
    }
});

/** Mount the review pages. `processIncomingMessage` is app.ts's: a test
 *  message from the group page goes through the real reply path. */
export function registerAdminRoutes(app: express.Express, d: Deps): void {
    deps = d;
    app.use(router);
}

export default { registerAdminRoutes, reviewAuthOk, escapeHtml };

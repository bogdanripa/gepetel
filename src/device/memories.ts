// `/device/memories` — the owner's memories, seen and edited from the Mac app.
//
// The owner asked (2026-10-14) for a "Manage Memories…" window: see / edit
// what Gepetel remembers about him, "if anything it's nice for debugging". The
// Mac already holds a device token, so it asks here with that, like
// /device/llm, and every read or write is scoped to the one chat the device was
// paired to. A memory id from someone else's chat is "not found", the same as
// one that never existed.
//
// Contents are never logged: these are the person's own notes about himself.
import type { Express, Request, Response } from "express";
import mongoose from "mongoose";
import store from "./store.js";
import m from "../mongo.js";

/** Enough for anyone's list; the window shows them all, newest first. */
export const MAX_LISTED = 500;

/** The storage, behind one seam so tests can stand in for Mongo. Every call
 *  takes the chat first; nothing here finds a memory by id alone. */
export const db = {
    list: (chatId: string): Promise<any[]> => m.listMemories(chatId, { limit: MAX_LISTED }) as Promise<any[]>,
    add: (chatId: string, summary: string, details?: string, tags?: string[]): Promise<any> => m.addMemory(chatId, summary, details, tags),
    update: (chatId: string, id: string, patch: any): Promise<any | null> => m.updateMemory(chatId, id, patch),
    /** True when this chat had it. */
    remove: async (chatId: string, id: string): Promise<boolean> => {
        try { await m.deleteMemory(chatId, id); return true; }
        catch (e: any) { if (/not found/i.test(String(e?.message))) return false; throw e; }
    },
};

function shape(row: any) {
    return {
        id: String(row?._id ?? row?.id ?? ""),
        summary: String(row?.summary ?? ""),
        details: String(row?.details ?? ""),
        tags: Array.isArray(row?.tags) ? row.tags.map(String) : [],
        createdAt: row?.createdAt ? new Date(row.createdAt).toISOString() : null,
    };
}

async function deviceOf(req: Request, res: Response) {
    const hdr = String(req.get("authorization") || "");
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    const device = token ? await store.deviceForToken(token).catch(() => null) : null;
    if (!device) res.status(401).json({ error: "not paired" });
    return device;
}

/** A malformed id is "not found" too — never a cast error with the id in it. */
const validId = (id: unknown) => typeof id === "string" && mongoose.isValidObjectId(id);

function failed(res: Response, what: string, e: any): void {
    // The message, not the memory: addMemory's only throw is "Summary is required".
    if (/required/i.test(String(e?.message))) { res.status(400).json({ error: "a memory needs a summary" }); return; }
    console.error(`memories ${what} failed:`, e?.message || e);
    res.status(500).json({ error: `could not ${what} the memory` });
}

async function handleList(req: Request, res: Response): Promise<void> {
    const device = await deviceOf(req, res); if (!device) return;
    try {
        const rows = await db.list(device.chat_id);
        res.json(rows.map(shape));
    } catch (e: any) { failed(res, "list", e); }
}

async function handleAdd(req: Request, res: Response): Promise<void> {
    const device = await deviceOf(req, res); if (!device) return;
    const b: any = req.body || {};
    if (!String(b.summary ?? "").trim()) { res.status(400).json({ error: "a memory needs a summary" }); return; }
    try {
        const row = await db.add(device.chat_id, String(b.summary), b.details === undefined ? undefined : String(b.details),
            Array.isArray(b.tags) ? b.tags : undefined);
        console.log(`device ${device.device_id} added a memory`);
        res.status(201).json(shape(row));
    } catch (e: any) { failed(res, "add", e); }
}

async function handleEdit(req: Request, res: Response): Promise<void> {
    const device = await deviceOf(req, res); if (!device) return;
    const id = req.params.id;
    if (!validId(id)) { res.status(404).json({ error: "no such memory" }); return; }
    const b: any = req.body || {};
    const patch: any = {};
    if (b.summary !== undefined) patch.summary = String(b.summary);
    if (b.details !== undefined) patch.details = String(b.details);
    if (b.tags !== undefined) {
        if (!Array.isArray(b.tags)) { res.status(400).json({ error: "tags must be a list" }); return; }
        patch.tags = b.tags;
    }
    if (patch.summary !== undefined && !patch.summary.trim()) { res.status(400).json({ error: "a memory needs a summary" }); return; }
    try {
        const row = await db.update(device.chat_id, String(id), patch);
        if (!row) { res.status(404).json({ error: "no such memory" }); return; }
        console.log(`device ${device.device_id} edited memory ${id}`);
        res.json(shape(row));
    } catch (e: any) { failed(res, "save", e); }
}

async function handleDelete(req: Request, res: Response): Promise<void> {
    const device = await deviceOf(req, res); if (!device) return;
    const id = req.params.id;
    if (!validId(id)) { res.status(404).json({ error: "no such memory" }); return; }
    try {
        if (!(await db.remove(device.chat_id, String(id)))) { res.status(404).json({ error: "no such memory" }); return; }
        console.log(`device ${device.device_id} deleted memory ${id}`);
        res.json({ deleted: true });
    } catch (e: any) { failed(res, "delete", e); }
}

export function registerMemoryRoutes(app: Express): void {
    app.get("/device/memories", handleList);
    app.post("/device/memories", handleAdd);
    app.patch("/device/memories/:id", handleEdit);
    app.delete("/device/memories/:id", handleDelete);
}

export default { registerMemoryRoutes, db, MAX_LISTED };

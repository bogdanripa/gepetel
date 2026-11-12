// The wall between a group and its members' private chats, in code (the
// owner, 2026-11-09: "even if he wanted he could not access a group users'
// personal stuff").
//
// While Gepetel works in a group — the reply, its tools, whatever they start
// in the background — every database read runs inside that group's scope.
// A read whose filter reaches a private (1:1) chat is refused, whichever code
// or tool issues it, and so is a read of a per-person collection that isn't
// pinned to a group at all. A prompt can be argued with; this can't.
//
// It sits on mongoose itself (Query and Aggregate exec), so it holds for
// every model, including ones written after this file. Writes aren't walled:
// the group reply legitimately writes to a member's private chat once (the
// private setup message for a connector), and nothing written can be read
// back from inside the group.
import { AsyncLocalStorage } from "node:async_hooks";
import mongoose from "mongoose";

type Scope = { group: string };
const scope = new AsyncLocalStorage<Scope>();

/** Run fn as Gepetel working in this group: private chats are out of reach. */
export function inGroup<T>(groupChatId: string, fn: () => Promise<T>): Promise<T> {
    if (!/@g\.us$/.test(String(groupChatId || ""))) throw new Error("wall: not a group");
    return scope.run({ group: groupChatId }, fn);
}
export function currentGroup(): string { return scope.getStore()?.group || ""; }

/** Fields that name whose data a row is. */
const OWNER_FIELDS = ["chatId", "chat_id", "owner", "owner_chat", "userId", "user_id"];
/** Shared directories, not anyone's private data: the group's own record, people's display names, accounting. */
const EXEMPT = new Set(["Group", "Person", "LlmUsage", "ProcessedMessage"]);

/**
 * Collections that hold something about one person. Inside a group a read of
 * these must be pinned to a group id; one that isn't is refused, so a query
 * with no filter can't sweep up everyone's notes.
 */
export const PERSONAL = new Set([
    "Memory", "MemoryCard", "Playbook", "PulseState", "PulseTopic", "GetToKnow", "ChatGoal", "FollowUp",
    "DmQuota", "UserGrowth", "CapabilityNudge", "VoiceNote", "WhatWorks", "McpTrace",
    "Device", "DeviceJob", "DeviceTakeover", "DeviceUsage", "PairingCode", "SignInLink",
    "UserMcpAuthCode", "UserMcpClient", "UserMcpLogin", "UserMcpSendLog", "UserMcpToken",
    "McpConnector", "McpOAuthPending", "McpOAuthDone", "MessageArchive", "Message", "Interaction", "Reminder",
    "Contact",
]);
/** Never readable from a group, whatever the filter: they're only ever someone's own. */
export const PRIVATE_ONLY = new Set([
    "PulseState", "PulseTopic", "GetToKnow", "DmQuota", "UserGrowth", "CapabilityNudge", "WhatWorks",
    "Device", "DeviceJob", "DeviceTakeover", "DeviceUsage", "PairingCode", "SignInLink",
    "UserMcpAuthCode", "UserMcpClient", "UserMcpLogin", "UserMcpSendLog", "UserMcpToken", "McpOAuthPending", "McpOAuthDone",
    "Contact",   // their address book (contacts.ts)
]);

const isPrivateId = (v: unknown) => typeof v === "string" && (/@s\.whatsapp\.net$/.test(v) || /^\+?\d{6,}$/.test(v));
const isGroupId = (v: unknown) => typeof v === "string" && /@g\.us$/.test(v);

/** Every value a filter field can match: "x", {$eq:"x"}, {$in:[…]}, inside $and/$or. */
function valuesOf(filter: any, field: string): unknown[] {
    const out: unknown[] = [];
    const walk = (f: any) => {
        if (!f || typeof f !== "object") return;
        for (const op of ["$and", "$or", "$nor"]) if (Array.isArray(f[op])) f[op].forEach(walk);
        if (!(field in f)) return;
        const v = f[field];
        if (v && typeof v === "object" && !(v instanceof RegExp) && !Array.isArray(v)) {
            if ("$eq" in v) out.push(v.$eq);
            if (Array.isArray(v.$in)) out.push(...v.$in);
            if ("$ne" in v || "$nin" in v || "$regex" in v || "$exists" in v) out.push("(open)");
        } else out.push(v);
    };
    walk(filter);
    return out;
}

/**
 * Why this read is refused from this group, or "" when it may run. Pure, so
 * it can be tested without a database.
 */
export function refuse(group: string, model: string, filter: any): string {
    if (!group || EXEMPT.has(model)) return "";
    if (PRIVATE_ONLY.has(model)) return `${model} is someone's own and is never read from a group`;
    let pinned = false;
    for (const field of OWNER_FIELDS) {
        for (const v of valuesOf(filter, field)) {
            if (isPrivateId(v)) return `${model}.${field} reaches a private chat`;
            if (v === "(open)") return `${model}.${field} is left open`;
            if (isGroupId(v)) {
                if (v !== group) return `${model}.${field} reaches another group`;
                pinned = true;
            }
        }
    }
    if (!pinned) return CHECK_ROWS;
    return "";
}
/** Not pinned by its filter (a row by its id): allowed only if every row it returns is this group's. */
export const CHECK_ROWS = "check rows";

/** The rows a read returned that belong to someone's private chat (or another group). */
export function foreignRows(group: string, rows: any, model = ""): string {
    if (EXEMPT.has(model)) return "";
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    for (const r of list) {
        if (!r || typeof r !== "object") continue;
        for (const field of OWNER_FIELDS) {
            const v = (r as any)[field];
            if (v == null || v === "") continue;
            if (isPrivateId(v)) return `a row's ${field} is a private chat`;
            if (isGroupId(v) && v !== group) return `a row's ${field} is another group`;
        }
    }
    return "";
}

const READS = new Set(["find", "findOne", "countDocuments", "estimatedDocumentCount", "distinct", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete"]);

let installed = false;
/** Put the wall on mongoose. Idempotent; done when mongo.ts loads. */
export function install(): void {
    if (installed) return;
    installed = true;
    const Q: any = (mongoose as any).Query.prototype;
    const exec = Q.exec;
    Q.exec = function (this: any, ...args: any[]) {
        const group = currentGroup();
        if (group && READS.has(this.op)) {
            const model = this.model?.modelName || "";
            const why = refuse(group, model, this.getFilter?.() || {});
            const no = (w: string) => {
                console.error(`[wall] group …${group.slice(-10)}: refused ${this.op} on ${model} — ${w}`);
                return Promise.reject(new Error("That's private to someone's own chat and can't be read from a group."));
            };
            if (why === CHECK_ROWS) {
                if (["countDocuments", "estimatedDocumentCount", "distinct"].includes(this.op)) return no(`${model} isn't pinned to this group`);
                return exec.apply(this, args).then((rows: any) => {
                    const bad = foreignRows(group, rows, model);
                    return bad ? no(bad) : rows;
                });
            }
            if (why) return no(why);
        }
        return exec.apply(this, args);
    };
    const A: any = (mongoose as any).Aggregate.prototype;
    const aexec = A.exec;
    A.exec = function (this: any, ...args: any[]) {
        const group = currentGroup();
        if (group) {
            const match = (this.pipeline?.() || []).find((s: any) => s.$match)?.$match || {};
            const why = refuse(group, this._model?.modelName || "", match);
            if (why) {   // an aggregate's rows are reshaped: unpinned is refused outright
                console.error(`[wall] group …${group.slice(-10)}: refused aggregate — ${why}`);
                return Promise.reject(new Error("That's private to someone's own chat and can't be read from a group."));
            }
        }
        return aexec.apply(this, args);
    };
}

export default { inGroup, currentGroup, refuse, foreignRows, install, PERSONAL, PRIVATE_ONLY, CHECK_ROWS };

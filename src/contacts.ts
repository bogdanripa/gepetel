// Their people: one address book per person, kept by Gepetel itself.
//
// Gepetel asks Google for Gmail and Calendar and nothing else — no Contacts
// scope (the owner, 2026-11-12). So when someone says "Anca is my wife, this
// is her number and her email", that goes here: a card per person, with how
// they're related, their numbers and addresses, and labels (family, close
// friends, work…) to find them by later.
//
// Whose it is: the person's own 1:1 chat id. Never a group's. The wall
// (wall.ts) lists Contact as never readable from a group, so a group reply
// can't reach anyone's address book whatever it asks for; save/find/remove
// here also refuse anything that isn't a private chat.
import mongoose from "mongoose";
import crypto from "node:crypto";
import u from "./util.js";
import { unsafe, terms, score } from "./memory.js";

export const MAX_CONTACTS = 2000;
export const BRIEF_SHOWN = 40;

const contactSchema = new mongoose.Schema({
    chat_id: { type: String, required: true, index: true },   // the owner's 1:1
    contact_id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    relation: { type: String, default: "" },                  // "wife", "Ana's teacher", "plumber"
    phones: { type: [String], default: [] },
    emails: { type: [String], default: [] },
    labels: { type: [String], default: [] },                  // family, close friends, work…
    birthday: { type: String, default: "" },                  // YYYY-MM-DD or MM-DD
    notes: { type: String, default: "" },
}, { timestamps: true });
contactSchema.index({ chat_id: 1, name: 1 });
export const Contact = mongoose.models.Contact || mongoose.model("Contact", contactSchema);

export type ContactInput = {
    contact_id?: string; name?: string; relation?: string;
    phones?: string[]; emails?: string[]; labels?: string[];
    birthday?: string; notes?: string;
    remove?: { phones?: string[]; emails?: string[]; labels?: string[] };
};
export type ContactRow = {
    contact_id: string; name: string; relation: string; phones: string[]; emails: string[];
    labels: string[]; birthday: string; notes: string;
};

// ------------------------------------------------------------- pure helpers

/** A phone number as it's stored: "+" and digits, spaces and dashes gone. "" when it isn't one. */
export function normalizePhone(p: unknown): string {
    const raw = String(p ?? "").trim();
    const plus = raw.startsWith("+") || raw.startsWith("00");
    const digits = raw.replace(/\D/g, "").replace(/^00/, "");
    if (digits.length < 6 || digits.length > 15) return "";
    return (plus ? "+" : "") + digits;
}
/** Two numbers are the same person's when their last nine digits match (0722… vs +40722…). */
export function samePhone(a: string, b: string): boolean {
    const x = String(a).replace(/\D/g, ""), y = String(b).replace(/\D/g, "");
    if (!x || !y) return false;
    const n = Math.min(9, x.length, y.length);
    return x.slice(-n) === y.slice(-n);
}
export function normalizeEmail(e: unknown): string {
    const s = String(e ?? "").trim().toLowerCase().replace(/^mailto:/, "");
    return /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/.test(s) ? s : "";
}
/** Labels are short, lowercase, no duplicates: "Close Friends " → "close friends". */
export function cleanLabels(list: unknown): string[] {
    const out: string[] = [];
    for (const l of Array.isArray(list) ? list : []) {
        const s = String(l ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 30);
        if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, 10);
}
const fold = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const uniq = <T,>(xs: T[], same: (a: T, b: T) => boolean) => xs.filter((x, i) => xs.findIndex(y => same(x, y)) === i);

/**
 * A card with an update applied. Lists ADD to what's there (saying her email
 * doesn't lose her number); `remove` takes things off. Text fields given
 * replace; left out, they stay.
 */
export function merge(card: ContactRow, input: ContactInput): ContactRow {
    const rm = input.remove || {};
    const phones = uniq([...card.phones, ...(input.phones || []).map(normalizePhone).filter(Boolean)], samePhone)
        .filter(p => !(rm.phones || []).some(r => samePhone(p, String(r))));
    const emails = uniq([...card.emails, ...(input.emails || []).map(normalizeEmail).filter(Boolean)], (a, b) => a === b)
        .filter(e => !(rm.emails || []).map(normalizeEmail).includes(e));
    const gone = cleanLabels(rm.labels);
    const labels = cleanLabels([...card.labels, ...cleanLabels(input.labels)]).filter(l => !gone.includes(l));
    const text = (v: unknown, cur: string, max: number) => v === undefined ? cur : String(v ?? "").trim().slice(0, max);
    return {
        ...card,
        name: text(input.name, card.name, 120) || card.name,
        relation: text(input.relation, card.relation, 120),
        birthday: text(input.birthday, card.birthday, 10),
        notes: text(input.notes, card.notes, 600),
        phones: phones.slice(0, 8), emails: emails.slice(0, 8), labels,
    };
}

/** The card already kept for this person, if the update clearly names one: same number, same address, or the same full name. */
export function findSame(cards: ContactRow[], input: ContactInput): ContactRow | undefined {
    const phones = (input.phones || []).map(normalizePhone).filter(Boolean);
    const emails = (input.emails || []).map(normalizeEmail).filter(Boolean);
    const byKey = cards.find(c => c.phones.some(p => phones.some(q => samePhone(p, q))) || c.emails.some(e => emails.includes(e)));
    if (byKey) return byKey;
    const name = fold(input.name || "");
    return name ? cards.find(c => fold(c.name) === name) : undefined;
}

/** How well a card answers "wife", "anca", "family", "0722…", "@firma.ro". */
export function match(card: ContactRow, words: string): number {
    const w = String(words || "").trim();
    if (!w) return 1;
    const digits = w.replace(/\D/g, "");
    if (digits.length >= 6 && card.phones.some(p => samePhone(p, digits))) return 100;
    const low = w.toLowerCase();
    if (low.includes("@") && card.emails.some(e => e.includes(low))) return 100;
    const t = terms(w);
    if (!t.length) return 0;
    const hay = [card.name, card.relation, card.labels.join(" "), card.emails.join(" "), card.notes].join(" · ");
    return score(hay, t) + (fold(card.name).includes(fold(w)) ? 5 : 0);
}

/** The short list put in front of the model every 1:1 turn: who, how related, labels — no numbers. */
export function briefLines(cards: ContactRow[], total: number): string {
    if (!cards.length) return "";
    const lines = cards.map(c => `- ${c.name}${c.relation ? ` — ${c.relation}` : ""}${c.labels.length ? ` [${c.labels.join(", ")}]` : ""}`);
    const more = total > cards.length ? `\n(and ${total - cards.length} more — find_contacts finds them)` : "";
    return `\n\n[Their contacts] People they've told you about, kept in their address book (numbers and addresses via find_contacts):\n${lines.join("\n")}${more}`;
}

// ------------------------------------------------------------------ the store

function ownerOnly(chatId: string): string {
    if (!u.isPrivateChatId(String(chatId || ""))) throw new Error("contacts: a person's address book is read only in their own private chat");
    return chatId;
}
const row = (d: any): ContactRow => ({
    contact_id: d.contact_id, name: d.name, relation: d.relation || "", phones: d.phones || [], emails: d.emails || [],
    labels: d.labels || [], birthday: d.birthday || "", notes: d.notes || "",
});
async function all(chatId: string): Promise<ContactRow[]> {
    return (await Contact.find({ chat_id: ownerOnly(chatId) }).sort({ updatedAt: -1 }).limit(MAX_CONTACTS).lean()).map(row);
}

/** Their contacts matching a few words and/or a label, best first. */
export async function find(chatId: string, words = "", label = "", limit = 20): Promise<{ contacts: ContactRow[]; total: number }> {
    const cards = await all(chatId);
    const want = cleanLabels([label])[0] || "";
    const hits = cards
        .filter(c => !want || c.labels.includes(want))
        .map(c => ({ c, s: match(c, words) }))
        .filter(x => x.s > 0)
        .sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name));
    return { contacts: hits.slice(0, Math.max(1, Math.min(50, limit))).map(x => x.c), total: hits.length };
}

/** Add someone, or update the card already kept for them. */
export async function save(chatId: string, input: ContactInput): Promise<{ saved: boolean; created?: boolean; contact?: ContactRow; why?: string }> {
    ownerOnly(chatId);
    for (const t of [input.name, input.relation, input.notes, ...(input.labels || [])]) {
        const why = unsafe(String(t ?? ""));
        if (why) return { saved: false, why: `not kept: ${why}` };
    }
    const badPhone = (input.phones || []).find(p => !normalizePhone(p));
    if (badPhone) return { saved: false, why: `"${badPhone}" isn't a phone number` };
    const badEmail = (input.emails || []).find(e => !normalizeEmail(e));
    if (badEmail) return { saved: false, why: `"${badEmail}" isn't an email address` };
    if (input.birthday && !/^(\d{4}-)?\d{2}-\d{2}$/.test(String(input.birthday))) return { saved: false, why: "birthday as YYYY-MM-DD, or MM-DD without the year" };

    const cards = await all(chatId);
    const existing = input.contact_id ? cards.find(c => c.contact_id === input.contact_id) : findSame(cards, input);
    if (input.contact_id && !existing) return { saved: false, why: "no contact with that id — find_contacts first" };
    if (!existing) {
        if (!String(input.name || "").trim()) return { saved: false, why: "a new contact needs a name" };
        if (cards.length >= MAX_CONTACTS) return { saved: false, why: "their address book is full" };
        const blank: ContactRow = { contact_id: "c_" + crypto.randomBytes(5).toString("hex"), name: "", relation: "", phones: [], emails: [], labels: [], birthday: "", notes: "" };
        const card = merge(blank, { ...input, remove: undefined });
        await Contact.create({ chat_id: chatId, ...card });
        return { saved: true, created: true, contact: card };
    }
    const card = merge(existing, input);
    await Contact.updateOne({ chat_id: chatId, contact_id: existing.contact_id }, { $set: { ...card } });
    return { saved: true, created: false, contact: card };
}

/** Drop someone from their address book. */
export async function remove(chatId: string, contactId: string): Promise<boolean> {
    const r = await Contact.deleteOne({ chat_id: ownerOnly(chatId), contact_id: String(contactId || "") });
    return (r?.deletedCount || 0) > 0;
}

/** The short list for the model: the people most recently talked about, no numbers. */
export async function brief(chatId: string): Promise<string> {
    if (!u.isPrivateChatId(String(chatId || ""))) return "";
    const total = await Contact.countDocuments({ chat_id: chatId });
    if (!total) return "";
    const cards = (await Contact.find({ chat_id: chatId }).sort({ updatedAt: -1 }).limit(BRIEF_SHOWN).lean()).map(row);
    return briefLines(cards, total);
}

export default { find, save, remove, brief, merge, findSame, match, briefLines, normalizePhone, normalizeEmail, samePhone, cleanLabels, Contact, MAX_CONTACTS };

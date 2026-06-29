// Pure, dependency-free helpers — extracted so they can be unit-tested in
// isolation (no DB, no network, no clock/RNG unless injected).

// --- Chat identity & mentions ---

export function isGroupChatId(chatId: string): boolean {
    return /^[\d-]{10,31}@g\.us$/.test(chatId || "");
}

// Normalize the bot's raw WhatsApp ids to a readable "@gepetel" mention.
export function normalizeMentions(text: string): string {
    return (text || "")
        .replace("@279697464266959", "@gepetel")
        .replace("@+40750271099", "@gepetel");
}

// Treat any mention of his name as a wake word — with or without the "@".
export function isMentioned(text: string): boolean {
    return /\bgepetel\b/i.test(normalizeMentions(text || ""));
}

// --- Outbound text cleanup (WhatsApp has no markdown links, uses *bold*) ---

export function cleanWhatsAppText(message: string): string {
    return (message || "")
        .replace(/\[[^\]]+\]\((http[^\)]+)\)/g, "$1")   // [text](url) -> url
        .replace(/^\s*#{1,6}\s*(.+)$/gm, "*$1*")          // # heading -> *heading*
        .replace(/(\*\*)(.*?)\1/g, "*$2*")                // **bold** -> *bold*
        .replace(/\?utm_source=openai&/g, "?")
        .replace(/\?utm_source=openai/g, "");
}

// Strip a pair of surrounding double quotes from a model answer.
export function cleanUpAnswer(answer: string): string {
    return (answer || "").replace(/^"(.*)"$/, "$1");
}

// Parse tool-call arguments that may arrive as object or JSON string.
export function parseToolArgs(maybe: unknown): any {
    if (!maybe) return {};
    if (typeof maybe === "object") return maybe as any;
    try { return JSON.parse(String(maybe)); } catch { return {}; }
}

// --- Region / language inference from phone country codes ---

export const CALLING_CODES: Record<string, { country: string; language: string }> = {
    "1": { country: "USA/Canada", language: "English" },
    "7": { country: "Russia", language: "Russian" },
    "20": { country: "Egypt", language: "Arabic" },
    "27": { country: "South Africa", language: "English" },
    "30": { country: "Greece", language: "Greek" },
    "31": { country: "Netherlands", language: "Dutch" },
    "32": { country: "Belgium", language: "Dutch" },
    "33": { country: "France", language: "French" },
    "34": { country: "Spain", language: "Spanish" },
    "36": { country: "Hungary", language: "Hungarian" },
    "39": { country: "Italy", language: "Italian" },
    "40": { country: "Romania", language: "Romanian" },
    "41": { country: "Switzerland", language: "German" },
    "43": { country: "Austria", language: "German" },
    "44": { country: "United Kingdom", language: "English" },
    "45": { country: "Denmark", language: "Danish" },
    "46": { country: "Sweden", language: "Swedish" },
    "47": { country: "Norway", language: "Norwegian" },
    "48": { country: "Poland", language: "Polish" },
    "49": { country: "Germany", language: "German" },
    "51": { country: "Peru", language: "Spanish" },
    "52": { country: "Mexico", language: "Spanish" },
    "54": { country: "Argentina", language: "Spanish" },
    "55": { country: "Brazil", language: "Portuguese" },
    "60": { country: "Malaysia", language: "Malay" },
    "61": { country: "Australia", language: "English" },
    "62": { country: "Indonesia", language: "Indonesian" },
    "63": { country: "Philippines", language: "Filipino" },
    "64": { country: "New Zealand", language: "English" },
    "65": { country: "Singapore", language: "English" },
    "66": { country: "Thailand", language: "Thai" },
    "81": { country: "Japan", language: "Japanese" },
    "82": { country: "South Korea", language: "Korean" },
    "84": { country: "Vietnam", language: "Vietnamese" },
    "86": { country: "China", language: "Chinese" },
    "90": { country: "Turkey", language: "Turkish" },
    "91": { country: "India", language: "Hindi" },
    "92": { country: "Pakistan", language: "Urdu" },
    "212": { country: "Morocco", language: "Arabic" },
    "213": { country: "Algeria", language: "Arabic" },
    "216": { country: "Tunisia", language: "Arabic" },
    "234": { country: "Nigeria", language: "English" },
    "351": { country: "Portugal", language: "Portuguese" },
    "352": { country: "Luxembourg", language: "French" },
    "353": { country: "Ireland", language: "English" },
    "355": { country: "Albania", language: "Albanian" },
    "358": { country: "Finland", language: "Finnish" },
    "359": { country: "Bulgaria", language: "Bulgarian" },
    "370": { country: "Lithuania", language: "Lithuanian" },
    "371": { country: "Latvia", language: "Latvian" },
    "372": { country: "Estonia", language: "Estonian" },
    "373": { country: "Moldova", language: "Romanian" },
    "380": { country: "Ukraine", language: "Ukrainian" },
    "381": { country: "Serbia", language: "Serbian" },
    "385": { country: "Croatia", language: "Croatian" },
    "386": { country: "Slovenia", language: "Slovenian" },
    "420": { country: "Czechia", language: "Czech" },
    "421": { country: "Slovakia", language: "Slovak" },
    "961": { country: "Lebanon", language: "Arabic" },
    "966": { country: "Saudi Arabia", language: "Arabic" },
    "971": { country: "United Arab Emirates", language: "Arabic" },
    "972": { country: "Israel", language: "Hebrew" },
    "974": { country: "Qatar", language: "Arabic" },
    "995": { country: "Georgia", language: "Georgian" },
};

export function dominantBy(participants: any[], field: "country" | "language"): string | null {
    if (!Array.isArray(participants) || !participants.length) return null;
    const codes = Object.keys(CALLING_CODES).sort((a, b) => b.length - a.length);
    const tally: Record<string, number> = {};
    for (const p of participants) {
        const digits = String(p || "").replace(/\D/g, "");
        if (!digits) continue;
        const code = codes.find(c => digits.startsWith(c));
        if (code) {
            const v = CALLING_CODES[code][field];
            tally[v] = (tally[v] || 0) + 1;
        }
    }
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    return entries.length ? entries[0][0] : null;
}

export function inferRegion(participants: any[]): string {
    return dominantBy(participants, "country") || "international";
}

export function inferLanguage(participants: any[]): string {
    return dominantBy(participants, "language") || "English";
}

// Representative IANA timezone per country (for "what's the local time" reasoning).
const COUNTRY_TIMEZONE: Record<string, string> = {
    "USA/Canada": "America/New_York", "Russia": "Europe/Moscow", "Egypt": "Africa/Cairo",
    "South Africa": "Africa/Johannesburg", "Greece": "Europe/Athens", "Netherlands": "Europe/Amsterdam",
    "Belgium": "Europe/Brussels", "France": "Europe/Paris", "Spain": "Europe/Madrid", "Hungary": "Europe/Budapest",
    "Italy": "Europe/Rome", "Romania": "Europe/Bucharest", "Switzerland": "Europe/Zurich", "Austria": "Europe/Vienna",
    "United Kingdom": "Europe/London", "Denmark": "Europe/Copenhagen", "Sweden": "Europe/Stockholm", "Norway": "Europe/Oslo",
    "Poland": "Europe/Warsaw", "Germany": "Europe/Berlin", "Peru": "America/Lima", "Mexico": "America/Mexico_City",
    "Argentina": "America/Argentina/Buenos_Aires", "Brazil": "America/Sao_Paulo", "Malaysia": "Asia/Kuala_Lumpur",
    "Australia": "Australia/Sydney", "Indonesia": "Asia/Jakarta", "Philippines": "Asia/Manila", "New Zealand": "Pacific/Auckland",
    "Singapore": "Asia/Singapore", "Thailand": "Asia/Bangkok", "Japan": "Asia/Tokyo", "South Korea": "Asia/Seoul",
    "Vietnam": "Asia/Ho_Chi_Minh", "China": "Asia/Shanghai", "Turkey": "Europe/Istanbul", "India": "Asia/Kolkata",
    "Pakistan": "Asia/Karachi", "Morocco": "Africa/Casablanca", "Algeria": "Africa/Algiers", "Tunisia": "Africa/Tunis",
    "Nigeria": "Africa/Lagos", "Portugal": "Europe/Lisbon", "Luxembourg": "Europe/Luxembourg", "Ireland": "Europe/Dublin",
    "Albania": "Europe/Tirane", "Finland": "Europe/Helsinki", "Bulgaria": "Europe/Sofia", "Lithuania": "Europe/Vilnius",
    "Latvia": "Europe/Riga", "Estonia": "Europe/Tallinn", "Moldova": "Europe/Chisinau", "Ukraine": "Europe/Kyiv",
    "Serbia": "Europe/Belgrade", "Croatia": "Europe/Zagreb", "Slovenia": "Europe/Ljubljana", "Czechia": "Europe/Prague",
    "Slovakia": "Europe/Bratislava", "Lebanon": "Asia/Beirut", "Saudi Arabia": "Asia/Riyadh",
    "United Arab Emirates": "Asia/Dubai", "Israel": "Asia/Jerusalem", "Qatar": "Asia/Qatar", "Georgia": "Asia/Tbilisi",
};

export function inferTimezone(participants: any[]): string {
    const country = dominantBy(participants, "country");
    return (country && COUNTRY_TIMEZONE[country]) || "UTC";
}

// Human-readable current date/time in a given IANA timezone.
export function currentTimeString(timezone: string, date: Date = new Date()): string {
    try {
        const s = new Intl.DateTimeFormat("en-GB", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone,
        }).format(date);
        return `${s} (${timezone})`;
    } catch {
        return `${date.toUTCString()} (UTC)`;
    }
}

// --- Activity histogram analysis (UTC hour-of-day) ---

export function activeHoursFromHistogram(hist: any): {
    counts: number[]; total: number; peakHourUTC: number; medianHourUTC: number; topHoursUTC: number[];
} | null {
    hist = hist || {};
    const counts = Array.from({ length: 24 }, (_, h) => Number(hist[h] ?? hist[String(h)] ?? 0));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return null;

    let peakHourUTC = 0;
    for (let h = 1; h < 24; h++) if (counts[h] > counts[peakHourUTC]) peakHourUTC = h;

    const topHoursUTC = counts
        .map((c, h) => ({ h, c }))
        .filter(x => x.c > 0)
        .sort((a, b) => b.c - a.c)
        .map(x => x.h);

    // Circular median: cut at the lowest-activity hour, then walk to the 50% mark.
    let cut = 0;
    for (let h = 1; h < 24; h++) if (counts[h] < counts[cut]) cut = h;
    const order = Array.from({ length: 24 }, (_, i) => (cut + i) % 24);
    let acc = 0, medianHourUTC = peakHourUTC;
    for (const h of order) { acc += counts[h]; if (acc >= total / 2) { medianHourUTC = h; break; } }

    return { counts, total, peakHourUTC, medianHourUTC, topHoursUTC };
}

// Pick a UTC send hour: an active hour, ideally just before the daily peak,
// never a dead-of-night hour. Falls back to when the group was added.
export function pickSendHourUTC(group: any, rnd: () => number = Math.random): number {
    const addedHour = group?.addedAt ? new Date(group.addedAt).getUTCHours() : 19;
    const a = activeHoursFromHistogram(group?.activityByHour);
    if (!a) return addedHour;
    const peak = a.peakHourUTC;
    const thr = a.counts[peak] * 0.25;
    let pool = a.counts.map((c, h) => ({ c, h })).filter(x => x.c >= thr).map(x => x.h);
    const beforePeak = pool.filter(h => h <= peak);
    if (beforePeak.length) pool = beforePeak;
    return pool[Math.floor(rnd() * pool.length)];
}

// Next unprompted slot: rand(3..6) days out, at an active hour of day.
export function computeNextUnpromptedAt(group: any, now: Date = new Date(), rnd: () => number = Math.random): Date {
    const days = 3 + Math.floor(rnd() * 4);
    const hour = pickSendHourUTC(group, rnd);
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, Math.floor(rnd() * 60), 0, 0);
    return d;
}

// --- Group reply gate ---

// Only the short window after Gepetel's OWN last reply is a candidate for a
// follow-up. Re-engaging a quiet group is handled deliberately by the unprompted
// cron, NOT reactively here (that would be intrusive).
export const CONTINUATION_WINDOW_MS = 5 * 60 * 1000;

export type GateDecision = {
    decision: "reply" | "silent" | "consult";
    consultGatekeeper: boolean;
    reason: string;
};

// Decide what to do with an incoming message BEFORE any expensive model call:
// - 1:1 chat or an explicit @gepetel mention -> reply.
// - non-mention group message shortly after Gepetel spoke -> consult the gatekeeper
//   (is it a genuine follow-up to him?).
// - anything else -> stay silent (no model call).
export function replyGateDecision(params: {
    isGroupMessage: boolean;
    mentioned: boolean;
    gapMs: number;
}): GateDecision {
    const { isGroupMessage, mentioned, gapMs } = params;
    if (!isGroupMessage) return { decision: "reply", consultGatekeeper: false, reason: "dm" };
    if (mentioned) return { decision: "reply", consultGatekeeper: false, reason: "mentioned" };
    if (gapMs < CONTINUATION_WINDOW_MS) return { decision: "consult", consultGatekeeper: true, reason: "continuation" };
    return { decision: "silent", consultGatekeeper: false, reason: "out-of-window" };
}

// Strip HTML to readable plain text (for the read_url tool). Pure.
export function htmlToText(html: string, maxLen = 8000): string {
    const text = (html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();
    return text.length > maxLen ? text.slice(0, maxLen) + "…[truncated]" : text;
}

// --- Bill splitting (pure) ---

export function splitBill(params: {
    total: number; people?: number; names?: string[]; tip_percent?: number; currency?: string;
}): any {
    const { total, people, names, tip_percent = 0, currency } = params;
    const count = Array.isArray(names) && names.length ? names.length : (people || 0);
    if (!(total > 0)) throw new Error("total must be a positive number");
    if (!(count >= 1)) throw new Error("provide people (>=1) or a non-empty names list");
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const effective = round2(total * (1 + tip_percent / 100));
    const per = round2(effective / count);
    const result: any = { currency: currency || null, total, tip_percent, effective_total: effective, count, per_person: per };
    if (Array.isArray(names) && names.length) {
        result.per_named = names.map(n => ({ name: n, amount: per }));
    }
    return result;
}

// --- Recurrence (pure) ---

export type Recurrence = "daily" | "weekly" | "monthly";

export function nextOccurrence(date: Date, recurrence: Recurrence): Date {
    const d = new Date(date.getTime());
    if (recurrence === "daily") d.setUTCDate(d.getUTCDate() + 1);
    else if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else if (recurrence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
    else throw new Error(`unknown recurrence: ${recurrence}`);
    return d;
}

// Remove Gepetel's own number(s) so region/language is inferred from real members.
export const BOT_PHONE_DIGITS = ["40750271099", "279697464266959"];
// The dialable WhatsApp number people add to a group to invite Gepetel.
export const BOT_PHONE_DISPLAY = "+40750271099";
export function stripBot(participants: any[]): any[] {
    if (!Array.isArray(participants)) return [];
    return participants.filter(p => {
        const digits = String(p || "").replace(/\D/g, "");
        return digits && !BOT_PHONE_DIGITS.includes(digits);
    });
}

export default {
    isGroupChatId, normalizeMentions, isMentioned,
    cleanWhatsAppText, cleanUpAnswer, parseToolArgs,
    CALLING_CODES, dominantBy, inferRegion, inferLanguage, inferTimezone, currentTimeString,
    activeHoursFromHistogram, pickSendHourUTC, computeNextUnpromptedAt,
    CONTINUATION_WINDOW_MS, replyGateDecision,
    BOT_PHONE_DIGITS, BOT_PHONE_DISPLAY, stripBot,
    splitBill, nextOccurrence, htmlToText,
};

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

// Remove internal identifiers from anything about to be sent to a human.
//
// The prompts tell Gepetel not to recite ids and the tool results label them
// "do not show" — but that's advice to a model, and it leaks anyway. This is the
// enforcement: no database id or chat jid reaches a WhatsApp message, whatever
// the model decided to write. Also tidies the wreckage ("(ID )", stray commas)
// so the sentence still reads naturally once the id is gone.
export function stripInternalIds(text: string): string {
    return (text || "")
        // "(ID 6a71f8...)" / "[id: 6a71f8...]" / "— ID 6a71f8..."
        .replace(/[\(\[][^\)\]]*\b[0-9a-f]{24}\b[^\)\]]*[\)\]]/gi, "")
        .replace(/[,;—-]?\s*\b(?:ID|id)\s*[:=]?\s*[0-9a-f]{24}\b/g, "")
        // A WhatsApp chat id, group or 1:1.
        .replace(/[\(\[][^\)\]]*[\d-]{10,32}@(?:g\.us|s\.whatsapp\.net)[^\)\]]*[\)\]]/g, "")
        .replace(/\b[\d-]{10,32}@(?:g\.us|s\.whatsapp\.net)\b/g, "")
        // Any bare 24-hex mongo id left over.
        .replace(/\b[0-9a-f]{24}\b/gi, "")
        // Tidy up what the removal left behind.
        .replace(/\(\s*\)|\[\s*\]/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/([(\[])\s+/g, "$1")
        .replace(/[ \t]+$/gm, "")
        .trim();
}

// Strip a pair of surrounding double quotes from a model answer, and scrub any
// internal ids it decided to include.
export function cleanUpAnswer(answer: string): string {
    return stripInternalIds((answer || "").replace(/^"(.*)"$/, "$1"));
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

// The country a single number belongs to, or null if the prefix is unknown.
// Used to tell a single-country group (whose timezone we can safely assume) from
// a mixed one (where "9am" has to be confirmed).
export function countryOf(participant: any): string | null {
    const digits = String(participant || "").replace(/\D/g, "");
    if (!digits) return null;
    const codes = Object.keys(CALLING_CODES).sort((a, b) => b.length - a.length);
    const code = codes.find(c => digits.startsWith(c));
    return code ? CALLING_CODES[code].country : null;
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

// --- Scheduled tasks (pure) ---

// A scheduled task fires on given weekdays at a given local hour. Everything is
// evaluated in the group's own timezone, so "every workday at 9" means 9am where
// the group actually lives, and it survives DST without any stored UTC offset.

export type LocalParts = { hour: number; weekday: number; ymd: string };

// Break a Date into the calendar parts an observer in `timezone` would see.
// weekday is 0=Sunday..6=Saturday; ymd is "YYYY-MM-DD" (local, not UTC).
export function localParts(date: Date, timezone: string = "UTC"): LocalParts {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone || "UTC",
            hour12: false,
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", weekday: "short",
        }).formatToParts(date);
    } catch {
        // Unknown/garbage tz -> fall back to UTC rather than throwing at fire time.
        return localParts(date, "UTC");
    }
    const get = (t: string) => parts.find(p => p.type === t)?.value || "";
    const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // "24" is how some ICU versions spell midnight under hour12:false.
    const hour = parseInt(get("hour"), 10) % 24;
    return {
        hour,
        weekday: WEEKDAYS[get("weekday")] ?? 0,
        ymd: `${get("year")}-${get("month")}-${get("day")}`,
    };
}

// Exactly one of these three decides when a task runs:
//   days_of_week   weekly  — [5] is every Friday, [1,2,3,4,5] every workday
//   days_of_month  monthly — [21, 25] is the 21st and 25th of every month
//   run_on_date    once    — "YYYY-MM-DD", then it retires itself
export type ScheduleSpec = {
    hour_local: number;
    days_of_week: number[];
    days_of_month?: number[];
    timezone?: string;
    active?: boolean;
    last_fired_at?: Date | string | null;
    run_on_date?: string | null;
};

// How many days the month containing `ymd` ("YYYY-MM-DD") actually has.
function daysInMonthOf(ymd: string): number {
    const [y, m] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month = last of this
}

// A calendar date in the group's own timezone, "YYYY-MM-DD". Deliberately a
// local date rather than an instant: "the poll on Friday" means Friday where the
// group is, and storing it this way keeps it true regardless of DST.
export function isValidLocalDate(value: unknown): boolean {
    const s = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const probe = new Date(Date.UTC(y, m - 1, d));
    // Rejects the likes of 2026-02-30, which Date would silently roll forward.
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// Is this task due right now? The cron runs hourly, so "due" means: today is one
// of its weekdays, we're in its hour, and it hasn't already fired in this local
// hour. That last check is what makes a cron retry (or an overlapping run)
// harmless — never two posts for one slot.
export function isTaskDue(task: ScheduleSpec, now: Date = new Date()): boolean {
    if (task.active === false) return false;
    if (!Number.isInteger(task.hour_local) || task.hour_local < 0 || task.hour_local > 23) return false;

    const tz = task.timezone || "UTC";
    const nowLocal = localParts(now, tz);

    // A one-off runs on its date and never again — even if something goes wrong.
    if (task.run_on_date) {
        if (task.last_fired_at) return false;
        if (nowLocal.ymd !== task.run_on_date) return false;
        // At or after its hour, so a missed cron run still lands it the same day
        // rather than dropping it entirely. It can never spill to another day.
        return nowLocal.hour >= task.hour_local;
    }

    if (nowLocal.hour !== task.hour_local) return false;

    const monthDays = Array.isArray(task.days_of_month) ? task.days_of_month : [];
    if (monthDays.length) {
        // "the 31st" in a 30-day month, or "the 30th" in February, would otherwise
        // silently skip that month. Clamp to the last day instead, so a monthly
        // task runs every month rather than mysteriously missing some.
        const last = daysInMonthOf(nowLocal.ymd);
        const today = Number(nowLocal.ymd.slice(8, 10));
        const wanted = new Set(monthDays.map(d => Math.min(d, last)));
        if (!wanted.has(today)) return false;
    } else {
        const days = Array.isArray(task.days_of_week) ? task.days_of_week : [];
        if (!days.length) return false;
        if (!days.includes(nowLocal.weekday)) return false;
    }

    if (task.last_fired_at) {
        const last = new Date(task.last_fired_at);
        if (!isNaN(last.getTime())) {
            const lastLocal = localParts(last, tz);
            if (lastLocal.ymd === nowLocal.ymd && lastLocal.hour === nowLocal.hour) return false;
        }
    }
    return true;
}

// Mon–Fri, the "every workday" default.
export const WORKDAYS = [1, 2, 3, 4, 5];

// Accept whatever the model hands us and return a clean, sorted, de-duped list
// of weekday numbers. Throws when nothing usable is left, so a malformed
// schedule fails loudly at creation instead of silently never firing.
export function normalizeDaysOfWeek(days: unknown): number[] {
    const NAMES: Record<string, number> = {
        sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5, sat: 6, saturday: 6,
    };
    const raw = Array.isArray(days) ? days : [days];
    const out = new Set<number>();
    for (const d of raw) {
        if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) { out.add(d); continue; }
        const s = String(d ?? "").trim().toLowerCase();
        if (!s) continue;
        if (s in NAMES) { out.add(NAMES[s]); continue; }
        if (/^[0-6]$/.test(s)) { out.add(parseInt(s, 10)); continue; }
        if (s === "weekdays" || s === "workdays") { WORKDAYS.forEach(n => out.add(n)); continue; }
        if (s === "weekend" || s === "weekends") { out.add(0); out.add(6); continue; }
        if (s === "daily" || s === "everyday" || s === "every day") { for (let n = 0; n <= 6; n++) out.add(n); continue; }
    }
    if (!out.size) throw new Error("days_of_week must contain at least one weekday (0=Sun..6=Sat)");
    return [...out].sort((a, b) => a - b);
}

// `text` and `poll` are structured — their content is fixed when they're created.
// `generated` is written fresh each time by the model, from an instruction
// composed during the 1:1 chat ("post a joke about cats", "check what's new in
// F1 and mention it casually"). One open-ended kind beats a fixed menu.
export const TASK_KINDS = ["text", "poll", "generated"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

// Credit the person who set a task up, so a group knows why this keeps arriving
// and who to badger about it. Plain text on purpose: a real WhatsApp mention
// would ping them every single time the task fires.
export function attributeToScheduler(kind: string, text: string, schedulerName?: string): string {
    const name = String(schedulerName || "").trim();
    if (!name || !text) return text;
    const handle = `@${name.split(/\s+/)[0]}`;          // first name is enough in a group
    // A poll has only its title — there's nowhere else to put this.
    return kind === "poll" ? `${text} (via ${handle})` : `${text}\n\n— via ${handle}`;
}

// WhatsApp itself refuses polls with more than 12 options.
export const MAX_POLL_OPTIONS = 12;

// Validate + normalize a task's kind-specific settings. Throws with a message
// meant to be read by the model (it gets handed straight back as a tool error,
// so it has to say what to fix), and returns the cleaned payload to store.
export function validateTaskPayload(kind: string, payload: any): any {
    const p = payload || {};
    switch (kind) {
        case "text": {
            const text = String(p.text ?? "").trim();
            if (!text) throw new Error("a 'text' task needs payload.text — the message to send");
            return { text };
        }
        case "poll": {
            const question = String(p.question ?? "").trim();
            if (!question) throw new Error("a 'poll' task needs payload.question");
            const options = (Array.isArray(p.options) ? p.options : [])
                .map((o: any) => String(o ?? "").trim())
                .filter(Boolean);
            const unique = [...new Set(options)];
            if (unique.length < 2) throw new Error("a poll needs at least 2 distinct options");
            if (unique.length > MAX_POLL_OPTIONS) throw new Error(`a poll can have at most ${MAX_POLL_OPTIONS} options`);
            return { question, options: unique, allow_multiple: !!p.allow_multiple };
        }
        case "generated": {
            const instruction = String(p.instruction ?? "").trim();
            if (!instruction) throw new Error("a 'generated' task needs payload.instruction — what to write each time");
            if (instruction.length > 1000) throw new Error("keep the instruction under 1000 characters");
            return { instruction, web_search: !!p.web_search };
        }
        default:
            throw new Error(`unknown task kind '${kind}' — use one of: ${TASK_KINDS.join(", ")}`);
    }
}

// Clean up a monthly spec: whole days 1–31, sorted and de-duplicated. Throws
// when nothing usable is left, so a broken schedule fails at creation instead of
// quietly never firing.
export function normalizeDaysOfMonth(days: unknown): number[] {
    const raw = Array.isArray(days) ? days : [days];
    const out = new Set<number>();
    for (const d of raw) {
        const n = typeof d === "number" ? d : parseInt(String(d ?? "").trim(), 10);
        if (Number.isInteger(n) && n >= 1 && n <= 31) out.add(n);
    }
    if (!out.size) throw new Error("days_of_month must contain at least one day between 1 and 31");
    return [...out].sort((a, b) => a - b);
}

// Human-readable schedule, for confirming back to the user and for the admin UI.
export function describeSchedule(task: ScheduleSpec): string {
    const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = (task.days_of_week || []).slice().sort((a, b) => a - b);
    const hh = `${String(task.hour_local).padStart(2, "0")}:00`;
    const tz = task.timezone || "UTC";
    if (task.run_on_date) return `once, on ${task.run_on_date} at ${hh} (${tz})`;
    const monthDays = (task.days_of_month || []).slice().sort((a, b) => a - b);
    if (monthDays.length) {
        const list = monthDays.length === 1
            ? `the ${monthDays[0]}`
            : `the ${monthDays.slice(0, -1).join(", ")} and ${monthDays[monthDays.length - 1]}`;
        return `${list} of every month at ${hh} (${tz})`;
    }
    let when: string;
    if (days.length === 7) when = "every day";
    else if (days.length === 5 && WORKDAYS.every(d => days.includes(d))) when = "every workday";
    else if (days.length === 2 && days.includes(0) && days.includes(6)) when = "every weekend";
    else when = days.map(d => NAMES[d] ?? "?").join(", ");
    return `${when} at ${hh} (${tz})`;
}

// Remove Gepetel's own number(s) so region/language is inferred from real members.
export const BOT_PHONE_DIGITS = ["40750271099", "279697464266959"];
// The dialable WhatsApp number people add to a group to invite Gepetel.
export const BOT_PHONE_DISPLAY = "+40750271099";
// --- Running out of OpenAI credits ---

export const CREATOR_NAME = "Bogdan";

// Is this the "the account is empty" error, as opposed to an ordinary rate limit?
// Both arrive as HTTP 429, but they mean opposite things: a rate limit clears by
// itself in seconds and should stay silent, while an exhausted balance stays
// broken until a human tops it up — which nobody notices if Gepetel just goes quiet.
export function isOutOfCredits(err: any): boolean {
    const status = err?.status ?? err?.response?.status;
    if (status !== 429) return false;
    const e = err?.error || err?.response?.data?.error || {};
    const code = String(err?.code || e.code || "").toLowerCase();
    const type = String(err?.type || e.type || "").toLowerCase();
    if (code.includes("credit") || code === "insufficient_quota" || type === "insufficient_quota") return true;
    // Fall back to the message text — the codes have been renamed before.
    const msg = String(e.message || err?.message || "").toLowerCase();
    return msg.includes("no credits") || msg.includes("insufficient_quota") || msg.includes("quota");
}

// What Gepetel says when he can't think. Hard-coded on purpose: generating this
// would need the very API that just failed. Falls back to English.
const OUT_OF_CREDITS: Record<string, (who: string) => string> = {
    Romanian: w => `Oups... am rămas fără credite 😅 Ziceți-i lui ${w} să mai bage niște bani în cont.`,
    English: w => `Oops... I'm out of credits 😅 Someone tell ${w} to top me up.`,
    Italian: w => `Ops... ho finito i crediti 😅 Ditelo a ${w}, deve ricaricare.`,
    Spanish: w => `Ups... me quedé sin créditos 😅 Decidle a ${w} que recargue.`,
    French: w => `Oups... je n'ai plus de crédits 😅 Dites à ${w} de recharger.`,
    German: w => `Ups... meine Credits sind alle 😅 Sagt ${w}, er soll aufladen.`,
};

export function outOfCreditsMessage(language: string = "English", creator: string = CREATOR_NAME): string {
    return (OUT_OF_CREDITS[language] || OUT_OF_CREDITS.English)(creator);
}

// Digits-only form of a phone number / chat id ("+40 750 271 099" -> "40750271099").
export function phoneDigits(value: unknown): string {
    return String(value ?? "").replace(/\D/g, "");
}

// Is this person a member of a group with these participants?
//
// The authorization check behind scheduled tasks, so it is deliberately strict:
// participants are stored either bare ("40711") or suffixed ("40711@s.whatsapp.net"),
// and a match must cover the WHOLE number — "40711" must never match "1140711"
// or "407115555". Anything falsy or non-numeric is a non-member.
export function isParticipant(participants: any[], userChatId: string): boolean {
    const digits = phoneDigits(userChatId);
    if (!digits || !Array.isArray(participants)) return false;
    return participants.some(p => phoneDigits(p) === digits);
}

export function stripBot(participants: any[]): any[] {
    if (!Array.isArray(participants)) return [];
    return participants.filter(p => {
        const digits = String(p || "").replace(/\D/g, "");
        return digits && !BOT_PHONE_DIGITS.includes(digits);
    });
}

export default {
    isGroupChatId, normalizeMentions, isMentioned,
    cleanWhatsAppText, cleanUpAnswer, stripInternalIds, parseToolArgs,
    CALLING_CODES, dominantBy, countryOf, inferRegion, inferLanguage, inferTimezone, currentTimeString,
    activeHoursFromHistogram, pickSendHourUTC, computeNextUnpromptedAt,
    CONTINUATION_WINDOW_MS, replyGateDecision,
    BOT_PHONE_DIGITS, BOT_PHONE_DISPLAY, stripBot, phoneDigits, isParticipant,
    CREATOR_NAME, isOutOfCredits, outOfCreditsMessage,
    splitBill, nextOccurrence, htmlToText,
    localParts, isTaskDue, normalizeDaysOfWeek, normalizeDaysOfMonth, describeSchedule, WORKDAYS,
    TASK_KINDS, MAX_POLL_OPTIONS, validateTaskPayload, attributeToScheduler, isValidLocalDate,
};

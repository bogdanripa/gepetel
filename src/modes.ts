// Group modes: who Gepetel is in a given group.
//
// A mode is a persona prompt (prompts/modes/<id>.txt, dropped into the shared
// group-reply prompt's {{persona}} slot) plus a few defaults for the things
// that decide WHEN he speaks. The persona changes how he talks; the defaults
// change whether he starts conversations, how strict the follow-up gate is,
// and whether he watches untagged messages for tasks. Everything here is pure
// so it can be unit-tested and read by the settings page without a database.
//
// Casual is the default and must behave exactly as Gepetel did before modes
// existed: a group with no setting stored is a casual group.

export type ModeId = "casual" | "work";
export type TaskIntake = "ask" | "auto" | "off";
export type Gatekeeper = "relaxed" | "strict";

export type GroupMode = {
    id: ModeId;
    label: string;
    tagline: string;                 // one line, for the settings page
    description: string;             // a short paragraph, for the settings page
    aliases: string[];               // how people say it in chat, lower-case
    unpromptedDefault: boolean;      // starts conversations on his own
    gatekeeper: Gatekeeper;          // how strict the follow-up gate is
    watchesTasks: boolean;           // runs the task/decision watcher on untagged messages
    taskIntakeDefault: TaskIntake;
};

export const MODES: readonly GroupMode[] = [
    {
        id: "casual",
        label: "Casual",
        tagline: "A witty friend in the group. Jokes, gossip, and help when asked.",
        description: "Dry, observational humour about the people in the room. Follows up on his own lines, starts a conversation now and then when the group is quiet, and quietly does reminders, polls, bill splitting and lookups when someone asks.",
        aliases: ["casual", "normal", "default", "chill", "fun", "friend"],
        unpromptedDefault: true,
        gatekeeper: "relaxed",
        watchesTasks: false,
        taskIntakeDefault: "off",
    },
    {
        id: "work",
        label: "Work",
        tagline: "Speaks when spoken to. Tasks, reminders, decisions. A joke a day at most.",
        description: "Plain and short. Tracks who took what by when, remembers what the group decided, offers a poll when they go back and forth, and summarises what someone missed. Never starts conversations. When a task is agreed in the chat he steps in once to put it on the board or on his list.",
        aliases: ["work", "business", "office", "team", "project", "professional", "serious"],
        unpromptedDefault: false,
        gatekeeper: "strict",
        watchesTasks: true,
        taskIntakeDefault: "ask",
    },
];

export const DEFAULT_MODE: ModeId = "casual";
export const TASK_INTAKES: readonly TaskIntake[] = ["ask", "auto", "off"];

export function isModeId(x: unknown): x is ModeId {
    return typeof x === "string" && MODES.some(m => m.id === x);
}

export function isTaskIntake(x: unknown): x is TaskIntake {
    return typeof x === "string" && (TASK_INTAKES as readonly string[]).includes(x);
}

// Never throws: an unknown or missing id is the default mode, so a stored value
// from a mode that was later removed cannot take a group down with it.
export function modeById(id: unknown): GroupMode {
    return MODES.find(m => m.id === id) ?? MODES.find(m => m.id === DEFAULT_MODE)!;
}

// "business mode", "pune-l pe work", "modul casual" -> the mode meant, or null.
// Whole words only, so "network" never reads as "work".
export function parseModeName(text: string): ModeId | null {
    const words = String(text || "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (const m of MODES) {
        if (m.aliases.some(a => words.includes(a))) return m.id;
    }
    return null;
}

// What is stored on a group. Every field is optional: nothing stored means the
// mode's own defaults.
export type StoredModeSettings = {
    mode?: string | null;
    unprompted?: boolean | null;     // null -> the mode's default
    taskIntake?: string | null;      // null -> the mode's default
};

export type EffectiveSettings = {
    mode: ModeId;
    unprompted: boolean;
    taskIntake: TaskIntake;
    gatekeeper: Gatekeeper;
    watchesTasks: boolean;
};

export function effectiveSettings(g: StoredModeSettings | null | undefined): EffectiveSettings {
    const mode = modeById(g?.mode);
    const unprompted = typeof g?.unprompted === "boolean" ? g.unprompted : mode.unpromptedDefault;
    const taskIntake = isTaskIntake(g?.taskIntake) ? g.taskIntake : mode.taskIntakeDefault;
    return {
        mode: mode.id,
        unprompted,
        taskIntake,
        gatekeeper: mode.gatekeeper,
        // The watcher only exists to feed task intake; "off" means no watching,
        // which also means no per-message model call in that group.
        watchesTasks: mode.watchesTasks && taskIntake !== "off",
    };
}

// The line Gepetel posts in the group when the mode is changed from the settings
// page — fixed wording rather than a model call, so it is cheap and says the same
// thing every time. Kept in the group's own language where we have one.
export function modeChangedMessage(language: string, mode: GroupMode, who: string = ""): string {
    const by = String(who || "").trim();
    if (language === "Romanian") {
        const byText = by ? ` (${by} m-a pus)` : "";
        if (mode.id === "work") return `De acum sunt pe modul Work aici${byText}: vorbesc doar când mi se vorbește, țin evidența la cine ce are de făcut și rețin ce decideți.`;
        return `De acum sunt înapoi pe modul Casual aici${byText}.`;
    }
    const byText = by ? ` (${by} set it)` : "";
    if (mode.id === "work") return `I'm in Work mode here from now on${byText}: I speak when spoken to, keep track of who's doing what by when, and remember what you decide.`;
    return `I'm back in Casual mode here${byText}.`;
}

export default {
    MODES, DEFAULT_MODE, TASK_INTAKES,
    isModeId, isTaskIntake, modeById, parseModeName, effectiveSettings, modeChangedMessage,
};

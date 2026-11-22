// Which model does what — one place, so the answer to "can we afford a better
// one here?" is a line and not a search.
//
// Everything ran on the smallest tier until a family group asked him to leave
// a day after he joined (2026-11-19). Replaying that group's own moments under
// the prompt of the day, four runs each: the small model got 9 of 16 right,
// the same model with high reasoning 8, the middle tier 8, the largest 13 —
// and the largest was the only one that stayed out of a line meant for
// someone else without being told to. More reasoning bought nothing.
//
// So the largest goes where a wrong line costs most and calls are few: in
// groups, where everyone is watching (43 replies in the two weeks measured),
// and in anything he sends that nobody asked for. Private replies — hundreds
// a week, mostly questions with an answer — stay on the small one, as do the
// yes/no checks. Each is an env var away from being changed without a deploy.
const pick = (name: string, fallback: string) => () => String(process.env[name] || "").trim() || fallback;

export const MODELS = {
    /** A reply in a group: public, and judged by people who did not choose him. */
    group: pick("MODEL_GROUP", "gpt-5.6-sol"),
    /** Anything nobody asked for: a greeting, a follow-up, a check-in, a nudge, a scheduled or unprompted post. */
    unprompted: pick("MODEL_UNPROMPTED", "gpt-5.6-sol"),
    /** A reply in a private chat. */
    dm: pick("MODEL_DM", "gpt-5.6-luna"),
    /** Reading a picture someone will act on (a timetable, a document), and looking at it again. */
    vision: pick("MODEL_VISION", "gpt-5.6-terra"),
    /** Yes/no checks, digests, anything where the answer is small. */
    small: pick("MODEL_SMALL", "gpt-5.6-luna"),
};

export default MODELS;

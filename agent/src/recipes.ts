// Recipes: a browse job, remembered so the next one costs no model.
//
// The first time "check my Enel bill" runs, the model drives (Phases 4–5) and
// the loop writes down what worked in a form that survives a reload: open
// this address, click the *link "Facturi"*, type into the *searchbox
// "Caută"* — role and name, never a ref, which changes every page. At the end
// the model says what the job was ("intent") and the loop works out, without
// asking it, where on the final page each fact of the answer came from.
//
// Next time: a cheap model (nano) is asked whether a saved recipe fits the new
// goal, and with what parameters; then the steps run with NO model, the facts
// are read off the page from their anchors, and the answer is the saved
// template with today's values. If a step can't find its element — the site
// changed, the session expired — the normal model loop takes over from right
// there, and a success re-saves the recipe, repaired.
//
// Kept on the Mac only, in the agent's own folder (Application Support), not
// the workspace: a recipe names the person's bank and utilities, and the
// sandboxed shell — which can write the workspace — must not be able to edit
// one. And it never holds a secret: nothing typed into a secret
// field is recorded (those are refused anyway), no step taken while the person
// had the tab (handoff, takeover) is recorded as a step, and query parameters
// that look like credentials are cut from every saved address.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { El } from "./browse.js";

export type Step =
    | { do: "navigate"; url: string }
    | { do: "click"; role: string; name: string }
    | { do: "type"; role: string; name: string; text: string; submit?: boolean }
    | { do: "select"; role: string; name: string; value: string }
    | { do: "press_key"; key: string };

/** Where a fact lives on the final page: the nearest labelled line before it,
 *  and the value's own role. Read back by finding the label again. */
export type Anchor = { fact: string; label: string; role: string };

export type Recipe = {
    id: string;
    intent: string;
    site: string;
    /** Parameters, with the value they had when recorded — the example nano
     *  sees, and how a typed text is recognised as one. */
    params: { name: string; example: string }[];
    steps: Step[];
    anchors: Anchor[];
    /** The answer, with each fact's value replaced by {fact}. */
    template: string;
    created: string;
    used: number;
    repaired: number;
};

const SECRET_PARAM = /^(token|access_token|id_token|auth|authorization|session|sessionid|sid|jsessionid|phpsessid|code|state|key|apikey|api_key|sig|signature|password|pass|pwd|otp|ticket|nonce)$/i;

/** An address with credential-looking query parameters removed. */
export function cleanUrl(raw: string): string {
    try {
        const u = new URL(raw);
        for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.delete(k);
        u.hash = "";
        return u.href;
    } catch { return raw; }
}

export class Recorder {
    steps: Step[] = [];
    /** Set when the job did anything that must not be replayed blind: a
     *  person's choice, a person's hands. */
    tainted = "";

    navigate(url: string) { this.steps.push({ do: "navigate", url: cleanUrl(url) }); }
    click(el: El) { this.steps.push({ do: "click", role: el.role, name: el.name }); }
    type(el: El, text: string, submit: boolean) { this.steps.push({ do: "type", role: el.role, name: el.name, text, ...(submit ? { submit } : {}) }); }
    select(el: El, value: string) { this.steps.push({ do: "select", role: el.role, name: el.name, value }); }
    key(key: string) { this.steps.push({ do: "press_key", key }); }
    taint(why: string) { this.tainted ||= why; }
}

/** Typed text that also appears in the goal is a parameter: next time it is
 *  whatever the new goal says. Everything else typed is kept literally. */
export function parameterize(goal: string, steps: Step[]): { steps: Step[]; params: Recipe["params"] } {
    const params: Recipe["params"] = [];
    const out = steps.map(s => {
        if (s.do !== "type" || s.text.length < 2) return s;
        if (!goal.toLowerCase().includes(s.text.toLowerCase())) return s;
        let p = params.find(x => x.example === s.text);
        if (!p) { p = { name: `p${params.length + 1}`, example: s.text }; params.push(p); }
        return { ...s, text: `{${p.name}}` };
    });
    return { steps: out, params };
}

/** The snapshot as (line, role, name) in reading order — names only, which is
 *  what a label or a value is. */
function lines(yaml: string): { role: string; name: string; text: string }[] {
    const out: { role: string; name: string; text: string }[] = [];
    for (const l of yaml.split("\n")) {
        const m = l.match(/^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/i);
        const t = l.match(/^\s*- text: (.+)$/);
        if (t) out.push({ role: "text", name: t[1].trim(), text: t[1].trim() });
        else if (m && m[2]) out.push({ role: m[1].toLowerCase(), name: m[2].replace(/\\"/g, '"'), text: m[2] });
    }
    return out;
}

/**
 * Where each fact of an answer lives on the page, and the answer as a
 * template — or null when a fact can't be pinned down (then nothing is
 * saved: a recipe that might answer wrongly is worse than none).
 *
 * `facts` are the values the model said its answer rests on. Each is found on
 * the final page; its anchor is the nearest line before it that is not itself
 * a number or a date — the label a person would read it by.
 */
export function anchorFacts(yaml: string, answer: string, facts: Record<string, string>): { anchors: Anchor[]; template: string } | null {
    const ls = lines(yaml);
    const anchors: Anchor[] = [];
    let template = answer;
    for (const [fact, value] of Object.entries(facts)) {
        const v = String(value).trim();
        if (!v || !answer.includes(v)) return null;
        const at = ls.findIndex(l => l.name.includes(v));
        if (at < 0) return null;
        let label = "";
        for (let i = at - 1; i >= 0 && i >= at - 6; i--) {
            const n = ls[i].name.trim();
            if (n && !/^[\d\s.,:/\-–€$£lei RON]+$/i.test(n) && n.length <= 80) { label = n; break; }
        }
        if (!label) return null;
        anchors.push({ fact, label, role: ls[at].role });
        template = template.split(v).join(`{${fact}}`);
    }
    return anchors.length ? { anchors, template } : null;
}

/** Read the facts back off a page by their anchors; null if any is missing. */
export function readFacts(yaml: string, anchors: Anchor[]): Record<string, string> | null {
    const ls = lines(yaml);
    const out: Record<string, string> = {};
    for (const a of anchors) {
        const at = ls.findIndex(l => l.name.trim() === a.label);
        if (at < 0) return null;
        const hit = ls.slice(at + 1, at + 7).find(l => l.role === a.role && l.name.trim() && l.name.trim() !== a.label);
        if (!hit) return null;
        out[a.fact] = hit.name.trim();
    }
    return out;
}

export function fill(template: string, values: Record<string, string>): string {
    return template.replace(/\{([a-z0-9_]+)\}/gi, (m, k) => values[k] ?? m);
}

export class RecipeStore {
    constructor(private dir: string) {}

    all(): Recipe[] {
        try {
            return fs.readdirSync(this.dir).filter(f => f.endsWith(".json")).map(f => {
                try { return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Recipe; } catch { return null; }
            }).filter(Boolean) as Recipe[];
        } catch { return []; }
    }

    /** Candidates for a goal: same site first when a start address is known. */
    candidates(startUrl?: string): Recipe[] {
        const all = this.all();
        let host = "";
        try { host = startUrl ? new URL(startUrl).host : ""; } catch { /* none */ }
        const same = host ? all.filter(r => r.site === host) : [];
        return (same.length ? same : all).sort((a, b) => b.used - a.used).slice(0, 10);
    }

    save(r: Omit<Recipe, "id" | "created" | "used" | "repaired"> & Partial<Pick<Recipe, "id" | "used" | "repaired">>): Recipe {
        fs.mkdirSync(this.dir, { recursive: true });
        const id = r.id || crypto.createHash("sha1").update(`${r.site}|${r.intent}`).digest("hex").slice(0, 12);
        const prev = this.get(id);
        const full: Recipe = {
            ...r, id, created: prev?.created || new Date().toISOString(),
            used: r.used ?? prev?.used ?? 0, repaired: r.repaired ?? prev?.repaired ?? 0,
        };
        const file = path.join(this.dir, `${id}.json`);
        fs.writeFileSync(`${file}.tmp`, JSON.stringify(full, null, 2), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
        return full;
    }

    get(id: string): Recipe | null {
        if (!/^[a-f0-9]{12}$/.test(id)) return null;
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8")); } catch { return null; }
    }

    bump(id: string, field: "used" | "repaired"): void {
        const r = this.get(id);
        if (r) { r[field]++; this.save(r); }
    }
}

/** The gatekeeper's request: which recipe, if any, and its parameters. One
 *  cheap call, a few hundred tokens. */
export function matchRequest(goal: string, cands: Recipe[]): any {
    const list = cands.map((r, i) => `${i + 1}. ${r.intent} (on ${r.site})${r.params.length ? ` — parameters: ${r.params.map(p => `${p.name} (last time: "${p.example}")`).join(", ")}` : ""}`).join("\n");
    return {
        model: "gpt-5-nano",
        instructions: "Decide whether one of the saved procedures does exactly what the request asks — same task, same site — differing at most in its parameters. If none fits exactly, answer 0. Reply with JSON only.",
        input: [{ role: "user", content: [{ type: "input_text", text: `Request: ${goal}\n\nSaved procedures:\n${list}\n\nJSON: {"pick": <number or 0>, "params": {"<name>": "<value from the request>"}}` }] }],
        max_output_tokens: 300,
        reasoning: { effort: "minimal" },
    };
}

export function readMatch(out: any, cands: Recipe[]): { recipe: Recipe; params: Record<string, string> } | null {
    const text = String(out?.output_text || "") || (out?.output || []).flatMap((o: any) => o?.content || []).map((c: any) => c?.text || "").join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j: any;
    try { j = JSON.parse(m[0]); } catch { return null; }
    const pick = Number(j?.pick);
    const recipe = Number.isInteger(pick) && pick >= 1 && pick <= cands.length ? cands[pick - 1] : null;
    if (!recipe) return null;
    const params: Record<string, string> = {};
    for (const p of recipe.params) {
        const v = j?.params?.[p.name];
        if (typeof v !== "string" || !v.trim()) return null;   // a recipe with a missing parameter is not a match
        params[p.name] = v.trim().slice(0, 500);
    }
    return { recipe, params };
}

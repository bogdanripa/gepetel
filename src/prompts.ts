import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// prompts/ lives at the repo root, one level up from the compiled dist/ dir.
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts");

const cache = new Map<string, string>();

function read(name: string): string {
    if (!cache.has(name)) {
        cache.set(name, fs.readFileSync(path.join(PROMPTS_DIR, `${name}.txt`), "utf8"));
    }
    return cache.get(name)!;
}

// Load a prompt template and replace {{var}} placeholders with the given values.
function loadPrompt(name: string, vars: Record<string, string> = {}): string {
    let text = read(name);
    for (const [k, v] of Object.entries(vars)) {
        text = text.split(`{{${k}}}`).join(v ?? "");
    }
    return text;
}

export default { loadPrompt };

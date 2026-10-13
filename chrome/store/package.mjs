// The Chrome Web Store package: dist/ as built, with manifest.json's "key"
// left out — the store refuses a package that names its own key, and gives
// the extension one of its own (its id then goes into agent/src/extension.ts).
//   npm run build && node store/package.mjs   →   store/gepetel-chrome-<version>.zip
import { execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gep-store-"));
fs.cpSync(dist, tmp, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
delete manifest.key;
fs.writeFileSync(path.join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// No source maps or dev leftovers in the store package.
for (const f of execFileSync("find", [tmp, "-name", "*.map"]).toString().split("\n").filter(Boolean)) fs.rmSync(f);
const out = path.join(here, `gepetel-chrome-${manifest.version}.zip`);
fs.rmSync(out, { force: true });
execFileSync("zip", ["-qrX", out, "."], { cwd: tmp });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${out} (${Math.round(fs.statSync(out).size / 1024)} KB), version ${manifest.version}, no key`);

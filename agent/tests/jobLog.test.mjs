import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { JobLog, KEEP_DAYS } from "../dist/jobLog.js";

test("a job's lines and its summary go to one file under its day; old days go", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gep-jobs-"));
  const now = new Date("2026-10-14T08:00:00Z");
  const old = new Date(now.getTime() - (KEEP_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
  fs.mkdirSync(path.join(dir, old)); fs.writeFileSync(path.join(dir, old, "j_old.log"), "x");
  fs.mkdirSync(path.join(dir, "2026-10-13")); fs.writeFileSync(path.join(dir, "2026-10-13", "j_y.log"), "y");
  const jl = new JobLog("j_abc", dir, now);
  jl.line("browse step 2: click");
  jl.summary({ goal: "is my trip paid?", ok: true, answer: "Paid.", steps: 3, calls: 3, tokens: 9000 });
  assert.equal(jl.file, path.join(dir, "2026-10-14", "j_abc.log"));
  const text = fs.readFileSync(jl.file, "utf8");
  assert.match(text, /browse step 2: click/);
  assert.match(text, /=== summary \{"goal":"is my trip paid\?","ok":true,"answer":"Paid\.","steps":3,"calls":3,"tokens":9000,"seconds":\d+\}/);
  assert.equal((fs.statSync(jl.file).mode & 0o777), 0o600);
  assert.ok(!fs.existsSync(path.join(dir, old)), "a day past the limit is gone");
  assert.ok(fs.existsSync(path.join(dir, "2026-10-13", "j_y.log")), "yesterday stays");
  fs.rmSync(dir, { recursive: true, force: true });
});

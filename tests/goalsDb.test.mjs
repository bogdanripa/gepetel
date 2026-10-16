// The goal store (goals.ts) against a real database — set TEST_DATABASE_URL.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL (a throwaway DB) to run";
let goals, mongoose;
const C = "40799999990@s.whatsapp.net";

before(async () => {
  if (skip) return;
  mongoose = (await import("mongoose")).default;
  await mongoose.connect(TEST_DB);
  goals = (await import("../dist/goals.js")).default;
  await goals.closeGoal(C);
});
after(async () => { if (!skip) { await goals.closeGoal(C); await mongoose.disconnect(); } });

test("kept while waiting; a short answer keeps their words; continues are bounded; the same thing missing twice stops it", { skip }, async () => {
  await goals.keepGoal(C, "When is my next ski trip?", "a login (Google Calendar)");
  assert.equal((await goals.getGoal(C)).waitingFor, "a login (Google Calendar)");
  await goals.keepGoal(C, "da", "their computer");
  assert.equal((await goals.getGoal(C)).asked, "When is my next ski trip?", "a short answer isn't a new request");
  assert.equal(await goals.spendContinue(C, "read the calendar"), true);
  assert.equal(await goals.spendContinue(C, "read the calendar"), false, "the same thing missing again: a loop");
  assert.equal(await goals.spendContinue(C, "find the dates"), true);
  assert.equal(await goals.spendContinue(C, "find the place"), true);
  assert.equal(await goals.spendContinue(C, "something else"), false, `bounded at ${goals.MAX_CONTINUES}`);
  await goals.keepGoal(C, "Book me a table at Caju for Friday at 8", "their computer");
  const g = await goals.getGoal(C);
  assert.equal(g.asked, "Book me a table at Caju for Friday at 8");
  assert.equal(g.continues, 0, "a new request starts its own count");
  await goals.closeGoal(C);
  assert.equal(await goals.getGoal(C), null);
});

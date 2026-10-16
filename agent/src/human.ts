// Clicking and typing the way a person does (asked for by the owner, 2026-10-13:
// "emulate a human behavior as close as possible").
//
// Playwright's own click is a real mouse event, but the pointer appears in the
// middle of the element from nowhere, and its type fills the field in one go —
// no keys. Here, through Playwright's mouse and keyboard (Chrome's input
// events, the same ones the hardware makes):
//  - the pointer travels to the element along a slight curve, with a tremor,
//    and lands a bit off its middle — never dead center;
//  - it rests there, and reads the cursor the page shows (a hand: something
//    to click) and whether the page reacted to the hover;
//  - the press is held for a moment;
//  - a second later the screen is compared with how it looked just before
//    the press — the owner's idea: "wait a second and compare the
//    screenshots, that's what I'd do". Nothing changed is worth knowing:
//    on booking.com the job clicked the same link again and again;
//  - text goes in a key at a time, with uneven gaps, and now and then a
//    wrong key, noticed and taken back with Backspace;
//  - while the job thinks, the pointer drifts a little (idleCode).
//
// Each is one browser_run_code_unsafe call; Playwright waits for what it
// starts (a navigation) as for its own click.

/** What a human click found. */
export type HumanClick =
    | { ok: true; cursor: string; hoverReacts: boolean; changed: boolean; newTab: boolean; moved: boolean; ms?: Record<string, number>; real?: boolean }
    | { ok: false; covered?: string; why?: string; fallback?: boolean };

/** Refs are Playwright's own (`e12`, `f1e3`); nothing else is put in code. */
function safeRef(ref: string): string {
    if (!/^[A-Za-z0-9_]{1,24}$/.test(ref)) throw new Error(`not a ref: ${ref}`);
    return ref;
}

/** In the code run by Playwright: random numbers, a point a bit off an
 *  element's middle, and moving the pointer there as a hand does. */
const HELPERS = `
  // A tab in the background gets no input: Chrome doesn't draw it, and a
  // mouse move waits for ever (after the job moved to a new tab and closed
  // the old one, Chrome showed another). Only when hidden: bringing a tab
  // forward can raise its window.
  const front = async () => { if (await page.evaluate(() => document.visibilityState).catch(() => 'visible') === 'hidden') await page.bringToFront().catch(() => {}); };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const clampX = x => Math.min(vp.width - 2, Math.max(1, x)), clampY = y => Math.min(vp.height - 2, Math.max(1, y));
  // Off the middle, by 8–28% of the size, either way; kept well inside.
  const offCenter = box => {
    const side = () => (Math.random() < 0.5 ? -1 : 1) * rnd(0.08, 0.28);
    return { x: box.x + box.width * Math.min(0.85, Math.max(0.15, 0.5 + side())), y: box.y + box.height * Math.min(0.8, Math.max(0.2, 0.5 + side() * 0.8)) };
  };
  const here = () => page.__gepetelMouse || { x: clampX(rnd(0.3, 0.7) * vp.width), y: clampY(rnd(0.3, 0.7) * vp.height) };
  // Eased, a slight curve, a tremor of a pixel or two, an uneven pace.
  const travel = async (to, pace = 1) => {
    const from = here(), d = Math.hypot(to.x - from.x, to.y - from.y);
    // Each step is a round trip to Chrome (through the extension): enough
    // for a path, not one per few pixels.
    const n = Math.max(6, Math.round(rnd(8, 12) + d / 150)), bend = rnd(-0.12, 0.12);
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, off = Math.sin(t * Math.PI) * bend;
      const jig = i < n ? 1.6 : 0;
      await page.mouse.move(clampX(from.x + (to.x - from.x) * e - (to.y - from.y) * off + rnd(-jig, jig)), clampY(from.y + (to.y - from.y) * e + (to.x - from.x) * off + rnd(-jig, jig)));
      await page.waitForTimeout(rnd(6, 18) * pace);
    }
    page.__gepetelMouse = { x: to.x, y: to.y };
  };
  // Resting on something: a hand isn't perfectly still.
  const rest = async ms => {
    const end = Date.now() + ms, at = here();
    while (Date.now() < end) {
      await page.waitForTimeout(rnd(40, 110));
      await page.mouse.move(clampX(at.x + rnd(-1, 1)), clampY(at.y + rnd(-1, 1)));
    }
    await page.mouse.move(at.x, at.y);
  };`;

/** Finding where on an element a person's click lands: off its middle, on a
 *  point where the element itself is on top. Leaves `loc`, `to`, `shot`
 *  and `same` defined, or returns why not. */
function aimCode(ref: string): string {
    return `
  const loc = page.locator('aria-ref=${safeRef(ref)}');
  // Small: through the extension every byte of a screenshot crosses Chrome's
  // debugger, and three full PNGs a click made a click on OLX take half a
  // minute. A JPEG at low quality still shows whether anything changed; the
  // hover only needs the area around the element.
  // At the screen's own scale: 'css' made Chrome draw the page at half
  // size for the shot, on a Retina screen — the window's content shrank and
  // came back three times a click (the owner: "the chrome window keeps
  // flashing … resized to a small area and then back").
  // And never a part of the page: a clip may be drawn the same way.
  const shot = () => page.screenshot({ type: 'jpeg', quality: 30, scale: 'device', timeout: 3000 }).catch(() => null);
  const same = (a, b) => !!a && !!b && a.equals(b);
  const h = await loc.elementHandle({ timeout: 3000 }).catch(() => null);
  if (!h) return { ok: false, why: 'not on the page' };
  // In a frame, the page's coordinates aren't the frame's: Playwright's own click.
  if ((await h.ownerFrame()) !== page.mainFrame()) return { ok: false, fallback: true, why: 'in a frame' };
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  // The element's own boxes: a link that wraps has one per line, and its
  // bounding box takes in the gap beside them (a point there missed it).
  const rects = await loc.evaluate(el => [...el.getClientRects()].map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })).filter(r => r.width >= 1 && r.height >= 1)).catch(() => []);
  if (!rects.length) return { ok: false, why: 'not visible' };
  const big = rects.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b);
  // What is under a point: the element itself (or inside it) — or something
  // over it, or only something around it.
  const hitAt = p => loc.evaluate((el, [x, y]) => {
    const t = document.elementFromPoint(x, y);
    if (!t) return { inside: false, around: false, cover: '' };
    const up = (a, b) => { for (let n = a; n; n = n.parentNode || n.host) if (n === b) return true; return false; };
    const inside = up(t, el), around = !inside && up(el, t);
    const c = inside || around ? '' : '<' + t.tagName.toLowerCase() + (t.id ? ' id="' + t.id + '"' : '') + (typeof t.className === 'string' && t.className ? ' class="' + t.className.slice(0, 60) + '"' : '') + '>';
    return { inside, around, cover: c };
  }, [p.x, p.y]).catch(() => ({ inside: true, around: false, cover: '' }));
  let to = offCenter(big), hit = await hitAt(to);
  for (let i = 0; !hit.inside && i < 3; i++) { to = offCenter(rects[i % rects.length]); hit = await hitAt(to); }
  // Only the page around it under every point: Playwright's own click.
  if (!hit.inside && hit.around) return { ok: false, fallback: true, why: 'no point on it to press' };
  if (!hit.inside) return { ok: false, covered: hit.cover + ' intercepts pointer events' };
`;
}

export function humanClickCode(ref: string): string {
    return `async (page) => {${HELPERS}
  const T0 = Date.now(), ms = {}; let T = T0; const lap = k => { const n = Date.now(); ms[k] = n - T; T = n; };
  await front();
${aimCode(ref)}  lap('aim');
  const quiet = await shot();
  lap('shot');
  await travel(to);
  await rest(rnd(150, 350));
  const cursor = await page.evaluate(([x, y]) => { const t = document.elementFromPoint(x, y); return t ? getComputedStyle(t).cursor : ''; }, [to.x, to.y]).catch(() => '');
  lap('travel');
  const hovered = await shot();
  lap('shot2');
  const url0 = page.url(), tabs0 = page.context().pages().length;
  // Only for a link that opens a new tab: other clicks don't wait. Read
  // before the press — after it the page may be gone, and reading waited 30 s.
  const opensTab = await loc.evaluate(el => { const a = el.closest('a'); return !!a && (a.target === '_blank' || a.getAttribute('rel') === 'external'); }, null, { timeout: 1000 }).catch(() => false);
  await page.mouse.down();
  await page.waitForTimeout(rnd(55, 130));
  await page.mouse.up();
  lap('press');
  await page.waitForTimeout(1000);
  const after = await shot();
  lap('shot3');
  // A link may open a tab a few seconds later (booking.com's trip, in the
  // owner's Chrome, ~3 s): while the address stays, wait for one up to 4 s.
  let newTab = page.context().pages().length > tabs0;
  for (let i = 0; opensTab && !newTab && page.url() === url0 && i < 8; i++) { await new Promise(r => setTimeout(r, 500)); newTab = page.context().pages().length > tabs0; }
  lap('tab');
  return { ok: true, ms, cursor, hoverReacts: !!quiet && !!hovered && !same(quiet, hovered), changed: !after || !hovered || !same(hovered, after) || page.url() !== url0, newTab, moved: page.url() !== url0 };
}`;
}

/** With real input from macOS (osInput.ts) — the Mac's own pointer moves
 *  and presses, as the owner asked ("why is the mouse not moving as you open
 *  dropdowns or click dates?") — a click is three steps: here, where to
 *  press and how the page looked; then the app's press; then humanAfterCode.
 *  The point is in the page's own (CSS) pixels, with the page's size for the
 *  app to place it on the screen. */
export type HumanAim =
    | { ok: true; x: number; y: number; innerW: number; innerH: number; url: string; tabs: number; opensTab: boolean; cursor: string; before: string }
    | { ok: false; covered?: string; why?: string; fallback?: boolean };

/** A screenshot as a short fingerprint: only "the same or not" crosses back. */
const SIG = `const sig = b => { if (!b) return ''; let h = 2166136261; for (let i = 0; i < b.length; i += 3) h = Math.imul(h ^ b[i], 16777619); return (h >>> 0).toString(36) + ':' + b.length; };`;

export function humanAimCode(ref: string): string {
    return `async (page) => {${HELPERS}
  ${SIG}
  await front();
${aimCode(ref)}
  const cursor = await page.evaluate(([x, y]) => { const t = document.elementFromPoint(x, y); return t ? getComputedStyle(t).cursor : ''; }, [to.x, to.y]).catch(() => '');
  const opensTab = await loc.evaluate(el => { const a = el.closest('a'); return !!a && (a.target === '_blank' || a.getAttribute('rel') === 'external'); }, null, { timeout: 1000 }).catch(() => false);
  const inner = await page.evaluate(() => [innerWidth, innerHeight]).catch(() => [0, 0]);
  // The "before" picture with the page hovered where the press will land, as
  // it will be when the app's pointer arrives: a button left hovered by the
  // last click, un-hovered now, isn't the click changing something.
  await page.mouse.move(to.x, to.y).catch(() => {}); page.__gepetelMouse = to;
  await page.waitForTimeout(rnd(120, 220));
  const before = sig(await shot());
  return { ok: true, x: to.x, y: to.y, innerW: inner[0], innerH: inner[1], url: page.url(), tabs: page.context().pages().length, opensTab, cursor, before };
}`;
}

/** After the app's press: a second later, did the screen change, did a tab
 *  open (waited for as humanClickCode does), did the page go elsewhere. */
export function humanAfterCode(aim: { url: string; tabs: number; opensTab: boolean; before: string }): string {
    const a = JSON.stringify({ url: aim.url, tabs: aim.tabs, opensTab: aim.opensTab, before: aim.before });
    return `async (page) => {
  ${SIG}
  const A = ${a};
  await page.waitForTimeout(1000);
  const after = sig(await page.screenshot({ type: 'jpeg', quality: 30, scale: 'device', timeout: 3000 }).catch(() => null));
  let newTab = page.context().pages().length > A.tabs;
  for (let i = 0; A.opensTab && !newTab && page.url() === A.url && i < 8; i++) { await new Promise(r => setTimeout(r, 500)); newTab = page.context().pages().length > A.tabs; }
  return { changed: !after || !A.before || after !== A.before || page.url() !== A.url, newTab, moved: page.url() !== A.url };
}`;
}

/** Before real typing: the field focused (the app's press put it there) and
 *  what's in it selected, for the app's Backspace to take away — ⌘A sent
 *  through Chrome's debugger is a bare keypress on a Mac, not Select All:
 *  "Brasov" went into the middle of the last job's "Madonna di Campiglio"
 *  on booking.com (2026-10-14). Answers how many characters were there
 *  (-1: not focused). */
export function clearFieldCode(ref: string, select = true): string {
    return `async (page) => {
  const loc = page.locator('aria-ref=${safeRef(ref)}');
  const focused = await loc.evaluate(el => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
  if (!focused) return -1;
  const n = await loc.evaluate(el => { const f = el.matches('input,textarea') ? el : el.querySelector('input,textarea') || el; return ('value' in f ? f.value : f.textContent || '').length; }).catch(() => 0);
  if (n && ${select ? "true" : "false"}) await loc.selectText({ timeout: 2000 }).catch(() => {});
  return n;
}`;
}

/** What a field holds now: to see the typing landed. */
export function fieldValueCode(ref: string): string {
    return `async (page) => page.locator('aria-ref=${safeRef(ref)}').evaluate(el => { const f = el.matches('input,textarea') ? el : el.querySelector('input,textarea') || el; return 'value' in f ? f.value : f.textContent || ''; }).catch(() => null)`;
}

/** Typing as runs of text for the app, with now and then a wrong key that is
 *  taken back: [text, slip?] pieces — a slip is typed, then Backspace. */
export function typingPlan(text: string, slips: number = SLIP_RATE, rand: () => number = Math.random): { text: string; slip?: string }[] {
    const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    const near = (ch: string): string | null => {
        const lo = ch.toLowerCase();
        for (const row of ROWS) {
            const i = row.indexOf(lo); if (i < 0) continue;
            const opts = [row[i - 1], row[i + 1]].filter(Boolean) as string[];
            const k = opts[Math.floor(rand() * opts.length)];
            return ch === lo ? k : k.toUpperCase();
        }
        return null;
    };
    const out: { text: string; slip?: string }[] = [];
    let run = "";
    for (const ch of [...text]) {
        const slip = rand() < (Number.isFinite(slips) ? slips : SLIP_RATE) ? near(ch) : null;
        if (slip) { if (run) out.push({ text: run }); run = ""; out.push({ text: "", slip }); }
        run += ch;
    }
    if (run) out.push({ text: run });
    return out;
}

/** Into a field: a click on it (off its middle), what's there selected and
 *  removed, then the text a key at a time — the first part; anything past it
 *  goes in at once (two thousand characters a key at a time is minutes). Now
 *  and then a slip: the key next to the right one, a pause, Backspace, the
 *  right key. The text is the last thing in the code: the log shows only the
 *  first 80 characters of it. */
export const KEYS_AT_MOST = 100;
/** How often a letter slips, per key typed by hand. */
export const SLIP_RATE = 0.03;

export function humanTypeCode(ref: string, text: string, submit: boolean, slips: number = SLIP_RATE): string {
    return `async (page) => {${HELPERS}
  await front();
  const loc = page.locator('aria-ref=${safeRef(ref)}');
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const box = await loc.boundingBox({ timeout: 3000 }).catch(() => null);
  if (box && box.width > 2) {
    const to = offCenter(box);
    await travel(to); await rest(rnd(80, 200));
    await page.mouse.down(); await page.waitForTimeout(rnd(50, 120)); await page.mouse.up();
  } else await loc.click({ timeout: 5000 });
  if (!(await loc.evaluate(el => el === document.activeElement || el.contains(document.activeElement)).catch(() => true))) await loc.focus();
  await page.waitForTimeout(rnd(150, 350));
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform)).catch(() => true);
  // Select All from the page: ⌘A through Chrome's debugger is a bare key
  // on a Mac, and the old text stayed (see clearFieldCode).
  if (await loc.inputValue({ timeout: 1000 }).catch(() => '')) {
    await loc.selectText({ timeout: 2000 }).catch(() => page.keyboard.press(mac ? 'Meta+A' : 'Control+A'));
    await page.waitForTimeout(rnd(40, 120));
    await page.keyboard.press('Backspace');
  }
  await page.waitForTimeout(rnd(80, 200));
  const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const near = ch => {
    const lo = ch.toLowerCase();
    for (let r = 0; r < 3; r++) { const i = ROWS[r].indexOf(lo); if (i < 0) continue;
      const opts = [ROWS[r][i - 1], ROWS[r][i + 1]].filter(Boolean); const k = opts[Math.floor(Math.random() * opts.length)];
      return ch === lo ? k : k.toUpperCase(); }
    return null;
  };
  const gap = () => rnd(45, 140) + (Math.random() < 0.07 ? rnd(180, 500) : 0);
  const keys = [...TEXT];
  for (const ch of keys.slice(0, ${KEYS_AT_MOST})) {
    const slip = Math.random() < ${Number.isFinite(slips) ? slips : SLIP_RATE} ? near(ch) : null;
    if (slip) {
      await page.keyboard.type(slip);
      await page.waitForTimeout(rnd(120, 380));
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(rnd(70, 200));
    }
    await page.keyboard.type(ch);
    await page.waitForTimeout(gap());
  }
  if (keys.length > ${KEYS_AT_MOST}) await page.keyboard.insertText(keys.slice(${KEYS_AT_MOST}).join(''));
  if (${submit ? "true" : "false"}) { await page.waitForTimeout(rnd(250, 600)); await page.keyboard.press('Enter'); }
  return true;
}`.replace("[...TEXT]", `[...${JSON.stringify(text)}]`);
}

/** While the job waits for its next step: the pointer drifts a short way,
 *  slowly, as a hand resting on a mouse does. Small moves, so a menu that
 *  opens on hover mostly doesn't; never a click. Marked quiet: not logged. */
export function idleCode(): string {
    return `/*quiet*/ async (page) => {${HELPERS}
  if (await page.evaluate(() => document.visibilityState).catch(() => 'hidden') === 'hidden') return false;
  const at = here();
  const to = { x: clampX(at.x + rnd(-90, 90)), y: clampY(at.y + rnd(-60, 60)) };
  await travel(to, rnd(3, 6));
  return true;
}`;
}

/** What the page says about some text boxes: type, visible, and hints
 *  (autocomplete, id, name, placeholder, aria-label, the text beside it) —
 *  for sign-in forms whose labels the snapshot can't see (passwords.ts,
 *  fieldsFromProbe). Never a value. */
export function boxProbeCode(refs: string[]): string {
    const list = JSON.stringify(refs.slice(0, 12).map(safeRef));
    return `async (page) => {
  const out = [];
  for (const ref of ${list}) {
    const v = await page.locator('aria-ref=' + ref).evaluate(el => {
      const f = el.matches('input,textarea') ? el : el.querySelector('input,textarea') || el;
      const type = f.tagName === 'INPUT' ? (f.getAttribute('type') || 'text').toLowerCase() : f.tagName.toLowerCase();
      const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
      const visible = r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      let near = (f.labels && f.labels[0] && f.labels[0].innerText) || '';
      for (let p = f.parentElement, i = 0; !near && p && i < 3; p = p.parentElement, i++) {
        const t = (p.innerText || '').trim();
        if (t && t.length < 120) near = t;
      }
      const hint = [f.getAttribute('autocomplete'), f.id, f.getAttribute('name'), f.getAttribute('placeholder'), f.getAttribute('aria-label'), near]
        .filter(Boolean).join(' ').replace(/\\s+/g, ' ').slice(0, 200);
      return { type, visible, hint };
    }).catch(() => null);
    if (v) out.push({ ref, ...v });
  }
  return out;
}`;
}

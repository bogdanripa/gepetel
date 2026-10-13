// Gepetel fork: in the tabs Gepetel is driving, other extensions' frames are
// taken out of the page as soon as they appear.
//
// Chrome lets no extension debug a page that holds another extension's frame,
// so a password manager's suggestion menu on a sign-in page (iCloud Passwords,
// found on a real Mac on 2026-10-12, within 0.1 s of the page loading) took
// the tab from Gepetel: the job lost its page, the phone takeover had nothing
// to show, a "Sign in with Google" popup stayed black. Taking the frame out
// keeps the tab Gepetel's; the person's own tabs are never touched, and a
// tab Gepetel kept between jobs is left alone until a job uses it again.
//
// Runs at document_start in every page; it asks the extension first whether
// this tab is one Gepetel is driving, and does nothing anywhere else — not
// even watch the page.
(() => {
  const own = chrome.runtime.getURL('');
  const isForeign = el => el instanceof HTMLIFrameElement && /^chrome-extension:\/\//i.test(el.src || '') && !el.src.startsWith(own)
    || (el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement) && /^chrome-extension:\/\//i.test(el.src || el.data || '') && !String(el.src || el.data).startsWith(own);
  let on = false;
  const log = (what, took) => { try { chrome.runtime.sendMessage({ type: 'gepetelGuardLog', what: what.slice(0, 200), took: !!took }).catch(() => {}); } catch (e) {} };
  const take = el => {
    if (!on || !el.isConnected) return;
    el.remove();
    log(`took out another extension's frame: ${el.tagName.toLowerCase()} ${String(el.src || el.data).slice(0, 80)} on ${location.host}`, true);
  };
  // Everything under a root, closed shadow roots included (only an extension
  // can open those: chrome.dom). Only on page elements: it threw on others
  // (an SVG icon), on every scan.
  const shadowOf = el => {
    if (!(el instanceof HTMLElement)) return null;
    try { return (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot; } catch (e) { return null; }
  };
  // When the extension is reloaded or updated, this copy stays in the page,
  // cut off ("Extension context invalidated" on every call — thrown on every
  // change in every page it watched). It notices, and stops for good.
  const observers = [];
  let again = null, dead = false;
  const alive = () => {
    if (dead) return false;
    let ok = false;
    try { ok = !!chrome.runtime && !!chrome.runtime.id; } catch (e) { ok = false; }
    if (!ok) { dead = true; on = false; for (const o of observers) o.disconnect(); if (again) clearInterval(again); }
    return ok;
  };
  const watched = new WeakSet();
  const scan = root => {
    if (!alive()) return;
    for (const el of root.querySelectorAll('*')) {
      if (isForeign(el)) take(el);
      const sr = shadowOf(el);
      if (sr) { watch(sr); scan(sr); }   // what's already inside, not only what comes later
    }
  };
  const watch = root => {
    if (watched.has(root)) return;
    watched.add(root);
    const o = new MutationObserver(records => {
      if (!alive()) return;
      for (const r of records) {
        if (r.type === 'attributes') { if (isForeign(r.target)) take(r.target); continue; }
        // The other extension took its frame away itself (the person pressed
        // Esc on its menu): the tab can be ours again.
        if (on) for (const n of r.removedNodes) if (n.nodeType === 1 && isForeign(n)) log(`another extension's frame went on ${location.host}`, true);
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (isForeign(n)) take(n);
          scan(n);
          const sr = shadowOf(n);
          if (sr) { watch(sr); scan(sr); }
        }
      }
    });
    o.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data'] });
    observers.push(o);
  };
  // The extension left this tab to the person (Chrome took it for another
  // extension's frame): stop taking frames out — that went in a loop.
  try {
    chrome.runtime.onMessage.addListener(m => {
      if (m && m.type === 'gepetelGuardOff' && on) { on = false; for (const o of observers) o.disconnect(); if (again) clearInterval(again); log(`off for ${location.host} (the tab is left to the person)`); }
    });
  } catch (e) {}
  chrome.runtime.sendMessage({ type: 'gepetelGuard' }).then(r => {
    if (!r || !r.on) return;
    log(`on for ${location.host}`);
    on = true;
    // Only now, and only here: in every other tab this script does nothing at
    // all (it used to watch every page in the person's browser).
    watch(document);
    scan(document);
    // A frame can be put in a shadow root attached later; look again a few times.
    let n = 0;
    again = setInterval(() => { scan(document); if (++n >= 20) clearInterval(again); }, 250);
  }).catch(() => {});
})();

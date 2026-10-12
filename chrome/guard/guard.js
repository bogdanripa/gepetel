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
// this tab is one Gepetel is driving, and does nothing anywhere else.
(() => {
  const own = chrome.runtime.getURL('');
  const isForeign = el => el instanceof HTMLIFrameElement && /^chrome-extension:\/\//i.test(el.src || '') && !el.src.startsWith(own)
    || (el instanceof HTMLEmbedElement || el instanceof HTMLObjectElement) && /^chrome-extension:\/\//i.test(el.src || el.data || '') && !String(el.src || el.data).startsWith(own);
  let on = false;
  const seen = [];
  const log = (what, took) => { try { chrome.runtime.sendMessage({ type: 'gepetelGuardLog', what: what.slice(0, 200), took: !!took }); } catch (e) {} };
  const take = el => {
    if (!on || !el.isConnected) return;
    el.remove();
    log(`took out another extension's frame: ${el.tagName.toLowerCase()} ${String(el.src || el.data).slice(0, 80)} on ${location.host}`, true);
  };
  // Everything under a root, closed shadow roots included (only an extension
  // can open those: chrome.dom).
  const watched = new WeakSet();
  const scan = root => {
    for (const el of root.querySelectorAll('*')) {
      if (isForeign(el)) { if (on) take(el); else seen.push(el); }
      const sr = (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(el) : el.shadowRoot;
      if (sr) watch(sr);
    }
  };
  const watch = root => {
    if (watched.has(root)) return;
    watched.add(root);
    new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes') { if (isForeign(r.target)) { if (on) take(r.target); else seen.push(r.target); } continue; }
        // The other extension took its frame away itself (the person pressed
        // Esc on its menu): the tab can be ours again.
        if (on) for (const n of r.removedNodes) if (n.nodeType === 1 && isForeign(n)) log(`another extension's frame went on ${location.host}`, true);
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (isForeign(n)) { if (on) take(n); else seen.push(n); }
          scan(n);
          const sr = (chrome.dom && chrome.dom.openOrClosedShadowRoot) ? chrome.dom.openOrClosedShadowRoot(n) : n.shadowRoot;
          if (sr) { watch(sr); scan(sr); }
        }
      }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data'] });
  };
  watch(document);
  chrome.runtime.sendMessage({ type: 'gepetelGuard' }).then(r => {
    if (!r || !r.on) return;
    log(`on for ${location.host}${seen.length ? `, ${seen.length} frame(s) waiting` : ''}`);
    on = true;
    for (const el of seen.splice(0)) take(el);
    scan(document);
    // A frame can be put in a shadow root attached later; look again a few times.
    let n = 0;
    const again = setInterval(() => { scan(document); if (++n >= 20) clearInterval(again); }, 250);
  }).catch(() => {});
})();

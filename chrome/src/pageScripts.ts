/**
 * Gepetel fork: the functions the direct line (bridge.ts) runs inside a page.
 * executeScript serializes each one on its own, so every function here is
 * self-contained: no imports, no helpers from outside its own body.
 */

/** In the page: what a sign-in or code step needs — its text, and its
 *  visible boxes and buttons with their names and [x, y, w, h] in CSS
 *  pixels. Never a box's value. */
export function pageReading() {
  const rect = (e: Element) => { const q = e.getBoundingClientRect(); return [Math.round(q.left), Math.round(q.top), Math.round(q.width), Math.round(q.height)]; };
  const shown = (e: Element) => { const q = e.getBoundingClientRect(); return q.width >= 4 && q.height >= 4 && q.bottom > 0 && q.top < innerHeight; };
  const nameOf = (e: HTMLElement) => {
    const i = e as HTMLInputElement;
    const lab = i.labels && i.labels[0] ? i.labels[0].innerText : '';
    return (e.getAttribute('aria-label') || lab || i.placeholder || i.name || i.autocomplete || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const boxes: { kind: string; name: string; rect: number[] }[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement>('input, textarea')) {
    if (el.tagName === 'INPUT' && /^(hidden|checkbox|radio|submit|button|image|file|range|color|reset)$/i.test(el.type)) continue;
    if (!shown(el)) continue;
    const name = nameOf(el);
    const kind = el.type === 'password' ? 'password' : el.autocomplete === 'one-time-code' || /code|cod\b|otp|verification/i.test(name) ? 'code' : 'text';
    boxes.push({ kind, name: name || (kind === 'password' ? 'Password' : kind === 'code' ? 'Code' : 'Text'), rect: rect(el) });
    if (boxes.length >= 20) break;
  }
  const buttons: { name: string; rect: number[] }[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('button, [role=button], input[type=submit], a')) {
    if (!shown(el)) continue;
    const name = ((el as HTMLInputElement).value && el.tagName === 'INPUT' ? (el as HTMLInputElement).value : el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) continue;
    buttons.push({ name, rect: rect(el) });
    if (buttons.length >= 40) break;
  }
  return { url: location.href, innerW: innerWidth, innerH: innerHeight, text: (document.body?.innerText || '').slice(0, 6000), boxes, buttons };
}

/** In the page: its text fields, as [x, y, w, h] in CSS pixels. */
export function pageFields(): number[][] {
  const out: number[][] = [];
  for (const el of document.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable=true]')) {
    const i = el as HTMLInputElement;
    if (i.tagName === 'INPUT' && /^(hidden|checkbox|radio|submit|button|image|file|range|color|reset)$/i.test(i.type))
      continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight)
      continue;
    out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
    if (out.length >= 40)
      break;
  }
  return out;
}

/** In the page, in the extension's world: a tap. What the person sees at
 *  that spot, under anything another extension laid over the page — its
 *  frames, and the elements holding them in closed shadow roots, which only
 *  chrome.dom can open. */
export function pageTap(x: number, y: number): string {
  const own = chrome.runtime.getURL('');
  const foreignFrame = (e: Element) => e.tagName === 'IFRAME' && /^chrome-extension:/.test((e as HTMLIFrameElement).src) && !(e as HTMLIFrameElement).src.startsWith(own);
  const holdsForeign = (e: Element): boolean => {
    let sr: ShadowRoot | null = null;
    try { sr = (chrome as any).dom?.openOrClosedShadowRoot?.(e as HTMLElement) ?? null; } catch {}
    return !!sr && [...sr.querySelectorAll('iframe')].some(foreignFrame);
  };
  const isOverlay = (e: Element) => foreignFrame(e) || (e instanceof HTMLElement && holdsForeign(e))
    || (e !== document.body && e !== document.documentElement && !document.body.contains(e));
  const label = (e: Element | null) => {
    if (!e) return 'nothing';
    const h = e as HTMLElement & { type?: string; name?: string };
    const text = (h.getAttribute('aria-label') || (h.tagName === 'INPUT' ? h.getAttribute('placeholder') || h.name : h.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${h.tagName}${h.type ? `[${h.type}]` : ''}${h.id ? `#${h.id}` : ''}${text ? ` "${text}"` : ''}`;
  };
  const stack = document.elementsFromPoint(x, y);
  const skipped = stack.filter(isOverlay);
  const el = (stack.find(e => !isOverlay(e)) || null) as HTMLElement | null;
  if (!el)
    return `nothing at ${x},${y} (page ${innerWidth}x${innerHeight})`;
  const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  const field = el.closest('input, textarea, select, [contenteditable]') as HTMLElement | null;
  const typable = !!field && (field.tagName === 'TEXTAREA' || (field.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|image|file|range|color|reset|hidden)$/i.test((field as HTMLInputElement).type)));
  (field || el).focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  if (!typable)
    el.click();
  return `${typable ? 'focused' : 'clicked'} ${label(field || el)}${skipped.length ? ` (under ${skipped.map(label).join(', ')} — another extension's)` : ''}`;
}

/** In the page: one input from the takeover viewer other than a tap
 *  (pageTap) — text, a key, a drag, a scroll, back. Untrusted events, so
 *  what they would do is done directly. Says what it did, for the log — never what was typed. */
export function pageInput(m: { kind?: string; x?: number; y?: number; text?: string; key?: string; dy?: number }): string {
  const name = (el: Element | null) => {
    if (!el) return 'nothing';
    const h = el as HTMLElement & { type?: string; name?: string };
    const label = (h.getAttribute('aria-label') || (h.tagName === 'INPUT' ? h.getAttribute('placeholder') || h.name : h.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${h.tagName}${h.type ? `[${h.type}]` : ''}${label ? ` "${label}"` : ''}`;
  };
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, v);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  };
  const active = document.activeElement as HTMLElement | null;
  const typable = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
    !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|submit|button|image|file|range|color|reset|hidden)$/i.test((el as HTMLInputElement).type)));
  switch (m.kind) {
    case 'text': {
      const t = String(m.text ?? '');
      if (typable(active)) {
        const s = active.selectionStart ?? active.value.length, e = active.selectionEnd ?? active.value.length;
        setValue(active, active.value.slice(0, s) + t + active.value.slice(e));
        try { active.setSelectionRange(s + t.length, s + t.length); } catch {}
      } else if (active?.isContentEditable) {
        document.execCommand('insertText', false, t);
      } else {
        return `typed nowhere: the focus is on ${name(active)}`;
      }
      return `typed into ${name(active)}`;
    }
    case 'key': {
      const key = String(m.key);
      if (key === 'Backspace' && typable(active)) {
        const s = active.selectionStart ?? active.value.length, e = active.selectionEnd ?? s;
        const from = s === e ? Math.max(0, s - 1) : s;
        setValue(active, active.value.slice(0, from) + active.value.slice(e));
        try { active.setSelectionRange(from, from); } catch {}
        return `deleted in ${name(active)}`;
      }
      if (key === 'Enter' && active && (active as HTMLInputElement).form) {
        const f = (active as HTMLInputElement).form!;
        if (f.requestSubmit) f.requestSubmit(); else f.submit();
        return `submitted the form of ${name(active)}`;
      }
      if (key === 'Tab') {
        const all = [...document.querySelectorAll<HTMLElement>('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])')].filter(x => !(x as HTMLInputElement).disabled && x.offsetParent);
        all[(all.indexOf(active as HTMLElement) + 1) % all.length]?.focus();
        return `focus to ${name(document.activeElement)}`;
      }
      (active || document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      (active || document.body).dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      return `key to ${name(active)}`;
    }
    case 'drag': {
      // Without the debugger only a script's pointer events: a slider check
      // that looks for a real mouse (isTrusted) refuses them — said so in the log.
      const pts = ((m as any).points || []) as number[][];
      if (pts.length < 2) return 'drag: no path';
      const at = (q: number[]) => document.elementFromPoint(q[0], q[1]) as HTMLElement | null;
      const first = at(pts[0]);
      const ev = (type: string, q: number[], target: Element | null) => (target || document.body).dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: q[0], clientY: q[1], pointerId: 1, pointerType: 'mouse', buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', pts[0], first); first?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: pts[0][0], clientY: pts[0][1], buttons: 1 }));
      for (const q of pts.slice(1)) { ev('pointermove', q, at(q) || first); (at(q) || first)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: q[0], clientY: q[1], buttons: 1 })); }
      const end = pts[pts.length - 1];
      ev('pointerup', end, at(end) || first); (at(end) || first)?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: end[0], clientY: end[1] }));
      return `dragged ${name(first)} from ${pts[0][0]},${pts[0][1]} to ${end[0]},${end[1]} (a script's events, not a real mouse)`;
    }
    case 'scroll':
      window.scrollBy(0, Number(m.dy) || 0);
      return `scrolled to ${scrollY}`;
    case 'back':
      history.back();
      return 'back';
  }
  return `unknown input ${m.kind}`;
}

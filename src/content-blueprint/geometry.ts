/**
 * Blueprint geometry + tiny DOM-element helpers. Pure: every function takes its inputs as args and
 * touches no blueprint state — it's the measurement layer the view renders against.
 */
import type { LNode } from '../lib/layout/types';
import { descendantWidgets } from '../lib/layout/model';
import { getAllRidElements } from '../lib/dom-scanner';

export interface Rect { left: number; top: number; width: number; height: number; }

// ── viewport → document space ────────────────────────────────────────────────
// The blueprint layer is position:absolute at the document origin, so it scrolls natively with the
// page. Every element anchored to live BMP content is measured in VIEWPORT space (getBoundingClientRect)
// and must be placed in DOCUMENT space (+ scroll offset). These three helpers are the ONE place that
// conversion happens, so it can't drift across the box builders.

/** Document-space X / Y for a viewport coordinate. */
export const docX = (x: number): number => x + window.scrollX;
export const docY = (y: number): number => y + window.scrollY;

/** rid → live DOM WIDGET element. Built from the inspect scanner, but with the TAB ANCHORS filtered out:
 *  getAllRidElements always includes the tab-strip anchors (so the inspect overlay can badge tabs), and
 *  they carry the PAGE rid at the tab strip's y (above the content). Left in, they pollute the geometry —
 *  widgetRects/unionAllVisible/bmpContentWidth would anchor the canvas + its full-width backdrop up at the
 *  tab strip, painting over BMP's real tabs. The blueprint only ever anchors to widget boxes, so drop them. */
export function ridElementMap(): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const { element, rid } of getAllRidElements(false)) {
    if (element.closest('[class*="tabSet__tab"],[role="tab"]')) continue; // a tab pill / its anchor, not a widget
    if (!map.has(rid)) map.set(rid, element);
  }
  return map;
}

/** Viewport rects of every laid-out widget (skips zero / degenerate boxes). The single source the
 *  result canvas uses to find its anchor, content width, and backdrop extent — callers add their own
 *  viewport/scroll filtering on top. */
export function widgetRects(byRid: Map<string, Element>): DOMRect[] {
  const out: DOMRect[] = [];
  for (const el of byRid.values()) { const r = el.getBoundingClientRect(); if (r.width >= 8 && r.height >= 8) out.push(r); }
  return out;
}

/** Bounding box of all of a node's live child widgets — the container's on-screen area. */
export function unionRect(node: LNode, byRid: Map<string, Element>): Rect | null {
  let l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity, any = false;
  for (const w of descendantWidgets(node)) {
    if (!w.rid) continue;
    const el = byRid.get(w.rid); if (!el) continue;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
    l = Math.min(l, r.left); t = Math.min(t, r.top); rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); any = true;
  }
  return any ? { left: l, top: t, width: rr - l, height: bb - t } : null;
}

/** A node's own anchor box: its DOM rect for a widget (incl. composites), else the union of children. */
export function anchorRect(node: LNode, byRid: Map<string, Element>): Rect | null {
  if (node.kind === 'widget' && node.rid) {
    const el = byRid.get(node.rid); if (!el) return null;
    const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return unionRect(node, byRid);
}

/** Set an element's content to a trusted inline SVG icon (icons.ts constants — no user data, so the
 *  innerHTML is safe). Crisper + correctly centred vs unicode glyphs. */
export function setIcon(el: HTMLElement, svg: string): void { el.innerHTML = svg; }

// Buttons fire on mousedown (to beat BMP's own handlers) and preventDefault — WITHOUT it, the button's
// default mousedown action grabs focus, which STEALS it from an inline-rename field the handler just
// opened + focused (the field blurs and closes → "click Rename, nothing happens"). preventDefault is
// safe because we act on mousedown, not click, and these buttons never need keyboard focus.
const wireBtn = (b: HTMLButtonElement, on: () => void): void => {
  b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); on(); });
};

/** A button wired to a click handler (mousedown so it beats BMP's own handlers; stops propagation). */
export function mkBtn(text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = text;
  wireBtn(b, on);
  return b;
}

/** A button with a Phosphor SVG icon (trusted constant) and an optional text label after it. */
export function mkIconBtn(svg: string, on: () => void, label?: string): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'btn';
  const ic = document.createElement('span'); ic.className = 'bp-ic'; ic.innerHTML = svg; b.appendChild(ic);
  if (label) { const s = document.createElement('span'); s.textContent = label; b.appendChild(s); }
  wireBtn(b, on);
  return b;
}
export function delta(text: string): HTMLElement { const s = document.createElement('span'); s.className = 'delta'; s.textContent = text; return s; }
export function sp(): HTMLElement { const s = document.createElement('span'); s.className = 'sp'; s.textContent = '|'; return s; }

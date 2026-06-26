/**
 * Blueprint geometry + tiny DOM-element helpers. Pure: every function takes its inputs as args and
 * touches no blueprint state — it's the measurement layer the view renders against.
 */
import type { LNode } from '../lib/layout/types';
import { descendantWidgets } from '../lib/layout/model';
import { getAllRidElements } from '../lib/dom-scanner';

export interface Rect { left: number; top: number; width: number; height: number; }

/** rid → live DOM element, the same map the inspect overlay uses (widgets carry data-rid). */
export function ridElementMap(): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const { element, rid } of getAllRidElements(false)) if (!map.has(rid)) map.set(rid, element);
  return map;
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

/** A button wired to a click handler (mousedown so it beats BMP's own handlers; stops propagation). */
export function mkBtn(text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = text;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}
export function delta(text: string): HTMLElement { const s = document.createElement('span'); s.className = 'delta'; s.textContent = text; return s; }
export function sp(): HTMLElement { const s = document.createElement('span'); s.className = 'sp'; s.textContent = '|'; return s; }

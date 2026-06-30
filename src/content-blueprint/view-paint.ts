/**
 * G4 — the paintbrush "paint station": the 2×2 icon panel mounted right of the top bar, plus its three
 * popups (Setup / Save / Load) and the shared "style chip" mini-preview. Pure builders that read `bp` and
 * wire controller actions; render() is owned by the actions, as everywhere in the overlay.
 *
 * The Brush cell is ONE state-driven control (the merged Pick/Paint): empty → eyedropper, sampling →
 * eyedropper + cyan ring, loaded → the held-style chip + brush glyph + purple "armed" fill. So the state
 * is always legible at a glance.
 */
import type { NodeStyle } from '../lib/layout/types';
import type { StylePreset } from '../lib/style-presets';
import { STYLE_PROPS } from '../lib/style-props';
import { ICON_PAINT, ICON_PAINT_FILL, ICON_EYEDROPPER, ICON_SLIDERS, ICON_SAVE, ICON_CHECK, ICON_TRASH } from '../lib/icons';
import { setIcon } from './geometry';
import { colorRgb } from './colors';
import { bp } from './state';
import {
  armPick, armPaint, openPaintPanel, closePaintPanel, setBrushMaskProp, setBrushMaskAll,
  doSavePreset, doLoadPreset, doDeletePreset,
} from './actions';

const PROP_LABEL: Record<string, string> = {
  headerColor: 'Header colour', fontColor: 'Font colour', shadow: 'Shadow',
  headerStyle: 'Header bar', borderStyle: 'Border', transparency: 'Transparency',
};

/** A human-readable preview of a single style prop's value (for the Setup rows). */
function propValueLabel(style: NodeStyle, prop: string): string {
  const s = style as Record<string, string | number | boolean | undefined>;
  switch (prop) {
    case 'headerColor': return style.headerColorBid ? 'set' : 'none';
    case 'fontColor': return style.fontColorBid ? 'set' : 'none';
    case 'shadow': return style.shadow ? 'on' : 'off';
    case 'headerStyle': return titleCase(String(style.headerStyle ?? 'none'));
    case 'borderStyle': return titleCase(String(style.borderStyle ?? 'none'));
    case 'transparency': return `${Number(s.transparency ?? 0)}%`;
    default: return '';
  }
}
const titleCase = (v: string): string => v ? v.charAt(0) + v.slice(1).toLowerCase() : 'None';

/** The shared mini style preview — a tiny widget card showing header colour, border, shadow, font, and
 *  transparency. Reused in the Brush cell, the Load list, and the Save preview. `null` → a blank chip. */
export function styleChip(style: NodeStyle | null): HTMLElement {
  const c = document.createElement('div'); c.className = 'bp-schip';
  if (!style) { c.classList.add('empty'); return c; }
  if (style.headerStyle !== 'NONE') {
    const hdr = document.createElement('div'); hdr.className = 'bp-schip-hdr';
    const hc = colorRgb(style.headerColorBid);
    if (hc) hdr.style.background = hc; else hdr.classList.add('none');
    c.appendChild(hdr);
  }
  const body = document.createElement('div'); body.className = 'bp-schip-body';
  const a = document.createElement('span'); a.className = 'bp-schip-a'; a.textContent = 'A';
  const fc = colorRgb(style.fontColorBid); if (fc) a.style.color = fc;
  body.appendChild(a); c.appendChild(body);
  if (style.borderStyle === 'LINE') c.classList.add('bd');
  if (style.shadow) c.classList.add('sh');
  if (typeof style.transparency === 'number' && style.transparency > 0) c.style.opacity = String(Math.max(0.25, 1 - style.transparency / 100));
  return c;
}

function iconSpan(svg: string): HTMLElement { const s = document.createElement('span'); s.className = 'bp-paint-ic'; setIcon(s, svg); return s; }

/** The 2×2 paint station: Pick · Paint · Setup · Save-library. Pick and Paint are explicit, each lighting
 *  up in its own mode; the held style preview lives on the Paint cell. */
export function paintStation(): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'bp-paint';
  const held = bp.brush.held, mode = bp.brush.mode;

  // Pick (eyedropper) — sample a widget's style. Cyan when armed; doubles as "load a different style".
  const pick = document.createElement('button'); pick.className = 'bp-paint-c bp-paint-pick' + (mode === 'pick' ? ' on' : '');
  pick.append(iconSpan(ICON_EYEDROPPER));
  pick.title = mode === 'pick' ? 'Sampling — click a widget to pick its style' : 'Pick — sample a widget’s style';
  pick.addEventListener('mousedown', (e) => { e.stopPropagation(); armPick(); });
  wrap.appendChild(pick);

  // Paint (brush) — apply the held style. Shows the held chip; purple when armed; disabled with no held.
  const paint = document.createElement('button'); paint.className = 'bp-paint-c bp-paint-brush' + (mode === 'paint' ? ' on' : '');
  if (held) { paint.classList.add('loaded'); paint.append(styleChip(held), iconSpan(ICON_PAINT_FILL)); }
  else { paint.classList.add('disabled'); paint.appendChild(iconSpan(ICON_PAINT)); }
  paint.title = !held ? 'Paint — pick a style first' : mode === 'paint' ? 'Painting — click widgets to apply · Esc to stop' : 'Paint — apply the held style';
  paint.addEventListener('mousedown', (e) => { e.stopPropagation(); armPaint(); });
  wrap.appendChild(paint);

  // Setup — choose what the brush copies.
  const setup = stationCell(ICON_SLIDERS, 'Choose what the brush copies', () => openPaintPanel('setup'), bp.paintPanel === 'setup');
  if (bp.brushMask.size < STYLE_PROPS.length) {
    const b = document.createElement('span'); b.className = 'bp-paint-badge'; b.textContent = String(bp.brushMask.size);
    setup.appendChild(b);
  }
  wrap.appendChild(setup);

  // Save — opens the library menu (save the held style + load/delete saved ones).
  wrap.appendChild(stationCell(ICON_SAVE, 'Saved styles — save the held style or load one', () => openPaintPanel('library'), bp.paintPanel === 'library'));
  return wrap;
}

function stationCell(svg: string, title: string, on: () => void, active: boolean): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-paint-c' + (active ? ' on' : '');
  b.title = title; b.appendChild(iconSpan(svg));
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}

/** The active paint-station popup (setup / save / load), styled in the overlay's `.bp-pick` chrome. */
export function paintPopup(): HTMLElement | null {
  switch (bp.paintPanel) {
    case 'setup': return setupPopup();
    case 'library': return libraryPopup();
    default: return null;
  }
}

function popupShell(title: string): { back: HTMLElement; panel: HTMLElement } {
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePaintPanel(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick bp-paint-pop';
  const h = document.createElement('div'); h.className = 'bp-pick-h'; h.textContent = title;
  panel.appendChild(h);
  back.appendChild(panel);
  return { back, panel };
}

/** Setup — a flat list (no subheaders) of the style props, each a toggle with a value preview. */
function setupPopup(): HTMLElement {
  const { back, panel } = popupShell('What the brush copies');
  const held = bp.brush.held;
  const list = document.createElement('div'); list.className = 'bp-paint-mask';
  for (const sp of STYLE_PROPS) {
    const on = bp.brushMask.has(sp.prop);
    const row = document.createElement('button'); row.className = 'bp-paint-mrow' + (on ? ' on' : '');
    const tick = document.createElement('span'); tick.className = 'bp-paint-tick'; if (on) setIcon(tick, ICON_CHECK);
    const name = document.createElement('span'); name.className = 'bp-paint-mname'; name.textContent = PROP_LABEL[sp.prop] ?? sp.prop;
    row.append(tick, name);
    if (held) { const v = document.createElement('span'); v.className = 'bp-paint-mval'; v.textContent = propValueLabel(held, sp.prop); row.appendChild(v); }
    row.addEventListener('mousedown', (e) => { e.stopPropagation(); setBrushMaskProp(sp.prop, !on); });
    list.appendChild(row);
  }
  panel.appendChild(list);
  const foot = document.createElement('div'); foot.className = 'bp-paint-foot';
  foot.append(miniTextBtn('All', () => setBrushMaskAll(true)), miniTextBtn('None', () => setBrushMaskAll(false)));
  const done = miniTextBtn('Done', closePaintPanel); done.classList.add('primary');
  foot.appendChild(done);
  panel.appendChild(foot);
  return back;
}

/** The library menu (Save cell): a "+ save the held style" row on top, then the saved-style list to
 *  load/delete. Saving keeps the menu open so the new preset appears below. */
function libraryPopup(): HTMLElement {
  const { back, panel } = popupShell('Saved styles');
  const held = bp.brush.held;

  const saveRow = document.createElement('div'); saveRow.className = 'bp-paint-saverow';
  if (held) {
    saveRow.appendChild(styleChip(held));
    const input = document.createElement('input'); input.className = 'bp-pick-s bp-paint-name'; input.placeholder = 'Name this style…'; input.maxLength = 40;
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent; e.stopPropagation();
      if (ke.key === 'Enter') { e.preventDefault(); doSavePreset(input.value); input.value = ''; }
    });
    const save = miniTextBtn('+ Save', () => { doSavePreset(input.value); input.value = ''; }); save.classList.add('primary');
    saveRow.append(input, save);
  } else {
    const hint = document.createElement('div'); hint.className = 'bp-paint-savehint';
    hint.textContent = 'Pick a widget’s style to save it.';
    saveRow.appendChild(hint);
  }
  panel.appendChild(saveRow);

  const list = document.createElement('div'); list.className = 'bp-paint-lib';
  if (bp.presets.length === 0) {
    const e = document.createElement('div'); e.className = 'bp-paint-empty'; e.textContent = 'No saved styles yet.';
    list.appendChild(e);
  } else {
    for (const p of bp.presets) list.appendChild(presetRow(p));
  }
  panel.appendChild(list);
  return back;
}

function presetRow(p: StylePreset): HTMLElement {
  const row = document.createElement('div'); row.className = 'bp-paint-lrow';
  const pick = document.createElement('button'); pick.className = 'bp-paint-lpick';
  pick.append(styleChip(p.style));
  const nm = document.createElement('span'); nm.className = 'bp-paint-lname'; nm.textContent = p.name;
  pick.appendChild(nm);
  pick.title = `Load "${p.name}" into the brush`;
  pick.addEventListener('mousedown', (e) => { e.stopPropagation(); doLoadPreset(p); });
  const del = document.createElement('button'); del.className = 'bp-paint-ldel'; setIcon(del, ICON_TRASH);
  del.title = `Delete "${p.name}"`;
  del.addEventListener('mousedown', (e) => { e.stopPropagation(); doDeletePreset(p.id); });
  row.append(pick, del);
  return row;
}

function miniTextBtn(text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-paint-btn'; b.textContent = text;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}

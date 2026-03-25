/**
 * BMP object preview on hover — shows type badge + name + RID
 * when hovering over patterns that reference BMP objects in EC code.
 *
 * Matched patterns:
 *   lookup(DIGITS)   — EC lookup() calls
 *   t.DIGITS / o.DIGITS — ID-space references
 *   rid=DIGITS / rid:DIGITS — RID references in output
 *
 * Lookups go through chrome.runtime.sendMessage (async, ~5ms cache hit).
 * Local tooltip cache avoids repeated SW round-trips for the same RID.
 */
import { hoverTooltip } from '@codemirror/view'

// Local cache: RID → identity (persists for editor window lifetime)
const tooltipCache = new Map<string, { name?: string; type?: string; businessId?: string } | null>();

const PATTERNS = [
  /\blookup\((\d{5,})\)/g,     // lookup(12345...)
  /\b[to]\.(\d{5,})\b/g,       // t.12345 or o.12345
  /\brid[=:](\d{5,})\b/gi,     // rid=12345 or rid:12345
];

async function lookupRid(rid: string): Promise<{ name?: string; type?: string; businessId?: string } | null> {
  // Check local cache first (instant)
  if (tooltipCache.has(rid)) return tooltipCache.get(rid)!;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'HOVER_LOOKUP', rid });
    if (response?.type === 'HOVER_LOOKUP_RESULT' && (response.name || response.type)) {
      const result = { name: response.name, type: response.type, businessId: response.businessId };
      tooltipCache.set(rid, result);
      return result;
    }
  } catch { /* extension context invalid or SW not responding */ }

  tooltipCache.set(rid, null); // cache negative results too (avoid re-fetching)
  return null;
}

function buildTooltipDom(info: { name?: string; type?: string; businessId?: string }, rid: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'padding:6px 10px; font-size:11px; line-height:1.5; max-width:280px; ' +
    'background:#262626; border:1px solid #393939; border-radius:2px; ' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.4); font-family:system-ui,sans-serif;';

  if (info.type) {
    const badge = document.createElement('span');
    badge.style.cssText =
      'display:inline-block; padding:1px 6px; margin-right:8px; font-size:10px; ' +
      'border-radius:3px; background:#2a2a4a; color:#a78bfa; font-weight:600;';
    badge.textContent = info.type;
    el.appendChild(badge);
  }

  if (info.name) {
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'color:#f4f4f4;';
    nameEl.textContent = info.name;
    el.appendChild(nameEl);
  }

  if (info.businessId) {
    const bidEl = document.createElement('div');
    bidEl.style.cssText = 'margin-top:3px; font-size:10px; color:#8d8d8d; font-family:"SF Mono","Cascadia Code",Consolas,monospace;';
    bidEl.textContent = `ID: ${info.businessId}`;
    el.appendChild(bidEl);
  }

  const ridEl = document.createElement('div');
  ridEl.style.cssText = 'font-size:10px; color:#6f6f6f; font-family:"SF Mono","Cascadia Code",Consolas,monospace;';
  ridEl.textContent = `RID: ${rid}`;
  el.appendChild(ridEl);

  return el;
}

export const bmpObjectHover = hoverTooltip(
  async (view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const offset = pos - line.from;

    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;

        const rid = match[1];
        const info = await lookupRid(rid);
        if (!info) continue;

        return {
          pos: line.from + start,
          end: line.from + end,
          above: true,
          create: () => ({ dom: buildTooltipDom(info, rid) }),
        };
      }
    }

    return null;
  },
  { hoverTime: 300, hideOnChange: true },
);

/**
 * BMP object preview on hover — shows type badge + name + RID
 * when hovering over BMP object references in EC code.
 *
 * Two lookup paths:
 *   lookup(RID), rid=DIGITS  → resolved via HOVER_LOOKUP (cache + lookupIdentity)
 *   t.122, ceiss.45, k.myProp → resolved via HOVER_RESOLVE (EC namespace.bid reference)
 *
 * Namespace prefixes validated against BMP's ID-space map.
 * Local tooltip cache avoids repeated SW round-trips.
 */
import { hoverTooltip } from '@codemirror/view'
import { isValidNamespace } from '../../lib/namespace'

interface HoverInfo { name?: string; type?: string; rid?: string; businessId?: string; codePreview?: string }

// Local cache: key → identity (persists for editor window lifetime)
const tooltipCache = new Map<string, HoverInfo | null>();

// Pattern definitions with lookup type
const PATTERNS: Array<{ re: RegExp; extract: (m: RegExpExecArray) => { key: string; lookup: 'rid' | 'ref' } | null }> = [
  {
    // lookup(DIGITS) — raw RID
    re: /\blookup\((\d{5,})\)/g,
    extract: (m) => ({ key: m[1], lookup: 'rid' }),
  },
  {
    // rid=DIGITS / rid:DIGITS — raw RID in output
    re: /\brid[=:](\d{5,})\b/gi,
    extract: (m) => ({ key: m[1], lookup: 'rid' }),
  },
  {
    // namespace.bid — validate prefix against known namespaces
    re: /\b([a-z]{1,5})\.(\w+)\b/g,
    extract: (m) => {
      const prefix = m[1];
      const bid = m[2];
      // Skip if not a known BMP namespace or if bid is purely numeric and short
      if (!isValidNamespace(prefix)) return null;
      // Skip common false positives: e.g., "e.g.", method chains like "s.name"
      if (bid.length < 2) return null;
      return { key: `${prefix}.${bid}`, lookup: 'ref' };
    },
  },
];

async function lookupRid(rid: string): Promise<HoverInfo | null> {
  if (tooltipCache.has(rid)) return tooltipCache.get(rid)!;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'HOVER_LOOKUP', rid });
    if (r?.type === 'HOVER_LOOKUP_RESULT' && (r.name || r.type)) {
      const info: HoverInfo = { name: r.name, type: r.type, rid, businessId: r.businessId, codePreview: r.codePreview };
      tooltipCache.set(rid, info);
      return info;
    }
  } catch { /* extension context invalid */ }
  tooltipCache.set(rid, null);
  return null;
}

async function resolveRef(ref: string): Promise<HoverInfo | null> {
  if (tooltipCache.has(ref)) return tooltipCache.get(ref)!;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'HOVER_RESOLVE', ref });
    if (r?.type === 'HOVER_RESOLVE_RESULT' && (r.name || r.type)) {
      const info: HoverInfo = { name: r.name, type: r.type, rid: r.rid, businessId: r.businessId, codePreview: r.codePreview };
      tooltipCache.set(ref, info);
      return info;
    }
  } catch { /* extension context invalid */ }
  tooltipCache.set(ref, null);
  return null;
}

function buildTooltipDom(info: HoverInfo): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'padding:6px 10px; font-size:11px; line-height:1.5; max-width:340px; ' +
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

  if (info.rid) {
    const ridEl = document.createElement('div');
    ridEl.style.cssText = 'font-size:10px; color:#6f6f6f; font-family:"SF Mono","Cascadia Code",Consolas,monospace;';
    ridEl.textContent = `RID: ${info.rid}`;
    el.appendChild(ridEl);
  }

  // Code preview section (for code-bearing types)
  if (info.codePreview) {
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #393939; margin:4px 0;';
    el.appendChild(sep);

    const codeEl = document.createElement('pre');
    codeEl.style.cssText =
      'margin:0; font:10px/1.4 "SF Mono","Cascadia Code",Consolas,monospace; ' +
      'color:#c6c6c6; max-height:48px; overflow:hidden; white-space:pre-wrap; word-break:break-word;';
    codeEl.textContent = info.codePreview;
    el.appendChild(codeEl);

    // "[Open EC ▸]" button
    if (info.rid) {
      const openBtn = document.createElement('div');
      openBtn.style.cssText = 'text-align:right; margin-top:3px;';
      const link = document.createElement('span');
      link.style.cssText = 'font-size:10px; color:#a78bfa; cursor:pointer;';
      link.textContent = 'Open EC \u25B8';
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', rid: info.rid });
      });
      openBtn.appendChild(link);
      el.appendChild(openBtn);
    }
  }

  return el;
}

export const bmpObjectHover = hoverTooltip(
  async (view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const text = line.text;
    const offset = pos - line.from;

    for (const { re, extract } of PATTERNS) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;

        const parsed = extract(match);
        if (!parsed) continue;

        const info = parsed.lookup === 'rid'
          ? await lookupRid(parsed.key)
          : await resolveRef(parsed.key);
        if (!info) continue;

        return {
          pos: line.from + start,
          end: line.from + end,
          above: true,
          create: () => ({ dom: buildTooltipDom(info) }),
        };
      }
    }

    return null;
  },
  { hoverTime: 300, hideOnChange: true },
);

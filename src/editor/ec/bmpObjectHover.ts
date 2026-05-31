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
 *
 * Visual cue: every BID-shaped token (t.foo / o.bar / k.baz / etc.) is
 * underlined via a Decoration so the user can see at a glance which
 * tokens are hoverable. Without it, the hover tooltip was discoverable
 * only by accident.
 */
import { hoverTooltip, ViewPlugin, Decoration, MatchDecorator, EditorView } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { isValidNamespace } from '../../lib/namespace'
import { sendFireForget, sendRequest } from '../../lib/messaging'

interface HoverInfo { name?: string; type?: string; rid?: string; businessId?: string; codePreview?: string }

/** Local cache: key → identity OR null (negative result).
 *
 *  Successful lookups are kept for the editor window lifetime — the
 *  underlying object identity doesn't change while the editor is
 *  open. Failed lookups are stamped with an absolute expiry AND a
 *  reason string so the fallback tooltip can tell the user exactly
 *  what happened ("no response from bridge", "BMP returned no
 *  identity for this RID", etc.) instead of a generic "couldn't
 *  resolve". A one-off bridge hiccup or "object missing right this
 *  second" doesn't permanently silence the hover tooltip — 10 s
 *  later the next hover re-queries fresh. */
type CacheEntry =
  | { info: HoverInfo }
  | { info: null; reason: string; expiresAt: number }
const tooltipCache = new Map<string, CacheEntry>();

/** Lifetime of a NEGATIVE cache entry (failed lookup). Short enough
 *  that a transient failure self-heals on the next hover; long enough
 *  that a known-missing ref doesn't burn an EC roundtrip on every
 *  cursor move. */
const NEGATIVE_TTL_MS = 10_000;

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
  {
    // {bid} brace-call — an EC shorthand that inlines the VALUE of
    // t.{bid}.expression (e.g. `{expr_wb_heartbeat}` runs the expression
    // stored on t.expr_wb_heartbeat). The namespace is always the
    // Template space, so we resolve `t.{bid}` and the tooltip previews the
    // referenced object's expression — the value this call evaluates to.
    // `[A-Za-z_]\w+` requires a 2+ char identifier, so `{}` / `{ x+y }` /
    // single-letter braces don't match. Unresolvable ids fall through to
    // the "couldn't resolve" tooltip just like a bad ns.bid ref.
    re: /\{([A-Za-z_]\w+)\}/g,
    extract: (m) => ({ key: `t.${m[1]}`, lookup: 'ref' }),
  },
];

/** Resolved lookup return. Either the identity OR an explanatory
 *  reason for the empty result. The hover tooltip's fallback branch
 *  uses the reason to tell the user what's actually wrong. */
type LookupResult =
  | { info: HoverInfo }
  | { info: null; reason: string };

/** Pull a cache entry, treating expired negative entries as absent. */
function getCached(key: string): LookupResult | undefined {
  const entry = tooltipCache.get(key);
  if (!entry) return undefined;
  if (entry.info === null) {
    if (Date.now() >= entry.expiresAt) {
      tooltipCache.delete(key);
      return undefined;
    }
    return { info: null, reason: entry.reason };
  }
  return { info: entry.info };
}

/** Negative cache write with reason. */
function cacheMiss(key: string, reason: string): void {
  tooltipCache.set(key, { info: null, reason, expiresAt: Date.now() + NEGATIVE_TTL_MS });
}

async function lookupRid(rid: string): Promise<LookupResult> {
  const cached = getCached(rid);
  if (cached) return cached;
  const r = await sendRequest({ type: 'HOVER_LOOKUP', rid });
  if (!r) {
    cacheMiss(rid, 'No response from the service worker (bridge probably disconnected).');
    return { info: null, reason: 'No response from the service worker (bridge probably disconnected).' };
  }
  if (r.type !== 'HOVER_LOOKUP_RESULT') {
    cacheMiss(rid, `Unexpected SW response (${r.type ?? 'no type'}).`);
    return { info: null, reason: `Unexpected SW response (${r.type ?? 'no type'}).` };
  }
  if (!r.name && !r.objectType) {
    cacheMiss(rid, `BMP returned no identity for RID ${rid}. The object may not exist.`);
    return { info: null, reason: `BMP returned no identity for RID ${rid}. The object may not exist.` };
  }
  const info: HoverInfo = { name: r.name, type: r.objectType, rid, businessId: r.businessId, codePreview: r.codePreview };
  tooltipCache.set(rid, { info });
  return { info };
}

async function resolveRef(ref: string): Promise<LookupResult> {
  const cached = getCached(ref);
  if (cached) return cached;
  const r = await sendRequest({ type: 'HOVER_RESOLVE', ref });
  if (!r) {
    cacheMiss(ref, 'No response from the service worker (bridge probably disconnected).');
    return { info: null, reason: 'No response from the service worker (bridge probably disconnected).' };
  }
  if (r.type !== 'HOVER_RESOLVE_RESULT') {
    cacheMiss(ref, `Unexpected SW response (${r.type ?? 'no type'}).`);
    return { info: null, reason: `Unexpected SW response (${r.type ?? 'no type'}).` };
  }
  if (!r.name && !r.objectType) {
    cacheMiss(ref, `BMP couldn't resolve "${ref}". The namespace or ID may not exist.`);
    return { info: null, reason: `BMP couldn't resolve "${ref}". The namespace or ID may not exist.` };
  }
  const info: HoverInfo = { name: r.name, type: r.objectType, rid: r.rid, businessId: r.businessId, codePreview: r.codePreview };
  tooltipCache.set(ref, { info });
  return { info };
}

function buildTooltipDom(info: HoverInfo): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hover-tooltip';

  if (info.type) {
    const badge = document.createElement('span');
    badge.className = 'hover-badge';
    badge.textContent = info.type;
    el.appendChild(badge);
  }

  if (info.name) {
    const nameEl = document.createElement('span');
    nameEl.className = 'hover-name';
    nameEl.textContent = info.name;
    el.appendChild(nameEl);
  }

  if (info.businessId) {
    const bidEl = document.createElement('div');
    bidEl.className = 'hover-meta';
    bidEl.textContent = `ID: ${info.businessId}`;
    el.appendChild(bidEl);
  }

  if (info.rid) {
    const ridEl = document.createElement('div');
    ridEl.className = 'hover-meta hover-meta--dim';
    ridEl.textContent = `RID: ${info.rid}`;
    el.appendChild(ridEl);
  }

  if (info.codePreview) {
    const sep = document.createElement('div');
    sep.className = 'hover-sep';
    el.appendChild(sep);

    const codeEl = document.createElement('pre');
    codeEl.className = 'hover-code';
    codeEl.textContent = info.codePreview;
    el.appendChild(codeEl);

    if (info.rid) {
      const openBtn = document.createElement('div');
      openBtn.className = 'hover-action';
      const link = document.createElement('span');
      link.className = 'hover-action-link';
      link.textContent = 'Open EC \u25B8';
      link.addEventListener('click', (e) => {
        e.stopPropagation();
        if (info.rid) sendFireForget({ type: 'OPEN_EDITOR', rid: info.rid });
      });
      openBtn.appendChild(link);
      el.appendChild(openBtn);
    }
  }

  return el;
}

// ── BID underline decorator ─────────────────────────────────────
//
// Same prefix.bid regex the hover uses, but as a MatchDecorator so
// every match gets a `.cm-bmp-bid` span. CSS gives it a subtle dotted
// underline that goes solid on hover — the "I am hoverable" cue.
// The match runs on the rendered viewport; large docs stay fast.
//
// No `title` attribute: a native browser tooltip would paint
// IMMEDIATELY on hover ("Hover to inspect t.foo") and HIDE the rich
// CodeMirror tooltip that arrives 300 ms later with the real
// identity. The underline alone is the affordance.
const bidMatcher = new MatchDecorator({
  // Two hoverable token shapes: `ns.bid` (validated namespace) and the
  // `{bid}` brace-call. Both get the dotted-underline "I am hoverable" cue.
  regexp: /\b([a-z]{1,5})\.(\w{2,})\b|\{([A-Za-z_]\w+)\}/g,
  decoration: (m) => {
    if (m[1] !== undefined) {
      // ns.bid form — only decorate known namespaces.
      return isValidNamespace(m[1]) ? Decoration.mark({ class: 'cm-bmp-bid' }) : null;
    }
    if (m[3] !== undefined) {
      // {bid} brace-call.
      return Decoration.mark({ class: 'cm-bmp-bid' });
    }
    return null;
  },
});

export const bmpBidDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = bidMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = bidMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Build the fallback tooltip shown when a recognised BID couldn't be
 *  resolved. Includes the specific reason returned by the lookup —
 *  "no response from bridge" / "BMP returned no identity" / etc. —
 *  so the user can act on it instead of just seeing a generic
 *  "couldn't resolve" message. */
function buildUnresolvedTooltipDom(token: string, reason: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'hover-tooltip hover-tooltip--unresolved';
  const head = document.createElement('div');
  head.className = 'hover-name';
  head.textContent = token;
  el.appendChild(head);
  const why = document.createElement('div');
  why.className = 'hover-meta hover-meta--dim';
  why.textContent = reason;
  el.appendChild(why);
  const ttl = document.createElement('div');
  ttl.className = 'hover-meta hover-meta--dim';
  ttl.textContent = 'Will retry in 10 s.';
  el.appendChild(ttl);
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

        const result = parsed.lookup === 'rid'
          ? await lookupRid(parsed.key)
          : await resolveRef(parsed.key);

        // ALWAYS return a tooltip when we recognised a BID-shaped
        // token — the rich tooltip when we have identity, an
        // explanatory fallback with the specific failure reason when
        // we don't. Returning null here used to make the user see
        // only the (since-removed) native title="Hover to inspect…"
        // and conclude the feature was broken.
        const tokenText = match[0];
        const dom = result.info
          ? buildTooltipDom(result.info)
          : buildUnresolvedTooltipDom(tokenText, result.reason);
        return {
          pos: line.from + start,
          end: line.from + end,
          above: true,
          create: () => ({ dom }),
        };
      }
    }

    return null;
  },
  { hoverTime: 300, hideOnChange: true },
);

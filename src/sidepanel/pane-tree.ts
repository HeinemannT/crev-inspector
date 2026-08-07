/**
 * Object-pane local-neighborhood tree.
 * Renders parent breadcrumb + sibling list (current highlighted), with the
 * current row showing its expanded children (lazy via FETCH_CHILDREN).
 *
 * Callbacks fire on row click → caller swaps the pane to that RID.
 */

import { h, svg, statusFlash } from '../lib/dom';
import { ICON_CHEVRON, ICON_ARROW_ELBOW_UP, ICON_FLOW_ARROW } from '../lib/icons';
import { typeBadge, wireBadgeCopy } from '../lib/type-badge';
import type { ObjectPaneIdentity, ObjectPaneSiblingMsg } from '../lib/types';
import { hasFlow } from '../lib/widget-metadata';
import { getModifier, resolveCopyText, COPY_TOOLTIP } from '../lib/namespace';
import { resolveDisplayIdentity } from '../lib/object-identity';

export interface PaneTreeData {
  parent: ObjectPaneIdentity | null;
  current: ObjectPaneIdentity;
  siblings: ObjectPaneSiblingMsg[];
  /** True child count under the parent; `siblings` may be a capped slice.
   *  When it exceeds siblings.length the navigator shows a "showing N of M"
   *  note instead of silently hiding the rest. */
  siblingTotal?: number;
  /** Children of the current object, populated lazily after expand. */
  children?: Array<{ rid: string; businessId?: string; name?: string; type?: string }>;
  /** True while a FETCH_CHILDREN is in flight. */
  loadingChildren?: boolean;
  /** Fetch failure. Kept separate from an empty list so "no children" stays
   * truthful and a transient connection failure can be retried. */
  childrenError?: string | null;
  /** True when the user has expanded the current row at least once. */
  childrenExpanded?: boolean;
}

export interface PaneTreeHandlers {
  onNavigate: (rid: string) => void;
  onToggleChildren: () => void;
  onRetryChildren: () => void;
}


/** Stub badge with the panel-wide template-first copy gesture. Shift retains
 *  the concrete instance path and Alt retains the raw RID. */
function copyBadge(identity: {
  rid: string;
  businessId?: string;
  templateBusinessId?: string;
  type?: string;
}): HTMLElement {
  const badge = wireBadgeCopy(typeBadge(identity.type, { size: 'xs' }), (event) => {
    const modifier = event instanceof MouseEvent ? getModifier(event) : 'plain';
    return resolveCopyText(identity, modifier).text;
  }, {
    onCopied: copied => statusFlash(`Copied ${copied} \u2713`),
  });
  badge.title = COPY_TOOLTIP;
  return badge;
}

export function renderPaneTree(data: PaneTreeData, handlers: PaneTreeHandlers): HTMLElement {
  const root = h('div', { class: 'pane-tree' });

  // Breadcrumb of the parent — clickable, escapes to parent's pane
  if (data.parent) {
    const parentDisplay = resolveDisplayIdentity(data.parent);
    root.appendChild(
      h('div', { class: 'pane-tree-crumb', 'data-rid': data.parent.rid, role: 'button', tabindex: '0',
        title: `Open parent: ${data.parent.name || parentDisplay.primary}` },
        h('span', { class: 'pane-tree-crumb-arrow' }, svg(ICON_ARROW_ELBOW_UP)),
        copyBadge(data.parent),
        h('span', { class: 'pane-tree-name' }, data.parent.name || '(unnamed)'),
        parentDisplay.primary ? h('span', {
          class: 'pane-tree-bid',
          title: parentDisplay.secondary ? `Instance ID: ${parentDisplay.secondary}` : parentDisplay.primary,
        }, parentDisplay.primary) : null,
      ),
    );
  } else {
    root.appendChild(
      h('div', { class: 'pane-tree-crumb pane-tree-crumb--root' },
        h('span', { class: 'pane-tree-crumb-arrow' }, svg(ICON_ARROW_ELBOW_UP)),
        h('span', { class: 'pane-tree-meta' }, '(top level)'),
      ),
    );
  }

  // Sibling rows under the parent
  const siblingList = h('div', { class: 'pane-tree-siblings', role: 'list' });
  const siblings = data.siblings.length > 0
    ? data.siblings
    : [{ rid: data.current.rid, businessId: data.current.businessId, name: data.current.name, type: data.current.type, isCurrent: true }];

  for (const s of siblings) {
    const isCurrent = s.isCurrent || s.rid === data.current.rid;
    const identity = isCurrent
      ? { ...s, templateBusinessId: data.current.templateBusinessId }
      : s;
    const display = resolveDisplayIdentity(identity);
    const row = h('div', {
      class: `pane-tree-row${isCurrent ? ' pane-tree-row--current' : ''}`,
      'data-rid': s.rid,
      role: 'listitem',
      tabindex: '0',
      title: [
        s.type,
        `${display.primaryLabel}: ${display.primary}`,
        display.secondary ? `Instance ID: ${display.secondary}` : '',
      ].filter(Boolean).join(' · '),
    },
      copyBadge(identity),
      h('span', { class: 'pane-tree-name' }, s.name || '(unnamed)'),
      display.primary ? h('span', {
        class: 'pane-tree-bid',
        title: display.secondary ? `Instance ID: ${display.secondary}` : display.primary,
      }, display.primary) : null,
    );
    siblingList.appendChild(row);

    // Children appear right under the current row when expanded.
    // Flow-bearing types (InputView, ActionButton, CreateObjectView, …) have
    // a FLOW, not children — their chain lives in the Flow segment, so the
    // expander is replaced by a quiet pointer there.
    if (isCurrent && hasFlow(data.current.type)) {
      siblingList.appendChild(h('div', { class: 'pane-tree-flownote' }, svg(ICON_FLOW_ARROW), ' flow: see the Flow tab'));
    } else if (isCurrent) {
      const expander = h('button', {
        class: `pane-tree-expander${data.childrenExpanded ? ' pane-tree-expander--open' : ''}`,
        'aria-expanded': data.childrenExpanded ? 'true' : 'false',
        title: data.childrenExpanded ? 'Hide children' : 'Show children',
      }, h('span', { class: 'pane-tree-caret' }, svg(ICON_CHEVRON)),
         h('span', null, data.childrenExpanded ? 'Hide children' : 'Show children'));
      expander.addEventListener('click', (e) => { e.stopPropagation(); handlers.onToggleChildren(); });
      siblingList.appendChild(h('div', { class: 'pane-tree-expander-wrap' }, expander));

      if (data.childrenExpanded) {
        if (data.loadingChildren) {
          siblingList.appendChild(h('div', { class: 'pane-tree-children-loading' }, 'Loading children…'));
        } else if (data.childrenError) {
          siblingList.appendChild(h('div', { class: 'pane-error' },
            h('div', {}, data.childrenError),
            h('button', {
              class: 'btn btn-small',
              onClick: (e: MouseEvent) => {
                e.stopPropagation();
                handlers.onRetryChildren();
              },
            }, 'Retry'),
          ));
        } else if (data.children && data.children.length > 0) {
          const childList = h('div', { class: 'pane-tree-children' });
          for (const c of data.children) {
            const display = resolveDisplayIdentity(c);
            const cRow = h('div', {
              class: 'pane-tree-row pane-tree-row--child',
              'data-rid': c.rid,
              role: 'listitem',
              tabindex: '0',
              title: `${c.type ?? ''} · ${display.primary}`,
            },
              copyBadge(c),
              h('span', { class: 'pane-tree-name' }, c.name || '(unnamed)'),
              display.primary ? h('span', { class: 'pane-tree-bid' }, display.primary) : null,
            );
            childList.appendChild(cRow);
          }
          siblingList.appendChild(childList);
        } else {
          siblingList.appendChild(h('div', { class: 'pane-tree-children-empty' }, 'No children'));
        }
      }
    }
  }

  // Truncation note — the sibling list is capped server-side (SIBLING_CAP).
  // Show the real total so a parent with many children doesn't look like it
  // only has 25, rather than silently hiding the rest.
  const shown = data.siblings.length;
  const total = data.siblingTotal ?? shown;
  if (total > shown) {
    siblingList.appendChild(
      h('div', { class: 'pane-tree-siblings-more', role: 'note' },
        `showing first ${shown} of ${total}`),
    );
  }

  root.appendChild(siblingList);

  // Event delegation — anything with data-rid that isn't the current row triggers navigation
  root.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-rid]');
    if (!el) return;
    if (el.classList.contains('pane-tree-row--current')) return; // already here
    const rid = el.dataset.rid;
    if (rid) handlers.onNavigate(rid);
  });
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-rid]');
    if (!el) return;
    if (el.classList.contains('pane-tree-row--current')) return;
    const rid = el.dataset.rid;
    if (rid) { e.preventDefault(); handlers.onNavigate(rid); }
  });

  return root;
}

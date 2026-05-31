/**
 * Shared empty-state component.
 *
 * Centralised pattern for the "nothing to show yet" / "search returned
 * no matches" / "click a thing to populate this pane" copy. Two
 * variants:
 *
 *   - `hero`    centered title + body + optional hint, padded to fill
 *               its container. Use for surfaces the user lands on
 *               (Browse first-load, Code Search first-load, Workshop
 *               detail half before any object loads).
 *   - `inline`  small one-or-two-line copy embedded in a flow.
 *
 * Both render under `.crev-empty-state` with a `--hero` / `--inline`
 * modifier; CSS lives in src/sidepanel/sidepanel.css (loaded by both
 * the side panel and the codesearch frame, which inherits the same
 * design tokens).
 */
import { h } from './dom';

export interface EmptyStateOpts {
  variant?: 'hero' | 'inline';
  /** Headline. Only rendered for `hero`. */
  title?: string;
  /** Main copy. Accepts a string or pre-built node array (for inline
   *  emphasis / spans / line-breaks). */
  body: string | Array<string | HTMLElement>;
  /** Italicised secondary line under the body. Only rendered for `hero`. */
  hint?: string;
}

export function emptyState(opts: EmptyStateOpts): HTMLElement {
  const variant = opts.variant ?? 'inline';
  const klass = `crev-empty-state crev-empty-state--${variant}`;
  const bodyChildren = Array.isArray(opts.body) ? opts.body : [opts.body];

  if (variant === 'hero') {
    const children: HTMLElement[] = [];
    if (opts.title) {
      children.push(h('div', { class: 'crev-empty-state-title' }, opts.title));
    }
    children.push(h('div', { class: 'crev-empty-state-body' }, ...bodyChildren));
    if (opts.hint) {
      children.push(h('div', { class: 'crev-empty-state-hint' }, opts.hint));
    }
    return h('div', { class: klass }, ...children);
  }

  // inline
  return h('div', { class: klass }, ...bodyChildren);
}

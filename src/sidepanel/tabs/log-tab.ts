/**
 * Log tab — activity feed. Self-contained component with own state.
 */

import type { InspectorMessage, ActivityEntry } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { ICON_CHEVRON } from '../../lib/icons';
import { relativeTime } from '../utils';
import { ACTIVITY_MAX, ACTIVITY_DISPLAY_TIMEOUT } from '../../lib/constants';
import { S } from '../state';
import type { Tab, SendFn } from './tab-types';

type ProfileFilter = 'this' | 'all';
type EventFilter = 'activity' | 'problems' | 'all';

export class LogTab implements Tab {
  private entries: ActivityEntry[] = [];
  private latestMsg: string | null = null;
  private latestTimer: ReturnType<typeof setTimeout> | null = null;
  private send: SendFn;
  private onStatusChange: (() => void) | null = null;
  /** Show only entries from the active profile by default. With sbx/dev/prod
   *  configured this keeps the log readable; otherwise an EC executed on dev
   *  would scroll past entries from sbx. */
  private profileFilter: ProfileFilter = 'this';
  /** User actions are the useful default. Diagnostics remain available without
   *  letting detection/enrichment chatter bury saves and executions. */
  private eventFilter: EventFilter = 'activity';
  /** Entries whose detail (e.g. the applied EC) is expanded inline, keyed by entry time. */
  private expanded = new Set<number>();

  /** Latest activity message (read by status bar in sidepanel) */
  get latestActivityMsg() { return this.latestMsg; }

  constructor(send: SendFn) {
    this.send = send;
  }

  /** Register callback for when activity status changes (message arrives or 3s timeout clears it) */
  onActivityChange(cb: () => void) { this.onStatusChange = cb; }

  activate() {
    this.send({ type: 'GET_ACTIVITY' });
  }

  deactivate() {
    // no cleanup needed
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'ACTIVITY_LOG':
        this.entries = msg.entries;
        return true;
      case 'ACTIVITY_ENTRY':
        this.entries.push(msg.entry);
        if (this.entries.length > ACTIVITY_MAX) this.entries.shift();
        // Diagnostic outcomes should reveal the server response immediately. Routine successes stay
        // compact, but warnings/errors open so the user sees BMP's execution log without another click.
        if (msg.entry.detail && (msg.entry.level === 'warn' || msg.entry.level === 'error')) {
          this.expanded.add(msg.entry.time);
        }
        this.latestMsg = msg.entry.message;
        if (this.latestTimer) clearTimeout(this.latestTimer);
        this.latestTimer = setTimeout(() => {
          this.latestMsg = null;
          this.onStatusChange?.();
        }, ACTIVITY_DISPLAY_TIMEOUT);
        return true;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    // Filter by profile first. Legacy entries without `profileId` are shown
    // in both modes — they predate the tagging and the user shouldn't lose
    // visibility into them just by upgrading.
    const activeId = S.settings.activeProfileId;
    const profileCount = S.settings.profiles.length;
    const profileVisible = (this.profileFilter === 'all' || profileCount <= 1)
      ? this.entries
      : this.entries.filter(e => !e.profileId || e.profileId === activeId);
    const visible = profileVisible.filter(entry => {
      if (this.eventFilter === 'all') return true;
      if (this.eventFilter === 'problems') return entry.level === 'warn' || entry.level === 'error';
      return (entry.category != null && entry.category !== 'system') || entry.level === 'error';
    });

    // Collapse runs of identical consecutive messages into a count badge so
    // the feed reads as a feed (not a tail -f). E.g. 14× "Enriching 4 from
    // server…" becomes one row with "×14" instead of fourteen rows.
    const recent = visible.slice(-50);
    const collapsed: Array<{ entry: typeof recent[number]; count: number }> = [];
    for (const e of recent) {
      const last = collapsed[collapsed.length - 1];
      if (last && last.entry.level === e.level && last.entry.message === e.message) {
        last.count++;
        last.entry = e; // keep the latest timestamp
      } else {
        collapsed.push({ entry: e, count: 1 });
      }
    }

    const eventButton = (value: EventFilter, label: string) => h('button', {
      class: `log-filter-chip ${this.eventFilter === value ? 'log-filter-chip--active' : ''}`,
      'data-event-filter': value,
      'aria-pressed': String(this.eventFilter === value),
    }, label);
    const filterRow = h('div', { class: 'log-filter-row' },
      eventButton('activity', 'Activity'),
      eventButton('problems', 'Problems'),
      eventButton('all', 'All'),
      profileCount > 1
        ? h('span', { class: 'log-profile-filters' },
            h('button', {
              class: `log-filter-chip ${this.profileFilter === 'this' ? 'log-filter-chip--active' : ''}`,
              'data-profile-filter': 'this',
              'aria-pressed': String(this.profileFilter === 'this'),
              title: 'Only this profile',
            }, 'This profile'),
            h('button', {
              class: `log-filter-chip ${this.profileFilter === 'all' ? 'log-filter-chip--active' : ''}`,
              'data-profile-filter': 'all',
              'aria-pressed': String(this.profileFilter === 'all'),
              title: 'Every configured profile',
            }, 'All profiles'),
          )
        : null,
    );

    const feed = h('div', { class: 'activity-feed', id: 'activity-feed' },
      collapsed.length === 0
        ? h('div', { class: 'activity-empty' },
            h('span', null, 'No activity yet.'),
            h('br'),
            h('span', { class: 'activity-empty-hint' },
              this.eventFilter === 'activity'
                ? 'Saves, EC runs, Blueprint applies, paint, and Studio changes appear here. System events remain under All.'
                : 'No matching log entries.'),
          )
        // Newest-first: collapse runs in chronological order (so adjacent
        // dupes merge), then reverse for display so the latest entry is on top.
        : collapsed.slice().reverse().map(({ entry, count }) => {
            // Entries with a detail (the applied EC, the timing breakdown) expand inline on
            // click — the EC that ran is worth reading and copying, not just a hover title.
            const hasDetail = !!entry.detail;
            const isOpen = hasDetail && this.expanded.has(entry.time);
            return h('div', {
              class: `activity-entry activity-entry--${entry.level}${hasDetail ? ' activity-entry--expandable' : ''}`,
              ...(hasDetail
                ? { 'data-detail-key': String(entry.time), role: 'button', tabindex: '0', 'aria-expanded': String(isOpen), title: entry.message }
                : { title: entry.message }),
            },
              // Level stripe gives a quick scan of severity without reading.
              h('span', { class: 'activity-stripe', 'aria-hidden': 'true' }),
              h('span', { class: 'activity-msg' },
                hasDetail
                  ? h('span', { class: `activity-caret${isOpen ? ' activity-caret--open' : ''}`, 'aria-hidden': 'true' }, svg(ICON_CHEVRON))
                  : null,
                h('span', { class: 'activity-msg-text' }, entry.message)),
              count > 1 ? h('span', { class: 'activity-count', title: `Repeated ${count} times` }, `×${count}`) : null,
              h('span', { class: 'activity-time' }, relativeTime(entry.time)),
              isOpen ? h('pre', { class: 'activity-detail' }, entry.detail) : null,
            );
          }),
    );

    const root = h('div', { class: 'log-tab' }, filterRow, feed);
    render(container, root);

    // One compact filter bar: action relevance first, optional profile scope second.
    filterRow.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const eventTarget = target.closest('[data-event-filter]') as HTMLElement | null;
      const profileTarget = target.closest('[data-profile-filter]') as HTMLElement | null;
      if (eventTarget) {
        const next = eventTarget.getAttribute('data-event-filter') as EventFilter | null;
        if (next && next !== this.eventFilter) {
          this.eventFilter = next;
          this.render(container);
        }
      } else if (profileTarget) {
        const next = profileTarget.getAttribute('data-profile-filter') as ProfileFilter | null;
        if (next && next !== this.profileFilter) {
          this.profileFilter = next;
          this.render(container);
        }
      }
    });

    // Expand/collapse an entry's detail (click or Enter/Space on the row).
    const toggleDetail = (el: HTMLElement | null) => {
      const key = el && Number(el.getAttribute('data-detail-key'));
      if (!key) return;
      if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
      this.render(container);
    };
    feed.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest('.activity-detail')) return; // let text selection / copy work inside the detail
      toggleDetail(t.closest('[data-detail-key]') as HTMLElement | null);
    });
    feed.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const el = (ev.target as HTMLElement).closest('[data-detail-key]') as HTMLElement | null;
      if (!el) return;
      ev.preventDefault();
      toggleDetail(el);
    });
    // Newest is on top now, so park the scroll there.
    feed.scrollTop = 0;
  }

}

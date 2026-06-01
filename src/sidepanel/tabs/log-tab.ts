/**
 * Log tab — activity feed. Self-contained component with own state.
 */

import type { InspectorMessage, ActivityEntry } from '../../lib/types';
import { h, render } from '../../lib/dom';
import { relativeTime } from '../utils';
import { ACTIVITY_MAX, ACTIVITY_DISPLAY_TIMEOUT } from '../../lib/constants';
import { S } from '../state';
import type { Tab, SendFn } from './tab-types';

type LogFilter = 'this' | 'all';

export class LogTab implements Tab {
  private entries: ActivityEntry[] = [];
  private latestMsg: string | null = null;
  private latestTimer: ReturnType<typeof setTimeout> | null = null;
  private send: SendFn;
  private onStatusChange: (() => void) | null = null;
  /** Show only entries from the active profile by default. With sbx/dev/prod
   *  configured this keeps the log readable; otherwise an EC executed on dev
   *  would scroll past entries from sbx. */
  private filter: LogFilter = 'this';

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
    const visible = (this.filter === 'all' || profileCount <= 1)
      ? this.entries
      : this.entries.filter(e => !e.profileId || e.profileId === activeId);

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

    // Filter toggle — only worth rendering when the user has more than one
    // profile, since otherwise "this" and "all" are the same set.
    const filterRow = profileCount > 1
      ? h('div', { class: 'log-filter-row' },
          h('button', {
            class: `log-filter-chip ${this.filter === 'this' ? 'log-filter-chip--active' : ''}`,
            'data-filter': 'this',
            title: 'Only this profile',
          }, 'This profile'),
          h('button', {
            class: `log-filter-chip ${this.filter === 'all' ? 'log-filter-chip--active' : ''}`,
            'data-filter': 'all',
            title: 'All profiles',
          }, 'All'),
        )
      : null;

    const feed = h('div', { class: 'activity-feed', id: 'activity-feed' },
      collapsed.length === 0
        ? h('div', { class: 'activity-empty' },
            h('span', null, 'No activity yet.'),
            h('br'),
            h('span', { class: 'activity-empty-hint' },
              'Edits, saves, EC runs, paint, pins, and context changes are logged here.'),
          )
        // Newest-first: collapse runs in chronological order (so adjacent
        // dupes merge), then reverse for display so the latest entry is on top.
        : collapsed.slice().reverse().map(({ entry, count }) =>
            h('div', {
              class: `activity-entry activity-entry--${entry.level}`,
              title: entry.detail ? `${entry.message}\n\n${entry.detail}` : entry.message,
            },
              // Level stripe gives a quick scan of severity without reading.
              h('span', { class: 'activity-stripe', 'aria-hidden': 'true' }),
              h('span', { class: 'activity-msg' }, entry.message),
              count > 1 ? h('span', { class: 'activity-count', title: `Repeated ${count} times` }, `×${count}`) : null,
              h('span', { class: 'activity-time' }, relativeTime(entry.time)),
            )
          ),
    );

    const root = h('div', { class: 'log-tab' }, filterRow, feed);
    render(container, root);

    // Click delegation on filter chips — simple enough that a global
    // delegate isn't worth the indirection.
    if (filterRow) {
      filterRow.addEventListener('click', (ev) => {
        const target = (ev.target as HTMLElement).closest('[data-filter]') as HTMLElement | null;
        if (!target) return;
        const next = target.getAttribute('data-filter') as LogFilter | null;
        if (!next || next === this.filter) return;
        this.filter = next;
        this.render(container);
      });
    }
    // Newest is on top now, so park the scroll there.
    feed.scrollTop = 0;
  }

}

/**
 * Log tab — activity feed. Self-contained component with own state.
 */

import type { InspectorMessage, ActivityEntry } from '../../lib/types';
import { h, render } from '../../lib/dom';
import { relativeTime } from '../utils';
import { ACTIVITY_MAX } from '../../lib/constants';
import type { Tab, SendFn } from './tab-types';

export class LogTab implements Tab {
  private entries: ActivityEntry[] = [];
  private latestMsg: string | null = null;
  private latestTimer: ReturnType<typeof setTimeout> | null = null;
  private send: SendFn;

  /** Latest activity message (read by status bar in sidepanel) */
  get latestActivityMsg() { return this.latestMsg; }

  constructor(send: SendFn) {
    this.send = send;
  }

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
        this.latestTimer = setTimeout(() => { this.latestMsg = null; }, 3000);
        return true;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const entries = this.entries.slice(-30);

    const feed = h('div', { class: 'activity-feed', id: 'activity-feed' },
      entries.length === 0
        ? h('div', { class: 'activity-empty' }, 'No activity yet')
        : entries.map(entry =>
            h('div', { class: `activity-entry ${entry.level}` },
              h('span', { class: 'activity-msg' }, entry.message),
              h('span', { class: 'activity-time' }, relativeTime(entry.time)),
            )
          ),
    );

    render(container, feed);
    feed.scrollTop = feed.scrollHeight;
  }

  /** Incremental feed update (appends without full re-render) */
  renderFeed() {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    const entries = this.entries.slice(-30);
    if (entries.length === 0) {
      render(feed, h('div', { class: 'activity-empty' }, 'No activity yet'));
      return;
    }

    render(feed, ...entries.map(entry =>
      h('div', { class: `activity-entry ${entry.level}` },
        h('span', { class: 'activity-msg' }, entry.message),
        h('span', { class: 'activity-time' }, relativeTime(entry.time)),
      )
    ));

    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }
}

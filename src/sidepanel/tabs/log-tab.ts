import { relativeTime } from '../utils';
import { h, render } from '../../lib/dom';
import { S } from '../state';

export function renderActivityFeed() {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;

  const entries = S.activityEntries.slice(-30);
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

export function renderLogTab() {
  const panel = document.getElementById('panel-log');
  if (!panel) return;

  const entries = S.activityEntries.slice(-30);

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

  render(panel, feed);
  feed.scrollTop = feed.scrollHeight;
}

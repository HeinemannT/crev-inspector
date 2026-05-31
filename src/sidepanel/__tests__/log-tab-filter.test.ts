/**
 * @vitest-environment happy-dom
 *
 * Log tab profile filter (v0.20.2): with sbx/dev/prod configured, the
 * Log tab defaults to "this profile" so activity from the active env
 * is readable without sbx + dev + prod mingled together. The toggle
 * lets the user switch to "all".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LogTab } from '../tabs/log-tab';
import { S } from '../state';
import type { InspectorMessage, ActivityEntry } from '../../lib/types';
import { DEFAULT_SETTINGS } from '../../lib/types';

function pushEntries(tab: LogTab, entries: ActivityEntry[]) {
  const msg: InspectorMessage = { type: 'ACTIVITY_LOG', entries };
  tab.handleMessage(msg);
}

function entries(): ActivityEntry[] {
  return [
    { id: 1, time: 1000, level: 'info', message: 'sbx-1', profileId: 'sbx' },
    { id: 2, time: 2000, level: 'info', message: 'dev-1', profileId: 'dev' },
    { id: 3, time: 3000, level: 'info', message: 'prod-1', profileId: 'prod' },
    { id: 4, time: 4000, level: 'info', message: 'legacy-no-tag' }, // no profileId
    { id: 5, time: 5000, level: 'info', message: 'sbx-2', profileId: 'sbx' },
  ];
}

function configureProfiles(active: string, ids: string[] = ['sbx', 'dev', 'prod']) {
  S.settings = {
    ...DEFAULT_SETTINGS,
    profiles: ids.map(id => ({ id, label: id, bmpUrl: `https://${id}.x.de/`, bmpUser: 'u', bmpPass: 'p' })),
    activeProfileId: active,
  };
}

function renderedMessages(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.activity-msg')).map(el => el.textContent ?? '');
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('LogTab — profile filter', () => {
  it('defaults to active-profile-only when multiple profiles exist', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = document.createElement('div');
    tab.render(container);

    const shown = renderedMessages(container);
    expect(shown).toContain('sbx-1');
    expect(shown).toContain('sbx-2');
    expect(shown).toContain('legacy-no-tag'); // untagged entries stay visible
    expect(shown).not.toContain('dev-1');
    expect(shown).not.toContain('prod-1');
  });

  it('switching to "All" reveals every entry', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = document.createElement('div');
    tab.render(container);

    // Click the "All" chip (the filter row is the first child).
    const allChip = container.querySelector('[data-filter="all"]') as HTMLElement;
    expect(allChip).toBeTruthy();
    allChip.click();

    const shown = renderedMessages(container);
    expect(shown).toContain('sbx-1');
    expect(shown).toContain('dev-1');
    expect(shown).toContain('prod-1');
    expect(shown).toContain('legacy-no-tag');
  });

  it('clicking "This profile" filters back to active', () => {
    configureProfiles('dev');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = document.createElement('div');
    tab.render(container);

    // Start on "all", then click back.
    (container.querySelector('[data-filter="all"]') as HTMLElement).click();
    (container.querySelector('[data-filter="this"]') as HTMLElement).click();

    const shown = renderedMessages(container);
    expect(shown).toContain('dev-1');
    expect(shown).toContain('legacy-no-tag');
    expect(shown).not.toContain('sbx-1');
    expect(shown).not.toContain('prod-1');
  });

  it('hides the filter row when only one profile is configured', () => {
    configureProfiles('sbx', ['sbx']);
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = document.createElement('div');
    tab.render(container);

    // No filter row at all — there's nothing to filter on.
    expect(container.querySelector('.log-filter-row')).toBeNull();
    // Without the filter, all entries are shown.
    const shown = renderedMessages(container);
    expect(shown.length).toBe(5);
  });

  it('toggling active profile changes which entries are visible on re-render', () => {
    configureProfiles('sbx');
    const tab = new LogTab(vi.fn());
    pushEntries(tab, entries());
    const container = document.createElement('div');
    tab.render(container);
    expect(renderedMessages(container)).toContain('sbx-1');

    // User switches to dev — re-render reflects the new active.
    S.settings = { ...S.settings, activeProfileId: 'dev' };
    tab.render(container);
    const shown = renderedMessages(container);
    expect(shown).toContain('dev-1');
    expect(shown).not.toContain('sbx-1');
  });
});

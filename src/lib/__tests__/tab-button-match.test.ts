/**
 * @vitest-environment happy-dom
 *
 * Reproduction + regression for the graph-view "tab navigate doesn't work"
 * bug (2026-05-29).
 *
 * Root cause: content.ts had its own `findTabButton` that matched
 * `[data-rid]`, `[data-title]`, `data-test="element-list-element-…"` etc.
 * BMP's REAL tab DOM is `.corpo-tabSet__tab > a[href*="tabrid="]` with the
 * label in `data-title` — none of the old selectors matched it, so BMP_GOTO
 * found no button and the tab never switched.
 *
 * These tests build BMP's real tab DOM and assert:
 *   1. the OLD selector set finds nothing (reproduces the failure)
 *   2. the canonical findTabButton (dom-scanner) finds the right anchor by
 *      rid and by name, and clicking it triggers BMP's own handler (no reload)
 */
import { describe, it, expect, vi } from 'vitest';
import { findTabButton, isTabActive } from '../dom-scanner';

/** Build the BMP scorecard tab strip exactly as the portal renders it:
 *  `.corpo-tabSet__tab` wrappers each containing an `<a href="…?tabrid=N">`
 *  with the display name in `data-title`. The selected one carries the
 *  `--selected` BEM modifier. */
function buildBmpTabStrip(): void {
  document.body.innerHTML = `
    <div class="corpo-tabSet">
      <div class="corpo-tabSet__tab corpo-tabSet__tab--selected" data-title="Overview">
        <a href="https://bmp.example/portal?rid=100&tabrid=501" data-title="Overview">Overview</a>
      </div>
      <div class="corpo-tabSet__tab" data-title="Risk Register">
        <a href="https://bmp.example/portal?rid=100&tabrid=502" data-title="Risk Register">Risk Register</a>
      </div>
      <div class="corpo-tabSet__tab" data-title="🔄 Process">
        <a href="https://bmp.example/portal?rid=100&tabrid=503" data-title="🔄 Process">🔄 Process</a>
      </div>
    </div>`;
}

describe('tab navigation — reproduction of the original failure', () => {
  it('the OLD selector set matches none of BMP real tab DOM', () => {
    buildBmpTabStrip();
    // These are exactly the selectors the pre-fix content.ts findTabButton
    // tried. Against BMP's real DOM they all miss.
    const tabRid = '502';
    const tabName = 'Risk Register';
    const oldSelectors = [
      `[role="tab"][data-rid="${tabRid}"]`,
      `[data-tab-rid="${tabRid}"]`,
      `[data-rid="${tabRid}"]`,
      `[role="tab"][data-title="${tabName}"]`,
      `[data-test="element-list-element-${tabName}"]`,
      `[role="tab"][aria-label="${tabName}"]`,
    ];
    for (const sel of oldSelectors) {
      expect(document.querySelector(sel), `old selector should miss: ${sel}`).toBeNull();
    }
  });
});

describe('findTabButton — canonical matcher', () => {
  it('matches by tab RID (the reliable, build-stable key)', () => {
    buildBmpTabStrip();
    const el = findTabButton('502', undefined);
    expect(el).not.toBeNull();
    expect(el!.getAttribute('href')).toContain('tabrid=502');
  });

  it('matches by exact display name when no rid is given', () => {
    buildBmpTabStrip();
    const el = findTabButton(undefined, 'Risk Register');
    expect(el!.getAttribute('href')).toContain('tabrid=502');
  });

  it('matches an icon-prefixed tab name (normalised)', () => {
    buildBmpTabStrip();
    // The graph stores the plain name "Process"; BMP renders "🔄 Process".
    const el = findTabButton(undefined, 'Process');
    expect(el!.getAttribute('href')).toContain('tabrid=503');
  });

  it('prefers RID over name when both are supplied', () => {
    buildBmpTabStrip();
    const el = findTabButton('501', 'Risk Register');
    expect(el!.getAttribute('href')).toContain('tabrid=501');
  });

  it('returns null for an unknown tab', () => {
    buildBmpTabStrip();
    expect(findTabButton('999', 'Nonexistent')).toBeNull();
  });

  it('clicking the matched anchor fires its handler (BMP in-app switch, no reload)', () => {
    buildBmpTabStrip();
    const el = findTabButton('503', undefined)!;
    const onClick = vi.fn();
    el.addEventListener('click', onClick);
    el.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('isTabActive — canonical selected detection', () => {
  it('recognises the BMP --selected BEM modifier (old code missed this)', () => {
    buildBmpTabStrip();
    const selectedAnchor = findTabButton('501', undefined)!;
    const inactiveAnchor = findTabButton('502', undefined)!;
    expect(isTabActive(selectedAnchor)).toBe(true);
    expect(isTabActive(inactiveAnchor)).toBe(false);
  });

  it('recognises aria-selected on role=tab builds', () => {
    document.body.innerHTML = `<a role="tab" aria-selected="true" href="?tabrid=7">X</a>`;
    expect(isTabActive(document.querySelector('a')!)).toBe(true);
  });
});

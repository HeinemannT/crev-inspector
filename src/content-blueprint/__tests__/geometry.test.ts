// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { ridElementMap } from '../geometry';

afterEach(() => { document.body.innerHTML = ''; });

describe('ridElementMap — tab anchors excluded', () => {
  it('keeps widget elements but drops tab-strip anchors (they sit above the content and would drag the canvas over BMP tabs)', () => {
    document.body.innerHTML = `
      <div class="corpo-tabSet">
        <div class="corpo-tabSet__tab corpo-tabSet__tab--selected">
          <a href="https://host/app/?rid=PAGE1&tabrid=T1">Overview</a>
        </div>
        <div class="corpo-tabSet__tab">
          <a href="https://host/app/?rid=PAGE1&tabrid=T2">Risk</a>
        </div>
      </div>
      <div class="widget" data-rid="W1"></div>
      <div class="widget" data-rid="W2"></div>
    `;
    const map = ridElementMap();
    // the two widgets are present…
    expect(map.has('W1')).toBe(true);
    expect(map.has('W2')).toBe(true);
    // …and the page rid carried by the tab anchors is NOT (those elements are tab pills, not widgets)
    expect(map.has('PAGE1')).toBe(false);
    for (const el of map.values()) {
      expect(el.closest('[class*="tabSet__tab"],[role="tab"]')).toBeNull();
    }
  });
});

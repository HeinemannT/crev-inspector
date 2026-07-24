/**
 * Tests for ContentState — the content script's state class.
 * Pure class, no DOM or chrome APIs needed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentState } from '../../content-state';

describe('ContentState', () => {
  let s: ContentState;

  beforeEach(() => {
    s = new ContentState();
  });

  it('initializes with correct defaults', () => {
    expect(s.inspectActive).toBe(false);
    expect(s.enrichMode).toBe('widgets');
    expect(s.paintPhase).toBe('off');
    expect(s.paintSourceName).toBeNull();
    expect(s.styleInjected).toBe(false);
    expect(s.technicalOverlay).toBe(false);
    expect(s.fromSync).toBe(false);
    expect(s.prevConnDisplay).toBeNull();
    expect(s.lastDetection).toBeNull();
    expect(s.enrichments.size).toBe(0);
    expect(s.overlayProps.size).toBe(0);
    expect(s.requestedRids.size).toBe(0);
    expect(s.discoveredRids.size).toBe(0);
    expect(s.favoriteRids.size).toBe(0);
    expect(s.observer).toBeNull();
    expect(s.tooltipHideTimer).toBeNull();
    expect(s.debounceTimer).toBeNull();
    expect(s.renderRefreshTimer).toBeNull();
    expect(s.hoveredLabelEl).toBeNull();
    expect(s.pageHeaderElement).toBeNull();
    expect(s.pageHeaderLabel).toBeNull();
    expect(s.pageHeaderRid).toBeNull();
  });

  describe('resetOverlays', () => {
    it('clears overlay-related state', () => {
      s.requestedRids.add('rid1');
      s.overlayProps.set('rid1', { foo: 'bar' });
      s.hoveredLabelEl = {} as Element;

      s.resetOverlays();

      expect(s.requestedRids.size).toBe(0);
      expect(s.overlayProps.size).toBe(0);
      expect(s.hoveredLabelEl).toBeNull();
    });

    it('does not clear enrichments or discoveredRids', () => {
      s.enrichments.set('rid1', { type: 'Scorecard' });
      s.discoveredRids.add('rid1');
      s.resetOverlays();
      expect(s.enrichments.size).toBe(1);
      expect(s.discoveredRids.size).toBe(1);
    });

    it('keeps the mounted page header so navigation can remove it cleanly', () => {
      s.pageHeaderElement = {} as HTMLElement;
      s.pageHeaderLabel = {} as HTMLElement;
      s.pageHeaderRid = '111';

      s.resetOverlays();

      expect(s.pageHeaderElement).not.toBeNull();
      expect(s.pageHeaderLabel).not.toBeNull();
      expect(s.pageHeaderRid).toBe('111');
    });
  });

  describe('resetDiscovery', () => {
    it('clears discoveredRids', () => {
      s.discoveredRids.add('rid1');
      s.discoveredRids.add('rid2');
      s.resetDiscovery();
      expect(s.discoveredRids.size).toBe(0);
    });
  });

  describe('resetAll', () => {
    it('resets all state to defaults', () => {
      // Populate everything
      s.inspectActive = true;
      s.enrichMode = 'widgets';
      s.paintPhase = 'picking';
      s.paintSourceName = 'source';
      s.styleInjected = true;
      s.technicalOverlay = true;
      s.fromSync = true;
      s.prevConnDisplay = 'connected';
      s.lastDetection = { confidence: 0.9, signals: ['test'], isBmp: true };
      s.enrichments.set('rid1', { type: 'Scorecard' });
      s.requestedRids.add('rid1');
      s.discoveredRids.add('rid1');
      s.favoriteRids.add('rid1');
      s.pageHeaderElement = {} as HTMLElement;
      s.pageHeaderLabel = {} as HTMLElement;
      s.pageHeaderRid = '111';

      s.resetAll();

      expect(s.inspectActive).toBe(false);
      expect(s.enrichMode).toBe('widgets');
      expect(s.paintPhase).toBe('off');
      expect(s.paintSourceName).toBeNull();
      expect(s.styleInjected).toBe(false);
      expect(s.technicalOverlay).toBe(false);
      expect(s.fromSync).toBe(false);
      expect(s.prevConnDisplay).toBeNull();
      expect(s.lastDetection).toBeNull();
      expect(s.enrichments.size).toBe(0);
      expect(s.requestedRids.size).toBe(0);
      expect(s.discoveredRids.size).toBe(0);
      expect(s.favoriteRids.size).toBe(0);
      expect(s.pageHeaderElement).toBeNull();
      expect(s.pageHeaderLabel).toBeNull();
      expect(s.pageHeaderRid).toBeNull();
    });

    it('clears all timers', () => {
      vi.useFakeTimers();
      s.debounceTimer = setTimeout(() => {}, 1000);
      s.renderRefreshTimer = setTimeout(() => {}, 1000);
      s.tooltipHideTimer = setTimeout(() => {}, 1000);

      s.resetAll();

      expect(s.debounceTimer).toBeNull();
      expect(s.renderRefreshTimer).toBeNull();
      expect(s.tooltipHideTimer).toBeNull();
        vi.useRealTimers();
    });

    it('disconnects observer', () => {
      const disconnect = vi.fn();
      s.observer = { disconnect } as any;
      s.resetAll();
      expect(disconnect).toHaveBeenCalled();
      expect(s.observer).toBeNull();
    });
  });
});

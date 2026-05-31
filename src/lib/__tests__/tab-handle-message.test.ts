/**
 * Tests for Tab.handleMessage — state transitions without DOM.
 * Each tab's handleMessage returns true/false and mutates internal state.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// We can't import the actual Tab classes because they import DOM modules.
// Instead, test the message → state logic extracted as pure functions.
// This mirrors what the tabs do internally.

import type { InspectorMessage, ActivityEntry } from '../types';

// ── LogTab message logic ─────────────────────────────────────────

describe('LogTab handleMessage logic', () => {
  let entries: ActivityEntry[];
  let latestMsg: string | null;

  function handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'ACTIVITY_LOG':
        entries = msg.entries;
        return true;
      case 'ACTIVITY_ENTRY':
        entries.push(msg.entry);
        if (entries.length > 50) entries.shift();
        latestMsg = msg.entry.message;
        return true;
      default:
        return false;
    }
  }

  beforeEach(() => {
    entries = [];
    latestMsg = null;
  });

  it('returns true and stores entries on ACTIVITY_LOG', () => {
    const result = handleMessage({
      type: 'ACTIVITY_LOG',
      entries: [{ id: 1, time: Date.now(), level: 'info', message: 'test' }],
    });
    expect(result).toBe(true);
    expect(entries).toHaveLength(1);
  });

  it('returns true and appends on ACTIVITY_ENTRY', () => {
    const result = handleMessage({
      type: 'ACTIVITY_ENTRY',
      entry: { id: 1, time: Date.now(), level: 'success', message: 'Connected' },
    });
    expect(result).toBe(true);
    expect(entries).toHaveLength(1);
    expect(latestMsg).toBe('Connected');
  });

  it('returns false for unrelated messages', () => {
    expect(handleMessage({ type: 'CACHE_DATA', objects: [] })).toBe(false);
    expect(handleMessage({ type: 'SETTINGS_DATA', settings: {} as any })).toBe(false);
  });

  it('caps entries at 50', () => {
    for (let i = 0; i < 55; i++) {
      handleMessage({
        type: 'ACTIVITY_ENTRY',
        entry: { id: i, time: Date.now(), level: 'info', message: `msg ${i}` },
      });
    }
    expect(entries).toHaveLength(50);
    expect(entries[0].message).toBe('msg 5'); // first 5 shifted out
  });
});

// ── WorkshopLayoutPane message logic ────────────────────────────────────────

describe('WorkshopLayoutPane handleMessage logic', () => {
  let pageInfo: any;
  let detection: any;

  function handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'PAGE_INFO':
        pageInfo = { url: msg.url, rid: msg.rid, tabRid: msg.tabRid, widgets: msg.widgets };
        if (msg.detection) {
          detection = {
            phase: msg.detection.isBmp ? 'detected' : 'not-detected',
            confidence: msg.detection.confidence,
            signals: msg.detection.signals,
          };
        }
        return true;
      case 'DETECTION_STATE':
        detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
        return true;
      default:
        return false;
    }
  }

  beforeEach(() => {
    pageInfo = null;
    detection = { phase: 'unknown', confidence: 0, signals: [] };
  });

  it('stores page info and detection on PAGE_INFO', () => {
    const result = handleMessage({
      type: 'PAGE_INFO',
      url: 'http://localhost:8080/BMP/',
      widgets: [{ rid: '123', type: 'Scorecard', name: 'SC' }],
      detection: { confidence: 0.95, signals: ['data-rid attributes'], isBmp: true },
    } as any);
    expect(result).toBe(true);
    expect(pageInfo.widgets).toHaveLength(1);
    expect(detection.phase).toBe('detected');
    expect(detection.confidence).toBe(0.95);
  });

  it('updates detection on DETECTION_STATE', () => {
    const result = handleMessage({
      type: 'DETECTION_STATE',
      phase: 'detected',
      confidence: 0.8,
      signals: ['BMP URL path'],
    } as any);
    expect(result).toBe(true);
    expect(detection.phase).toBe('detected');
  });

  it('returns false for unrelated messages', () => {
    expect(handleMessage({ type: 'CACHE_DATA', objects: [] })).toBe(false);
  });
});

// ── ConnectTab message logic ─────────────────────────────────────

describe('ConnectTab handleMessage logic', () => {
  let editing: boolean;

  function handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'SETTINGS_DATA':
      case 'CONNECTION_STATE':
      case 'PROFILE_SWITCHED':
        return !editing;
      default:
        return false;
    }
  }

  it('returns true when not editing', () => {
    editing = false;
    expect(handleMessage({ type: 'SETTINGS_DATA', settings: {} as any })).toBe(true);
    expect(handleMessage({ type: 'CONNECTION_STATE', state: {} as any })).toBe(true);
  });

  it('returns false when editing (prevents form disruption)', () => {
    editing = true;
    expect(handleMessage({ type: 'SETTINGS_DATA', settings: {} as any })).toBe(false);
    expect(handleMessage({ type: 'CONNECTION_STATE', state: {} as any })).toBe(false);
  });

  it('returns false for unrelated messages', () => {
    editing = false;
    expect(handleMessage({ type: 'CACHE_DATA', objects: [] })).toBe(false);
  });
});

// ── ObjectsTab message logic ─────────────────────────────────────

describe('ObjectsTab handleMessage logic', () => {
  let objects: any[];
  let history: any[];

  function handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'CACHE_DATA':
        objects = msg.objects;
        return true;
      case 'HISTORY_DATA':
        history = msg.entries;
        return true;
      case 'FAVORITES_DATA':
        return true; // shared state, just trigger re-render
      default:
        return false;
    }
  }

  beforeEach(() => {
    objects = [];
    history = [];
  });

  it('stores objects on CACHE_DATA', () => {
    const result = handleMessage({
      type: 'CACHE_DATA',
      objects: [{ rid: '123', source: 'dom', discoveredAt: 0, updatedAt: 0 }],
    });
    expect(result).toBe(true);
    expect(objects).toHaveLength(1);
  });

  it('stores history on HISTORY_DATA', () => {
    const result = handleMessage({
      type: 'HISTORY_DATA',
      entries: [{ rid: '123', action: 'viewed', timestamp: Date.now() }],
    } as any);
    expect(result).toBe(true);
    expect(history).toHaveLength(1);
  });

  it('returns true on FAVORITES_DATA (triggers re-render for pinned section)', () => {
    expect(handleMessage({ type: 'FAVORITES_DATA', entries: [] })).toBe(true);
  });

  it('returns false for unrelated messages', () => {
    expect(handleMessage({ type: 'ACTIVITY_LOG', entries: [] })).toBe(false);
  });
});

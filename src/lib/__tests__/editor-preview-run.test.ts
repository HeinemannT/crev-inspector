/**
 * Tests for the Preview/Run gating state machine in the EC editor.
 *
 * Covers:
 * - previewDone starts false (Run disabled)
 * - Successful preview unlocks Run
 * - Failed preview keeps Run locked
 * - Code change resets gate
 * - Transactional execution resets gate after run
 * - Property tab switch resets gate
 * - Clear resets gate
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── State machine extracted from editor.ts ──
// This mirrors the gating logic without the DOM/CodeMirror dependencies.

interface EditorGateState {
  previewDone: boolean;
  lastMode: 'preview' | 'execute' | 'save' | null;
  dirty: boolean;
}

function createState(): EditorGateState {
  return { previewDone: false, lastMode: null, dirty: false };
}

function simulatePreview(state: EditorGateState, ok: boolean): EditorGateState {
  state.lastMode = 'preview';
  if (ok) {
    state.previewDone = true;
  } else {
    state.previewDone = false;
  }
  return state;
}

function simulateRun(state: EditorGateState): EditorGateState | null {
  if (!state.previewDone) return null; // blocked
  state.lastMode = 'execute';
  // After execution, reset gate
  state.previewDone = false;
  return state;
}

function simulateCodeChange(state: EditorGateState): EditorGateState {
  state.dirty = true;
  state.previewDone = false;
  return state;
}

function simulatePropertyTabSwitch(state: EditorGateState): EditorGateState {
  state.previewDone = false;
  return state;
}

function simulateTargetToggle(state: EditorGateState): EditorGateState {
  state.previewDone = false;
  return state;
}

function simulateClear(state: EditorGateState): EditorGateState {
  state.previewDone = false;
  state.lastMode = null;
  state.dirty = false;
  return state;
}

// ── Tests ──

describe('Editor Preview/Run gating', () => {
  let state: EditorGateState;

  beforeEach(() => {
    state = createState();
  });

  it('starts with Run disabled', () => {
    expect(state.previewDone).toBe(false);
  });

  it('successful preview unlocks Run', () => {
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    expect(state.lastMode).toBe('preview');
  });

  it('failed preview keeps Run locked', () => {
    simulatePreview(state, false);
    expect(state.previewDone).toBe(false);
  });

  it('Run is blocked when preview not done', () => {
    const result = simulateRun(state);
    expect(result).toBeNull();
  });

  it('Run succeeds after preview', () => {
    simulatePreview(state, true);
    const result = simulateRun(state);
    expect(result).not.toBeNull();
    expect(result!.lastMode).toBe('execute');
  });

  it('Run resets gate after execution', () => {
    simulatePreview(state, true);
    simulateRun(state);
    expect(state.previewDone).toBe(false);
    // Second run should be blocked
    const result = simulateRun(state);
    expect(result).toBeNull();
  });

  it('code change resets gate', () => {
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    simulateCodeChange(state);
    expect(state.previewDone).toBe(false);
  });

  it('property tab switch resets gate', () => {
    simulatePreview(state, true);
    simulatePropertyTabSwitch(state);
    expect(state.previewDone).toBe(false);
  });

  it('target toggle (template/instance) resets gate', () => {
    simulatePreview(state, true);
    simulateTargetToggle(state);
    expect(state.previewDone).toBe(false);
  });

  it('clear resets gate', () => {
    simulatePreview(state, true);
    simulateClear(state);
    expect(state.previewDone).toBe(false);
    expect(state.lastMode).toBeNull();
    expect(state.dirty).toBe(false);
  });

  it('full cycle: preview → run → preview → run', () => {
    // Cycle 1
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    simulateRun(state);
    expect(state.previewDone).toBe(false);

    // Cycle 2
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    simulateRun(state);
    expect(state.previewDone).toBe(false);
  });

  it('failed preview after successful preview locks Run again', () => {
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    // Code change + re-preview that fails
    simulateCodeChange(state);
    simulatePreview(state, false);
    expect(state.previewDone).toBe(false);
  });

  it('multiple previews: last result wins', () => {
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
    simulatePreview(state, false);
    expect(state.previewDone).toBe(false);
    simulatePreview(state, true);
    expect(state.previewDone).toBe(true);
  });
});

describe('Editor mode labels', () => {
  it('preview mode produces "Preview" label', () => {
    const state = createState();
    simulatePreview(state, true);
    const modeLabel = state.lastMode === 'save' ? 'Saved' : state.lastMode === 'execute' ? 'Executed' : 'Preview';
    expect(modeLabel).toBe('Preview');
  });

  it('execute mode produces "Executed" label', () => {
    const state = createState();
    simulatePreview(state, true);
    simulateRun(state);
    const modeLabel = state.lastMode === 'save' ? 'Saved' : state.lastMode === 'execute' ? 'Executed' : 'Preview';
    expect(modeLabel).toBe('Executed');
  });

  it('null mode (initial) falls through to Preview', () => {
    const state = createState();
    const modeLabel = state.lastMode === 'save' ? 'Saved' : state.lastMode === 'execute' ? 'Executed' : 'Preview';
    expect(modeLabel).toBe('Preview');
  });
});

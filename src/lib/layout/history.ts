/**
 * Undo/redo over whole-model snapshots. Pure data structure — the controller pushes a
 * snapshot after every edit and reads `present()` to render. Reset on Apply/Discard
 * (those are commit/abort boundaries; you can't undo across a committed apply).
 */
import { cloneModel } from './model';
import type { LModel } from './types';

export class History {
  private stack: LModel[] = [];
  private idx = -1;

  constructor(initial: LModel) {
    this.reset(initial);
  }

  /** Replace the baseline and clear the stack (after load / apply / discard). */
  reset(model: LModel): void {
    this.stack = [cloneModel(model)];
    this.idx = 0;
  }

  /** Record a new state as the present, discarding any redo tail. */
  push(model: LModel): void {
    this.stack = this.stack.slice(0, this.idx + 1);
    this.stack.push(cloneModel(model));
    this.idx = this.stack.length - 1;
  }

  present(): LModel {
    return cloneModel(this.stack[this.idx]);
  }

  canUndo(): boolean { return this.idx > 0; }
  canRedo(): boolean { return this.idx < this.stack.length - 1; }

  undo(): LModel | null {
    if (!this.canUndo()) return null;
    this.idx -= 1;
    return this.present();
  }

  redo(): LModel | null {
    if (!this.canRedo()) return null;
    this.idx += 1;
    return this.present();
  }
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Studio responsive actions', () => {
  it('keeps Download and Discard reachable as icon buttons at narrow widths', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'styles', 'components.css'), 'utf8');
    const compactAt = css.indexOf('@media (max-width: 760px)');
    const tightAt = css.indexOf('@media (max-width: 680px)');
    const compact = css.slice(compactAt, tightAt);
    const tight = css.slice(tightAt);

    expect(compact).toContain('.code-action-secondary .code-action-label { display: none; }');
    expect(compact).not.toMatch(/\.code-action-secondary\s*\{[^}]*display:\s*none/s);
    expect(tight).toContain('.code-action-tertiary .code-action-label');
    expect(tight).not.toMatch(/\.code-action-tertiary\s*\{[^}]*display:\s*none/s);
  });
});

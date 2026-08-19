import { describe, expect, it } from 'vitest';
import { CHANGE_TARGET_PROMPT_CONTRACT } from '../change-target';

describe('change target prompt contract', () => {
  it('states the complete structural decision table without a private route map', () => {
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('exact target or receiver supplied by the user or verified context is authoritative');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('linkedTemplateRid');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('pageTemplateRid');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('pageOwnerRid');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('storage=portal-shared');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('lookup("RID")');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('a Container is never the `add` receiver');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).toContain('they are not symbolic EC references');
    expect(CHANGE_TARGET_PROMPT_CONTRACT).not.toMatch(/route map|mutationRef|scope=/i);
  });
});

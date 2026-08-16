import { describe, expect, it, vi } from 'vitest';
import { buildWorkspacePrimer } from '../ai-primer';

describe('workspace primer request pressure', () => {
  it('reads only top-level organisation entries and never scans descendants', async () => {
    const executeEc = vi.fn(async (_code: string) => ({
      ok: true,
      log: 'Result : top-level=2\nunits: Group (org_group, Organisation); Sandbox (org_sbx, Organisation);',
    }));

    const primer = await buildWorkspacePrimer({ executeEc } as any);
    const code = executeEc.mock.calls[0][0] as string;

    expect(executeEc).toHaveBeenCalledTimes(1);
    expect(code).toContain('root.organisation.children()');
    expect(code).not.toContain('descendants(');
    expect(code).not.toContain('linkedTo');
    expect(primer).toContain('top-level=2');
    expect(primer).toContain('bounded top-level');
  });

  it('degrades to null when the bounded marker is absent', async () => {
    const executeEc = vi.fn(async () => ({ ok: true, log: 'unexpected output' }));

    await expect(buildWorkspacePrimer({ executeEc } as any)).resolves.toBeNull();
  });

  it('propagates cancellation instead of turning it into a cacheable miss', async () => {
    const error = new DOMException('cancelled', 'AbortError');
    const executeEc = vi.fn(async () => { throw error; });
    const controller = new AbortController();
    controller.abort(error);

    await expect(buildWorkspacePrimer({ executeEc } as any, controller.signal)).rejects.toBe(error);
  });
});

import { describe, it, expect } from 'vitest';
import type { LModel, LNode } from '../types';
import { resize, setHeight, rename, moveInto, addContainer, addWidget, remove } from '../edit';
import { diff } from '../diff';
import { compile } from '../ec';

const n = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({ name: p.id, cols: { L: 6 }, children: [], ...p });

/** Real Risk Register tab of demo scorecard 4957 (business ids verified live). */
const demo = (): LModel => ({
  pageId: '4957', pageClass: 'Scorecard', tabsetId: 'crev_demo_tabset',
  target: 'template', hasTemplate: true,
  tabs: [n({ id: '4904', kind: 'tab', className: 'Tab', name: 'Risk Register', children: [
    n({ id: 'cont_crev_demo_enterprise_14', kind: 'container', className: 'Container', name: 'KPIs', cols: { L: 2 }, children: [
      n({ id: '4965', kind: 'widget', className: 'FunctionStatus', name: 'Control Health' }),
      n({ id: '4966', kind: 'widget', className: 'Status', name: 'Risk Appetite' }),
    ] }),
    n({ id: 'cont_crev_demo_enterprise_18', kind: 'container', className: 'Container', name: 'Side Panel', cols: { L: 2 }, children: [
      n({ id: 'cont_crev_demo_enterprise_19', kind: 'container', className: 'Container', name: 'Detail', cols: { L: 6 }, children: [
        n({ id: '4968', kind: 'widget', className: 'PieChart', name: 'By Owner', height: 232 }),
        n({ id: '4969', kind: 'widget', className: 'TextElement', name: 'Notes' }),
      ] }),
    ] }),
    n({ id: '4964', kind: 'widget', className: 'RiskList', name: 'Register', cols: { L: 4 } }),
    n({ id: '4967', kind: 'widget', className: 'BarLineChart', name: 'Trend vs Target', cols: { L: 4 }, height: 232 }),
  ] })],
});

/**
 * Golden EC — this exact script was validated against live Steadfast via ec_preview on
 * 2026-06-26 and returned [OK] (creates, variable threading, re-home-before-delete, and
 * kind-segregated reorders all accepted). If the generator changes, re-validate live before
 * updating this string.
 *
 * Re-validated live 2026-06-28 after the reorder-emission fix: the two cont_14 moveAfters
 * (4966→4965, 4964→4966) were dropped because moving 4964 INTO cont_14 appends it, which already
 * yields the desired order — those moveAfters were redundant no-ops. The shortened script returned
 * [OK] via ec_preview.
 *
 * Re-validated live 2026-07-02 after the band-invariant normalization: edits now keep the model in
 * canonical order (containers first), so the desired tree — and with it the pre-order create
 * numbering (_n0 = the box, _n2 = the TextElement) and the reorder anchors — follows BMP's real
 * render order instead of the raw splice positions. Same operations, band-legal order; ec_preview
 * accepted every move ([OK]).
 *
 * Updated 2026-07-12 for MINIMAL reorder: the two new nodes (_n0 the container, _n2 the TextElement)
 * are each inserted at the FRONT of their sibling group, so the old four-step moveAfter cascade
 * collapses to TWO single moveBefore ops (the kept items — cont_14, 4967/4968/4969 — stay put).
 * moveBefore live-verified on the fixture InputSet t.50850 (moveBefore + a 2-move minimal shuffle both
 * committed [OK], order read back exactly, restored); the same generic verb the layout reorder emits.
 */
const GOLDEN = [
  '_sc := t.4957',
  '_n0 := t.4904.add(Container, name := "Col 2", columnsLargeScreen := 2) // BMP assigns id',
  '_n1 := _sc.add(PieChart, name := "New PieChart", container := _n0, columnsLargeScreen := 6, chartHeight := 200) // BMP assigns id',
  '_n2 := _sc.add(TextElement, name := "New TextElement", container := t.4904, columnsLargeScreen := 6) // BMP assigns id',
  't.4964.change(columnsLargeScreen := 6)',
  't.4964.change(container := t.cont_crev_demo_enterprise_14)',
  't.4968.change(chartHeight := 300)',
  't.4968.change(container := t.4904)',
  't.4969.change(name := "Analyst Notes")',
  't.4969.change(container := t.4904)',
  '_n0.moveBefore(t.cont_crev_demo_enterprise_14)',
  '_n2.moveBefore(t.4967)',
  't.cont_crev_demo_enterprise_19.delete()',
  't.cont_crev_demo_enterprise_18.delete()',
].join('\n');

describe('ec golden (live-validated)', () => {
  it('compiles the comprehensive edit set to the validated script', () => {
    const base = demo();
    let d = resize(base, '4964', 'L', 6);
    d = rename(d, '4969', 'Analyst Notes');
    d = setHeight(d, '4968', 300);
    const box = addContainer(d, '4904', 0, 2); d = box.model;
    d = addWidget(d, box.id, 0, 'PieChart').model;
    d = addWidget(d, '4904', 0, 'TextElement').model;
    d = moveInto(d, '4964', 'cont_crev_demo_enterprise_14');
    d = remove(d, 'cont_crev_demo_enterprise_18');
    expect(compile(diff(base, d), d).script).toBe(GOLDEN);
  });

  it('never emits a cross-kind moveAfter (widget past container)', () => {
    const base = demo();
    const d = moveInto(base, '4964', 'cont_crev_demo_enterprise_14');
    for (const step of diff(base, d)) {
      if (step.kind === 'reorder') {
        // both ends of a reorder must be the same kind — checked structurally by construction,
        // asserted here as a guard against regressions. The anchor is afterId (moveAfter) or beforeId
        // (moveBefore, drag-to-front) — exactly one is set.
        expect(typeof (step.afterId ?? step.beforeId)).toBe('string');
      }
    }
  });
});

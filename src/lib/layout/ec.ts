/**
 * compile(plan, model) → { script, notes }.
 *
 * Turns the ordered plan into ONE Extended Code program. Objects created in this batch are
 * captured in `_n<k>` variables and referenced by variable when a later step depends on them
 * (a widget binding into a just-created container, a moveAfter of a just-created node). Existing
 * objects are referenced as `t.<businessId>`. The two-model split: widgets are added to the
 * scorecard (`_sc.add`), containers to their tab/container (`<parent>.add`), tabs to the tabset
 * (`_ts.add`).
 *
 * NOTE: target=template structural ops are unverified (see constraints.ts) — this emits against
 * the page's own objects; the sync layer is responsible for the template-vs-instance wrap once
 * that semantic is confirmed against a template-backed page.
 */
import { walk } from './model';
import type { Breakpoint, LModel, LNode, PlanNote, PlanStep } from './types';

const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;          // class names
const BID = /^[A-Za-z0-9_]+$/;                      // business ids (may start with a digit)

function ecStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"';
}
function ecClass(c: string): string {
  if (!IDENT.test(c)) throw new Error(`unsafe EC class name: ${c}`);
  return c;
}
function ecBid(id: string): string {
  if (!BID.test(id)) throw new Error(`unsafe EC business id: ${id}`);
  return id;
}

const COL_PROP: Record<Breakpoint, string> = { L: 'columnsLargeScreen', M: 'columnsMediumScreen', S: 'columnsSmallScreen' };

/** Responsive-width suffix for an add() — M/S are only emitted when authored (else BMP defaults). */
const colsSuffix = (cols: { L: number; M?: number; S?: number }): string =>
  (cols.M != null ? `, ${COL_PROP.M} := ${cols.M}` : '') + (cols.S != null ? `, ${COL_PROP.S} := ${cols.S}` : '');

export function compile(plan: PlanStep[], m: LModel): { script: string; notes: PlanNote[] } {
  if (!plan.length) return { script: '', notes: [] };

  const byId = new Map<string, LNode>();
  walk(m, n => byId.set(n.id, n));

  const vars = new Map<string, string>();
  const ref = (id: string): string => vars.get(id) ?? `t.${ecBid(id)}`;

  const needWidget = plan.some(s => s.kind === 'create' && s.node.kind === 'widget');
  const needTabset = plan.some(s => s.kind === 'create' && s.node.kind === 'tab');

  const lines: string[] = [];
  if (needWidget) {
    lines.push(`_scr := SELECT ${ecClass(m.pageClass)} WHERE id = ${ecStr(m.pageId)}`);
    lines.push(`_sc := _scr.first()`);
  }
  if (needTabset) lines.push(`_ts := t.${ecBid(m.tabsetId)}`);

  const notes: PlanNote[] = [];
  let k = 0;
  const emit = (note: PlanNote) => { lines.push(note.ec!); notes.push(note); };

  for (const s of plan) {
    switch (s.kind) {
      case 'create': {
        const v = `_n${k++}`;
        vars.set(s.node.id, v);
        const n = s.node;
        if (n.kind === 'tab') {
          emit({ verb: 'create', text: `Create tab "${n.name}"`,
            ec: `${v} := _ts.add(Tab, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else if (n.kind === 'container') {
          emit({ verb: 'create', text: `Create container "${n.name}"`,
            ec: `${v} := ${ref(s.parentId)}.add(Container, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else {
          const h = n.height != null ? `, chartHeight := ${n.height}` : '';
          emit({ verb: 'create', text: `Create ${n.className} "${n.name}"`,
            ec: `${v} := _sc.add(${ecClass(n.className)}, name := ${ecStr(n.name)}, container := ${ref(s.parentId)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}${h}) // BMP assigns id` });
        }
        break;
      }
      case 'update': {
        const parts: string[] = [];
        if (s.cols) (['L', 'M', 'S'] as Breakpoint[]).forEach(bp => { if (s.cols![bp] != null) parts.push(`${COL_PROP[bp]} := ${s.cols![bp]}`); });
        if (s.name != null) parts.push(`name := ${ecStr(s.name)}`);
        if (s.height != null) parts.push(`chartHeight := ${s.height}`);
        const label = byId.get(s.id)?.name ?? s.id;
        emit({ verb: 'update', text: `Update "${label}" (${parts.length} change${parts.length > 1 ? 's' : ''})`,
          ec: `${ref(s.id)}.change(${parts.join(', ')})` });
        break;
      }
      case 'reparent': {
        const field = s.nodeKind === 'widget' ? 'container' : 'parent';
        const label = byId.get(s.id)?.name ?? s.id;
        emit({ verb: 'move', text: `Move "${label}" into ${byId.get(s.toParentId)?.name ?? s.toParentId}`,
          ec: `${ref(s.id)}.change(${field} := ${ref(s.toParentId)})` });
        break;
      }
      case 'reorder': {
        const label = byId.get(s.id)?.name ?? s.id;
        emit({ verb: 'reorder', text: `Reorder "${label}"`,
          ec: `${ref(s.id)}.moveAfter(${ref(s.afterId!)})` });
        break;
      }
      case 'delete': {
        emit({ verb: 'delete', text: `Delete ${s.nodeKind} (${s.className})`,
          ec: `${ref(s.id)}.delete()` });
        break;
      }
    }
  }

  return { script: lines.join('\n'), notes };
}

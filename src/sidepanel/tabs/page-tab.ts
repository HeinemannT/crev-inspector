/**
 * Page tab — Webpage Inspector.
 * Shows detection status, widgets on page, context object location,
 * and template tree with lazy-loaded children and properties.
 */

import type { InspectorMessage, BmpObject, WidgetInfo, DetectionPhase } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyBtn, formatValue, ICON_REFRESH } from '../utils';
import { resolveNamespace, NAMESPACE_ROOTS } from '../../lib/namespace';
import type { Tab, SendFn } from './tab-types';

const SKIP_PROPS = new Set(['rid', 'id', 'name', 'type', '__typename', 'typename', 'source', 'discoveredAt', 'updatedAt', 'properties', 'treePath', 'webParentRid', 'hasChildren']);
const SCRIPT_PROPS = new Set(['expression', 'html', 'javascript', 'css']);
const MAX_TREE_DEPTH = 50;

interface TreeNode {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  children?: TreeNode[];
  childrenLoading?: boolean;
  properties?: Record<string, unknown>;
  templateBusinessId?: string;
}

export class PageTab implements Tab {
  // Detection + widgets (from PAGE_INFO)
  private detection = { phase: 'unknown' as DetectionPhase, confidence: 0, signals: [] as string[] };
  private widgets: WidgetInfo[] = [];

  // Context object + template tree
  private contextRid: string | null = null;
  private contextObj: BmpObject | null = null;
  private contextLoading = false;
  private templateInfo: { rid: string; name: string; type: string; businessId?: string } | null = null;
  private treeRoot: TreeNode | null = null;
  private expandedNodes = new Set<string>();
  private expandedProps = new Set<string>();

  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    this.send({ type: 'GET_PAGE_INFO' });
    this.send({ type: 'GET_CONTEXT_RID' });
  }

  deactivate() {}

  findObject(rid: string) {
    if (this.contextObj?.rid === rid) return this.contextObj;
    const w = this.widgets.find(w => w.rid === rid);
    if (w) return { rid: w.rid, name: w.name, type: w.type, source: 'dom' as const, discoveredAt: Date.now(), updatedAt: Date.now() };
    return null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'PAGE_INFO':
        this.widgets = msg.widgets;
        if (msg.detection) {
          const phase: DetectionPhase = msg.detection.isBmp ? 'detected' : 'not-detected';
          this.detection = { phase, confidence: msg.detection.confidence, signals: msg.detection.signals };
        }
        return true;
      case 'DETECTION_STATE':
        this.detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
        return true;
      case 'CONTEXT_RID_DATA':
        if ('rid' in msg && msg.rid) {
          if (msg.rid === this.contextRid) return false; // same context, skip
          this.contextRid = msg.rid;
          this.contextLoading = true;
          this.contextObj = null;
          this.templateInfo = null;
          this.treeRoot = null;
          this.expandedNodes.clear();
          this.expandedProps.clear();
          this.send({ type: 'FULL_LOOKUP', rid: msg.rid });
        } else {
          this.contextRid = null;
          this.contextObj = null;
          this.contextLoading = false;
          this.templateInfo = null;
          this.treeRoot = null;
        }
        return true;
      case 'FULL_LOOKUP_RESULT':
        if ('rid' in msg && msg.rid === this.contextRid && this.contextLoading) {
          this.contextLoading = false;
          if (msg.object) {
            this.contextObj = msg.object;
            this.templateInfo = msg.template ?? null;
            // Tree root: template if available (shows config hierarchy), else the object itself
            const rootSource = msg.template ?? { rid: msg.rid, name: msg.object.name, type: msg.object.type, businessId: msg.object.businessId };
            this.treeRoot = {
              rid: rootSource.rid,
              name: rootSource.name,
              type: rootSource.type,
              businessId: rootSource.businessId,
              children: msg.children?.map(c => ({ rid: c.rid, name: c.name, type: c.type, businessId: c.businessId })),
              properties: msg.object.properties,
              templateBusinessId: msg.object.templateBusinessId,
            };
            this.expandedNodes.add(rootSource.rid);
          }
          return true;
        }
        return false;
      case 'FETCH_CHILDREN_RESULT':
        if ('rid' in msg) {
          const node = this.findNode(this.treeRoot, msg.rid);
          if (node) {
            node.childrenLoading = false;
            node.children = msg.children.map(c => ({ rid: c.rid, name: c.name, type: c.type, businessId: c.businessId }));
            return true;
          }
        }
        return false;
      default:
        return false;
    }
  }

  private findNode(node: TreeNode | null, rid: string, depth = 0): TreeNode | null {
    if (!node || depth > MAX_TREE_DEPTH) return null;
    if (node.rid === rid) return node;
    for (const child of node.children ?? []) {
      const found = this.findNode(child, rid, depth + 1);
      if (found) return found;
    }
    return null;
  }

  render(container: HTMLElement) {
    const children: (HTMLElement | false | null)[] = [];

    // Detection card
    children.push(this.detectionCard());

    // Widgets section (from PAGE_INFO — shows what's on the current page)
    if (this.widgets.length > 0) {
      children.push(
        h('div', { class: 'section-title' },
          `Widgets (${this.widgets.length})`,
          h('button', { class: 'refresh-enrich-btn', 'data-action': 'refresh-widgets', title: 'Re-fetch badge IDs' }, svg(ICON_REFRESH)),
        ),
        h('ul', { class: 'widget-list' },
          ...this.widgets.map(w =>
            h('li', {
              class: 'widget-item',
              'data-action': 'widget',
              'data-rid': w.rid,
              title: 'Click for details',
            },
              h('span', { class: 'widget-type', style: `--type-color:${getTypeColor(w.type)}` }, getTypeAbbr(w.type)),
              h('span', { class: 'widget-name' }, w.name ?? 'unnamed'),
              h('span', { class: 'widget-rid' }, truncRid(w.rid)),
            ),
          ),
        ),
      );
    }

    // Context object section
    children.push(h('div', { class: 'section-title' }, 'Context'));

    if (!this.contextRid && !this.contextLoading) {
      children.push(h('div', { class: 'empty-state' },
        'No context object.', h('br'), 'Right-click a BMP element to set context.'));
    } else if (this.contextLoading) {
      children.push(h('div', { class: 'empty-state' }, 'Loading\u2026'));
    } else if (this.contextObj) {
      // Location breadcrumb
      const loc = this.buildLocation();
      children.push(h('div', { class: 'inspector-location' },
        h('span', { class: 'inspector-location-label' }, 'Location'),
        h('span', { class: 'inspector-location-path mono' }, loc),
      ));

      // Template tree
      if (this.treeRoot) {
        children.push(h('div', { class: 'section-title' },
          this.templateInfo ? `Template: ${this.templateInfo.name ?? this.templateInfo.businessId ?? 'unknown'}` : 'Object Tree',
          h('button', { class: 'refresh-enrich-btn', 'data-action': 'refresh-tree', title: 'Refresh tree' }, svg(ICON_REFRESH)),
        ));
        children.push(this.renderTree(this.treeRoot, 0));
      }
    }

    render(container, ...children);

    delegate(container, {
      widget: (el) => {
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'refresh-widgets': () => this.send({ type: 'REFRESH_ENRICHMENT' }),
      'toggle-node': (el) => {
        const rid = el.dataset.rid;
        if (!rid) return;
        if (this.expandedNodes.has(rid)) {
          this.expandedNodes.delete(rid);
        } else {
          this.expandedNodes.add(rid);
          const node = this.findNode(this.treeRoot, rid);
          if (node && node.children === undefined) {
            node.childrenLoading = true;
            this.send({ type: 'FETCH_CHILDREN', rid });
          }
        }
        this.render(container);
      },
      'toggle-props': (el) => {
        const rid = el.dataset.rid;
        if (!rid) return;
        if (this.expandedProps.has(rid)) this.expandedProps.delete(rid);
        else this.expandedProps.add(rid);
        this.render(container);
      },
      'nav-object': (el) => {
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'refresh-tree': () => {
        this.contextRid = null;
        this.contextObj = null;
        this.treeRoot = null;
        this.templateInfo = null;
        this.expandedNodes.clear();
        this.expandedProps.clear();
        this.send({ type: 'GET_CONTEXT_RID' });
      },
    });
  }

  private renderTree(node: TreeNode, depth: number): HTMLElement {
    if (depth > MAX_TREE_DEPTH) return h('div', { class: 'tree-loading' }, '(max depth)');

    const isExpanded = this.expandedNodes.has(node.rid);
    const hasChildren = node.children === undefined || node.children.length > 0;
    const color = getTypeColor(node.type);
    const chevron = hasChildren
      ? (node.childrenLoading ? '\u23F3' : (isExpanded ? '\u25BE' : '\u25B8'))
      : '\u00A0\u00A0';
    const childCount = node.children?.length;

    const nodeEl = h('div', { class: 'tree-node', style: `padding-left:${depth * 16}px` },
      h('span', {
        class: `tree-chevron${hasChildren ? ' clickable' : ''}`,
        'data-action': hasChildren ? 'toggle-node' : undefined,
        'data-rid': node.rid,
      }, chevron),
      h('span', { class: 'type-badge', style: `--type-color:${color}` }, getTypeAbbr(node.type)),
      h('span', {
        class: 'tree-name',
        'data-action': 'nav-object',
        'data-rid': node.rid,
        title: `${node.businessId ?? node.rid} \u2014 click for details`,
      }, node.name ?? node.businessId ?? truncRid(node.rid)),
      childCount != null && childCount > 0 && h('span', { class: 'tree-count' }, `(${childCount})`),
    );

    const branch = h('div', { class: 'tree-branch' }, nodeEl);

    if (isExpanded) {
      // Expandable properties section
      if (node.properties) {
        const entries = Object.entries(node.properties).filter(([k]) => !SKIP_PROPS.has(k));
        if (entries.length > 0) {
          const showProps = this.expandedProps.has(node.rid);
          branch.appendChild(
            h('div', {
              class: 'tree-props-toggle',
              style: `padding-left:${(depth + 1) * 16}px`,
              'data-action': 'toggle-props',
              'data-rid': node.rid,
            }, `${showProps ? '\u25BE' : '\u25B8'} Properties (${entries.length})`),
          );
          if (showProps) {
            const propWrap = h('div', { class: 'tree-props-scroll', style: `margin-left:${(depth + 1) * 16}px` },
              h('table', { class: 'prop-table' },
                ...entries.map(([key, value]) => {
                  const isScript = SCRIPT_PROPS.has(key);
                  const display = isScript && typeof value === 'string'
                    ? `${value.split('\n').length} lines`
                    : formatValue(value);
                  return h('tr', null,
                    h('td', { class: 'prop-key' }, key),
                    h('td', { class: `prop-value${isScript ? ' mono' : ''}` }, display),
                  );
                }),
              ),
            );
            branch.appendChild(propWrap);
          }
        }
      }

      // Children
      if (node.childrenLoading) {
        branch.appendChild(h('div', { class: 'tree-loading', style: `padding-left:${(depth + 1) * 16}px` }, 'Loading\u2026'));
      } else if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          branch.appendChild(this.renderTree(child, depth + 1));
        }
      }
    }

    return branch;
  }

  private buildLocation(): string {
    if (!this.contextObj) return '';
    const type = this.contextObj.type ?? '';
    const ns = resolveNamespace(type);
    const rootPath = NAMESPACE_ROOTS[ns];
    if (!rootPath) return ns + '.' + (this.contextObj.businessId ?? '?');
    return rootPath + ' \u203A ' + (this.contextObj.businessId ?? this.contextObj.name ?? truncRid(this.contextObj.rid));
  }

  private detectionCard(): HTMLElement | false {
    const d = this.detection;
    if (d.phase === 'checking' || d.phase === 'unknown') {
      return h('div', { class: 'detection-card' },
        h('div', { class: 'detection-header' },
          h('span', { class: 'detection-status checking' }, 'Checking\u2026'),
          h('span', { class: 'detection-confidence' }, h('span', { class: 'detection-spinner' })),
        ),
      );
    }

    const pct = Math.round(d.confidence * 100);
    const isDetected = d.phase === 'detected';
    return h('div', { class: 'detection-card' },
      h('div', { class: 'detection-header' },
        h('span', { class: `detection-status ${isDetected ? 'detected' : 'not-detected'}` },
          isDetected ? 'BMP Detected' : 'Not a BMP page'),
        h('span', { class: 'detection-confidence' }, `${pct}%`),
      ),
    );
  }
}

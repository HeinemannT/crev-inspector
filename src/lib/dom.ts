/**
 * Minimal DOM builder — replaces innerHTML template literals.
 * No VDOM, no diffing, no reactivity. Just a clean API for creating DOM nodes.
 */

export type Child = Node | string | number | null | false | undefined | Child[];

type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

const SVG_CACHE = new Map<string, HTMLTemplateElement>();

/** Create an HTML element with attributes and children */
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);

  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (val == null || val === false) continue;
      if (key.startsWith('on') && typeof val === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === 'class' || key === 'className') {
        el.className = String(val);
      } else if (key === 'style') {
        el.setAttribute('style', String(val));
      } else if (key === 'checked' || key === 'disabled' || key === 'readOnly') {
        if (val === true) (el as any)[key] = true;
      } else if (key === 'value') {
        (el as any).value = String(val);
      } else {
        el.setAttribute(key, val === true ? '' : String(val));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

/** Replace container contents efficiently */
export function render(container: HTMLElement, ...children: Child[]): void {
  container.textContent = '';
  appendChildren(container, children);
}

/** Parse an SVG string into a DOM node (cached by string identity) */
export function svg(html: string): Node {
  let tmpl = SVG_CACHE.get(html);
  if (!tmpl) {
    tmpl = document.createElement('template');
    tmpl.innerHTML = html.trim();
    SVG_CACHE.set(html, tmpl);
  }
  return tmpl.content.cloneNode(true);
}

function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

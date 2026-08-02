import { getTypeAbbr, getTypeColor } from '../lib/types';

/** Readable ink for a HEX badge colour (registry colours are hex; lib/color-util.contrastInk parses
 * rgb() strings only). Rec. 601 luma, same threshold. */
function hexInk(hex: string): string {
  const normalized = hex.replace('#', '');
  const value = normalized.length === 3
    ? normalized.split('').map(character => character + character).join('')
    : normalized;
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return (0.299 * red + 0.587 * green + 0.114 * blue) > 150 ? '#1c1b16' : '#fff';
}

/** Shared flow-object badge. Keeping it independent from the flow-panel renderer lets specialized
 * surfaces such as the EditPage canvas reuse the visual identity without introducing a view cycle. */
export function flowBadge(className: string, staged = false, small = false): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'bp-fbadge' + (staged ? ' newb' : '') + (small ? ' sm' : '');
  badge.textContent = getTypeAbbr(className);
  const color = getTypeColor(className);
  badge.style.setProperty('--fb', color);
  if (!staged) badge.style.color = hexInk(color);
  badge.title = className;
  return badge;
}

/**
 * Centralized icon registry — Phosphor Bold SVGs (12×12) + existing custom icons.
 * All icons use currentColor for stroke/fill, so they inherit the parent's color.
 *
 * Phosphor icons: MIT license, https://github.com/phosphor-icons/core
 * Bold variant at 12px for compact UI. viewBox 0 0 256 256.
 */

// ── Phosphor Bold (12×12, fill) ─────────────────────────────────

const ph = (d: string, size = 12) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`;

export const ICON_PLAY = ph('M234.49,111.07,90.41,22.94A20,20,0,0,0,60,39.87V216.13a20,20,0,0,0,30.41,16.93l144.08-88.13a19.82,19.82,0,0,0,0-33.86ZM84,208.85V47.15L216.16,128Z');
export const ICON_X = ph('M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z');
export const ICON_PLUS = ph('M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z');
export const ICON_MINUS = ph('M228,128a12,12,0,0,1-12,12H40a12,12,0,0,1,0-24H216A12,12,0,0,1,228,128Z');
export const ICON_ARROW_RIGHT = ph('M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.49a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z');
export const ICON_ARROW_UNDO = ph('M104,71.6V40a12,12,0,0,0-20.49-8.49l-64,64a12,12,0,0,0,0,17l64,64A12,12,0,0,0,104,168V136.9c54.69,2.43,78.66,25.85,89.20,42.62A12,12,0,0,0,216,173.49C216,98.71,153.61,76.71,104,71.6Z');
export const ICON_ARROW_REDO = ph('M236.49,119.51l-64-64A12,12,0,0,0,152,64V95.6C102.39,100.71,40,122.71,40,197.49a12,12,0,0,0,22.8,5.91c10.54-16.77,34.51-40.19,89.2-42.62V192a12,12,0,0,0,20.49,8.49l64-64A12,12,0,0,0,236.49,119.51Z');
export const ICON_LIST = ph('M216,68a12,12,0,0,1-12,12H52a12,12,0,0,1,0-24H204A12,12,0,0,1,216,68ZM204,116H52a12,12,0,0,0,0,24H204a12,12,0,0,1,0-24Zm0,60H52a12,12,0,0,0,0,24H204a12,12,0,0,1,0-24Z');
export const ICON_TRASH = ph('M216,52H180V40a28,28,0,0,0-28-28H104A28,28,0,0,0,76,40V52H40a12,12,0,0,0,0,24h4V208a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V76h4a12,12,0,0,0,0-24ZM100,40a4,4,0,0,1,4-4h48a4,4,0,0,1,4,4V52H100Zm88,164H68V76H188ZM116,104v64a12,12,0,0,1-24,0V104a12,12,0,0,1,24,0Zm48,0v64a12,12,0,0,1-24,0V104a12,12,0,0,1,24,0Z');
export const ICON_SWAP = ph('M40,96a12,12,0,0,1,12-12H187L167.51,64.49a12,12,0,0,1,17-17l40,40a12,12,0,0,1,0,17l-40,40a12,12,0,0,1-17-17L187,108H52A12,12,0,0,1,40,96Zm164,52H69l19.52-19.51a12,12,0,0,0-17-17l-40,40a12,12,0,0,0,0,17l40,40a12,12,0,0,0,17-17L69,172H204a12,12,0,0,0,0-24Z');
// BracketsCurly — the "format / reflow code" action in the CVO studio.
export const ICON_BRACKETS = ph('M54.8,119.49A35.06,35.06,0,0,1,49.05,128a35.06,35.06,0,0,1,5.75,8.51C60,147.24,60,159.83,60,172c0,25.94,1.84,32,20,32a12,12,0,0,1,0,24c-19.14,0-32.2-6.9-38.8-20.51C36,196.76,36,184.17,36,172c0-25.94-1.84-32-20-32a12,12,0,0,1,0-24c18.16,0,20-6.06,20-32,0-12.17,0-24.76,5.2-35.49C47.8,34.9,60.86,28,80,28a12,12,0,0,1,0,24c-18.16,0-20,6.06-20,32C60,96.17,60,108.76,54.8,119.49ZM240,116c-18.16,0-20-6.06-20-32,0-12.17,0-24.76-5.2-35.49C208.2,34.9,195.14,28,176,28a12,12,0,0,0,0,24c18.16,0,20,6.06,20,32,0,12.17,0,24.76,5.2,35.49A35.06,35.06,0,0,0,207,128a35.06,35.06,0,0,0-5.75,8.51C196,147.24,196,159.83,196,172c0,25.94-1.84,32-20,32a12,12,0,0,0,0,24c19.14,0,32.2-6.9,38.8-20.51C220,196.76,220,184.17,220,172c0-25.94,1.84-32,20-32a12,12,0,0,0,0-24Z');
export const ICON_WRAP = ph('M236,112a68.07,68.07,0,0,1-68,68H61l27.52,27.51a12,12,0,0,1-17,17l-48-48a12,12,0,0,1,0-17l48-48a12,12,0,1,1,17,17L61,156H168a44,44,0,0,0,0-88H80a12,12,0,0,1,0-24h88A68.07,68.07,0,0,1,236,112Z');
export const ICON_VARIABLE = ph('M212,40a12,12,0,0,1-12,12H170.71A20,20,0,0,0,151,68.42L142.38,116H184a12,12,0,0,1,0,24H138l-9.44,51.87A44,44,0,0,1,85.29,228H56a12,12,0,0,1,0-24H85.29A20,20,0,0,0,105,187.58L113.62,140H72a12,12,0,0,1,0-24h46l9.44-51.87A44,44,0,0,1,170.71,28H200A12,12,0,0,1,212,40Z');
export const ICON_CLOCK = ph('M140,80v41.21l34.17,20.5a12,12,0,1,1-12.34,20.58l-40-24A12,12,0,0,1,116,128V80a12,12,0,0,1,24,0ZM128,28A99.38,99.38,0,0,0,57.24,57.34c-4.69,4.74-9,9.37-13.24,14V64a12,12,0,0,0-24,0v40a12,12,0,0,0,12,12H72a12,12,0,0,0,0-24H57.77C63,86,68.37,80.22,74.26,74.26a76,76,0,1,1,1.58,109,12,12,0,0,0-16.48,17.46A100,100,0,1,0,128,28Z');
export const ICON_SEARCH = ph('M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z');
export const ICON_CODE = ph('M71.68,97.22,34.74,128l36.94,30.78a12,12,0,1,1-15.36,18.44l-48-40a12,12,0,0,1,0-18.44l48-40A12,12,0,0,1,71.68,97.22Zm176,21.56-48-40a12,12,0,1,0-15.36,18.44L221.26,128l-36.94,30.78a12,12,0,1,0,15.36,18.44l48-40a12,12,0,0,0,0-18.44ZM164.1,28.72a12,12,0,0,0-15.38,7.18l-64,176a12,12,0,0,0,7.18,15.37A11.79,11.79,0,0,0,96,228a12,12,0,0,0,11.28-7.9l64-176A12,12,0,0,0,164.1,28.72Z');
export const ICON_CHECK = ph('M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z');
// Warning — a triangle with an exclamation. The status glyph for caution banners,
// validation warnings, and broken-reference markers (replaces the text ⚠).
export const ICON_WARNING = ph('M240.26,186.1,152.81,34.23h0a28.74,28.74,0,0,0-49.62,0L15.74,186.1a27.45,27.45,0,0,0,0,27.71A28.31,28.31,0,0,0,40.55,228h174.9a28.31,28.31,0,0,0,24.79-14.19A27.45,27.45,0,0,0,240.26,186.1Zm-20.8,15.7a4.46,4.46,0,0,1-4,2.2H40.55a4.46,4.46,0,0,1-4-2.2,3.56,3.56,0,0,1,0-3.73L124,46.2a4.77,4.77,0,0,1,8,0l87.44,151.87A3.56,3.56,0,0,1,219.46,201.8ZM116,136V104a12,12,0,0,1,24,0v32a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,176Z');
// FileJs — marks the CVO studio (HTML + JavaScript), distinct from the plain
// </> ICON_CODE that marks the Extended Code editor.
export const ICON_FILE_HTML = ph('M48,128a12,12,0,0,0,12-12V44h76V92a12,12,0,0,0,12,12h48v12a12,12,0,0,0,24,0V88a12,12,0,0,0-3.51-8.49l-56-56A12,12,0,0,0,152,20H56A20,20,0,0,0,36,40v76A12,12,0,0,0,48,128ZM183,80H160V57ZM68,160v48a12,12,0,0,1-24,0V196H32v12a12,12,0,0,1-24,0V160a12,12,0,0,1,24,0v12H44V160a12,12,0,0,1,24,0Zm60,0a12,12,0,0,1-12,12h-4v36a12,12,0,0,1-24,0V172H84a12,12,0,0,1,0-24h32A12,12,0,0,1,128,160Zm72,0v48a12,12,0,0,1-24,0v-9.36l-.11.16a12,12,0,0,1-19.78,0l-.11-.16V208a12,12,0,0,1-24,0V160a12,12,0,0,1,21.89-6.8L166,170.82l12.11-17.62A12,12,0,0,1,200,160Zm56,48a12,12,0,0,1-12,12H220a12,12,0,0,1-12-12V160a12,12,0,0,1,24,0v36h12A12,12,0,0,1,256,208Z');
export const ICON_FILE_JS = ph('M216.49,79.51l-56-56A12,12,0,0,0,152,20H56A20,20,0,0,0,36,40v68a12,12,0,0,0,24,0V44h76V92a12,12,0,0,0,12,12h48V212H180a12,12,0,0,0,0,24h20a20,20,0,0,0,20-20V88A12,12,0,0,0,216.49,79.51ZM160,57l23,23H160Zm-4.22,139.85a24.75,24.75,0,0,1-10.95,18.06c-6,4-13.27,5.15-19.73,5.15a63.75,63.75,0,0,1-16.23-2.21,12,12,0,0,1,6.46-23.12c6.81,1.86,15,1.61,16.39.06a2.48,2.48,0,0,0,.21-.71c-1.94-1.23-6.83-2.64-9.88-3.52-5.39-1.56-11-3.18-15.75-6.27-7.62-4.92-11.21-12.45-10.11-21.2a24.45,24.45,0,0,1,10.69-17.75c6.06-4.09,14.17-5.84,24.1-5.18A68.53,68.53,0,0,1,143,142a12,12,0,0,1-6.1,23.21c-6.36-1.63-13.62-1.51-16.07-.33a79.5,79.5,0,0,0,7.91,2.59c5.48,1.58,11.68,3.37,16.8,6.82C153.33,179.55,157,187.55,155.78,196.82ZM84,152v38a30,30,0,0,1-60,0,12,12,0,0,1,24,0,6,6,0,0,0,12,0V152a12,12,0,0,1,24,0Z');
export const ICON_LIGHTNING = ph('M219.71,117.38a12,12,0,0,0-7.25-8.52L161.28,88.39l10.59-70.61a12,12,0,0,0-20.64-10l-112,120a12,12,0,0,0,4.31,19.33l51.18,20.47L84.13,238.22a12,12,0,0,0,20.64,10l112-120A12,12,0,0,0,219.71,117.38ZM113.6,203.55l6.27-41.77a12,12,0,0,0-7.41-12.92L68.74,131.37,142.4,52.45l-6.27,41.77a12,12,0,0,0,7.41,12.92l43.72,17.49Z');
// ── Flow-walker code-prop icons. Each input/transport code property runs at a
// different trigger; the icon encodes the trigger so identical EC previews are
// distinguishable at a glance. expression→lightning (runs on the action),
// initExpression→arrow-square-in (on load), afterExpression→ICON_ARROW_OUT
// (re-runs after value change), showExpression→eye-slash (visibility gate),
// enableExpression→subtitles-slash (enabled gate), defaultExpression→code-block.
export const ICON_ARROW_SQUARE_IN = ph('M132,136v64a12,12,0,0,1-24,0V165L48.49,224.49a12,12,0,0,1-17-17L91,148H56a12,12,0,0,1,0-24h64A12,12,0,0,1,132,136ZM208,28H80A20,20,0,0,0,60,48V92a12,12,0,0,0,24,0V52H204V172H164a12,12,0,0,0,0,24h44a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28Z');
export const ICON_EYE_SLASH = ph('M56.88,31.93A12,12,0,1,0,39.12,48.07l16,17.65C20.67,88.66,5.72,121.58,5,123.13a12.08,12.08,0,0,0,0,9.75c.37.82,9.13,20.26,28.49,39.61C59.37,198.34,92,212,128,212a131.34,131.34,0,0,0,51-10l20.09,22.1a12,12,0,0,0,17.76-16.14ZM128,188c-29.59,0-55.47-10.73-76.91-31.88A130.69,130.69,0,0,1,29.52,128c5.27-9.31,18.79-29.9,42-44.29l90.09,99.11A109.33,109.33,0,0,1,128,188Zm123-55.12c-.36.81-9,20-28,39.16a12,12,0,1,1-17-16.9A130.48,130.48,0,0,0,226.48,128a130.36,130.36,0,0,0-21.57-28.12C183.46,78.73,157.59,68,128,68c-3.35,0-6.7.14-10,.42a12,12,0,1,1-2-23.91c3.93-.34,8-.51,12-.51,36,0,68.63,13.67,94.49,39.52,19.35,19.35,28.11,38.8,28.48,39.61A12.08,12.08,0,0,1,251,132.88Z');
export const ICON_SUBTITLES_SLASH = ph('M48,128a12,12,0,0,1,12-12H76a12,12,0,0,1,0,24H60A12,12,0,0,1,48,128Zm168.88,79.93a12,12,0,1,1-17.76,16.14l-11-12.07H32a20,20,0,0,1-20-20V64A20,20,0,0,1,32,44h4.68a12,12,0,0,1,20.2-12.07ZM166.33,188l-10.91-12H60a12,12,0,0,1,0-24h73.6l-10.91-12H116a12,12,0,0,1-10.1-18.47L57.24,68H36V188ZM224,44H116.6a12,12,0,0,0,0,24H220V182.94a12,12,0,0,0,24,0V64A20,20,0,0,0,224,44Zm-28,96a12,12,0,0,0,0-24H182.06a12,12,0,0,0,0,24Z');
export const ICON_CODE_BLOCK = ph('M51.51,104.49l-32-32a12,12,0,0,1,0-17l32-32a12,12,0,1,1,17,17L45,64,68.49,87.51a12,12,0,0,1-17,17Zm48,0a12,12,0,0,0,17,0l32-32a12,12,0,0,0,0-17l-32-32a12,12,0,1,0-17,17L123,64,99.51,87.51A12,12,0,0,0,99.51,104.49ZM200,36H180a12,12,0,0,0,0,24h16V196H60V140a12,12,0,0,0-24,0v60a20,20,0,0,0,20,20H200a20,20,0,0,0,20-20V56A20,20,0,0,0,200,36Z');
// Key — leads the input *.key binding line in the flow walker. Rendered white
// (--text-1) so the binding identifier reads as primary, not muted metadata.
export const ICON_KEY = ph('M196,76a16,16,0,1,1-16-16A16,16,0,0,1,196,76Zm48,22.74A84.3,84.3,0,0,1,160.11,180H160a83.52,83.52,0,0,1-23.65-3.38l-7.86,7.87A12,12,0,0,1,120,188H108v12a12,12,0,0,1-12,12H84v12a12,12,0,0,1-12,12H40a20,20,0,0,1-20-20V187.31a19.86,19.86,0,0,1,5.86-14.14l53.52-53.52A84,84,0,1,1,244,98.74ZM202.43,53.57A59.48,59.48,0,0,0,158,36c-32,1-58,27.89-58,59.89a59.69,59.69,0,0,0,4.2,22.19,12,12,0,0,1-2.55,13.21L44,189v23H60V200a12,12,0,0,1,12-12H84V176a12,12,0,0,1,12-12h19l9.65-9.65a12,12,0,0,1,13.22-2.55A59.58,59.58,0,0,0,160,156h.08c32,0,58.87-26.07,59.89-58A59.55,59.55,0,0,0,202.43,53.57Z');
export const ICON_PENCIL = ph('M230.14,70.54,185.46,25.85a20,20,0,0,0-28.29,0L33.86,149.17A19.85,19.85,0,0,0,28,163.31V208a20,20,0,0,0,20,20H92.69a19.86,19.86,0,0,0,14.14-5.86L230.14,98.82a20,20,0,0,0,0-28.28ZM91,204H52V165l84-84,39,39ZM192,103,153,64l18.34-18.34,39,39Z');
export const ICON_TABLE = ph('M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM32,80H88v40H32Zm72,0H224v40H104ZM32,136H88v40H32Zm72,0H224v40H104Z');
// Bar chart — custom glyph in the Phosphor Bold fill weight (Phosphor's core set has no chart icon).
// Three rising bars on a baseline; used as the widget-type icon for *Chart classes in the result view.
export const ICON_CHART = ph('M52,144H92V196H52ZM108,104H148V196H108ZM164,64H204V196H164ZM44,196H212V212H44Z');
export const ICON_ARROW_OUT = ph('M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z');
// ArrowsOutSimple / ArrowsInSimple — the maximize ↔ restore toggle pair for
// the editor output panel. The icon always shows what CLICKING will do:
// arrows-out = maximize, arrows-in = restore.
export const ICON_ARROWS_OUT_SIMPLE = ph('M220,48V96a12,12,0,0,1-24,0V77l-39.51,39.52a12,12,0,0,1-17-17L179,60H160a12,12,0,0,1,0-24h48A12,12,0,0,1,220,48ZM99.51,139.51,60,179V160a12,12,0,0,0-24,0v48a12,12,0,0,0,12,12H96a12,12,0,0,0,0-24H77l39.52-39.51a12,12,0,0,0-17-17Z');
export const ICON_ARROWS_IN_SIMPLE = ph('M216.49,56.48,177,96h19a12,12,0,0,1,0,24H148a12,12,0,0,1-12-12V60a12,12,0,0,1,24,0V79l39.51-39.52a12,12,0,0,1,17,17ZM108,136H60a12,12,0,0,0,0,24H79L39.51,199.51a12,12,0,0,0,17,17L96,177v19a12,12,0,0,0,24,0V148A12,12,0,0,0,108,136Z');
// Phosphor Fill "Tornado" — the inspector mascot. Used as the header
// brand mark. Rendered at 16px (one notch up from the 14px icons) so the
// stacked-bar silhouette reads clearly at small sizes.
// The brand mark — Ionicons 'aperture-sharp' (ion:aperture-sharp via
// iconify), replacing the earlier Phosphor duotone aperture.
export const ICON_APERTURE = '<svg width="16" height="16" viewBox="0 0 512 512" fill="currentColor"><path d="m216 48l129.49 128.18V48zm-34.53 10.38L80 134h176zM336 344h128V216zm118-162L378 80v176zM48 166v128l128-128zm282 288l102-76H256zM58 330l76 102V256zm287.49-107.88l-55.55-55.46h-67.88l-55.55 55.46v67.76l55.62 55.52c.44 0 .88-.06 1.33-.06h66.48l55.55-55.46ZM165.98 336.09L166 464h128z"/></svg>';


// ── Custom icons (Lucide/Feather style, 12×12, stroke) ──────────

export const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
export const ICON_REFRESH = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
export const ICON_ARROW_LEFT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
// F2 revert arrow (Phosphor arrow-u-down-left feel): a U-turn arrow whose head points down-left —
// the "reset this override back to the template" affordance. Stroke style to match the set.
export const ICON_REVERT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 14 4 19"/><path d="M4 14l4.5 4.5A7 7 0 1 0 7 7l-2 2"/></svg>';
// Phosphor "arrow-line-up" shape (up arrow with a line across the top), drawn in
// the feather/stroke style of this set so it sits cleanly beside the back arrow.
export const ICON_ARROW_LINE_UP = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="3" x2="19" y2="3"/><line x1="12" y1="21" x2="12" y2="8"/><polyline points="6 14 12 8 18 14"/></svg>';
export const ICON_BOOK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M9 6h7"/><path d="M9 10h7"/></svg>';

// ── Custom icons (14×14, stroke) ────────────────────────────────

// Phosphor "paint-brush" (bold) — the style/paint glyph everywhere a single-colour mark fits
// (wordmark, mode switch, sidepanel paint format).
export const ICON_PAINT = ph('M236,32a12,12,0,0,0-12-12c-44.78,0-90,48.54-115.9,82a64,64,0,0,0-80,62c0,12-3.1,22.71-9.23,31.76A43,43,0,0,1,9.4,206.05a11.88,11.88,0,0,0-4.91,13.38A12.07,12.07,0,0,0,16.11,228h76A64,64,0,0,0,154,148C187.49,122.05,236,76.8,236,32ZM209.62,46.39c-4,12.92-13.15,27.49-26.92,42.91-3,3.39-6.16,6.7-9.35,9.89a104.31,104.31,0,0,0-16.5-16.51c3.19-3.19,6.49-6.32,9.88-9.35C182.15,59.55,196.71,50.43,209.62,46.39ZM92.07,204H42a80.17,80.17,0,0,0,10.14-40,40,40,0,1,1,40,40Zm38.18-91.32c3.12-3.93,6.55-8.09,10.23-12.35a80.52,80.52,0,0,1,15.23,15.24c-4.26,3.68-8.42,7.11-12.35,10.23A64.43,64.43,0,0,0,130.25,112.68Z', 14);
// Crosshair — picker affordance for the Page-tab context selector. Reads more
// "pick a target" than the paintbrush (which implies "apply a style").
export const ICON_CROSSHAIR = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>';
export const ICON_EYE_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
// Chevron — disclosure twisty. Points right when collapsed; CSS rotates it 90°
// when open. Cleaner than a text ▸/▾.
export const ICON_CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
// Shield — "Test access" / permission affordance.
export const ICON_SHIELD = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
// Status icons for verdicts (access trace etc.) — a circled glyph reads as a
// proper status indicator, unlike a bare text ✗/✓.
export const ICON_X_CIRCLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
export const ICON_CHECK_CIRCLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
export const ICON_EYE_CLOSED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
// MinusCircle — the neutral / indeterminate verdict in the access trace, the
// third state beside ICON_CHECK_CIRCLE / ICON_X_CIRCLE (replaces the text –).
export const ICON_MINUS_CIRCLE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
// Loader arc (three-quarter circle). Spins via CSS (`animation: <spin> linear
// infinite` on the host) — replaces the text ⏳ loading glyph.
export const ICON_SPINNER = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

// ── Section / banner icons (Lucide, 12×12 stroke) ───────────────

export const ICON_LINK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
// Columns — leads the "Layout" section title.
export const ICON_LAYOUT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/></svg>';
// Blueprint mark — Phosphor Bold "blueprint" (a drafting sheet with a plan
// drawing). Used for the blueprint toggle + the overlay hero.
export const ICON_BLUEPRINT = ph('M232,48H76V40A12,12,0,0,0,64,28H48A36,36,0,0,0,12,64V176a36,36,0,0,0,36,36H232a12,12,0,0,0,12-12V60A12,12,0,0,0,232,48ZM36,64A12,12,0,0,1,48,52h4v88H48a35.59,35.59,0,0,0-12,2.06ZM220,188H48a12,12,0,0,1,0-24H64a12,12,0,0,0,12-12V72H220ZM104,136a12,12,0,0,0,0,24h12v4a12,12,0,0,0,24,0v-4h16v4a12,12,0,0,0,24,0v-4h12a12,12,0,0,0,0-24H180V124h12a12,12,0,0,0,0-24H180V96a12,12,0,0,0-24,0v4H140V96a12,12,0,0,0-24,0v4H104a12,12,0,0,0,0,24h12v12Zm36-12h16v12H140Z', 13);

// ── Star icons (Phosphor, 12×12) ────────────────────────────────

export const ICON_STAR_FILLED = '<svg width="12" height="12" viewBox="0 0 256 256" fill="currentColor"><path d="M234.29,114.85l-45,38.83L203,211.75a16.4,16.4,0,0,1-24.5,17.82L128,198.49,77.47,229.57A16.4,16.4,0,0,1,53,211.75l13.76-58.07-45-38.83A16.46,16.46,0,0,1,31.08,91l59.46-5.15,23.21-55.36a16.4,16.4,0,0,1,30.5,0l23.21,55.36L226.92,91a16.46,16.46,0,0,1,7.37,23.85Z"/></svg>';
export const ICON_STAR_HOLLOW = '<svg width="12" height="12" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="16"><path d="M128,189.09l54.72,33.65a8.4,8.4,0,0,0,12.52-9.17l-14.88-62.79,48.7-42A8.46,8.46,0,0,0,224.27,95L159.36,89.4,135,29.94a8.36,8.36,0,0,0-15.56,0L96.64,89.4,31.73,95a8.46,8.46,0,0,0-4.79,14.83l48.7,42L60.76,214.57a8.4,8.4,0,0,0,12.52,9.17Z"/></svg>';

// Eyedropper / pipette — "sample a widget's style" (the brush's pick state).
export const ICON_EYEDROPPER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>';
// Sliders — the paintbrush "setup" (choose which props the brush copies).
export const ICON_SLIDERS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" x2="14" y1="6" y2="6"/><line x1="10" x2="3" y1="6" y2="6"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="18" y2="18"/><line x1="12" x2="3" y1="18" y2="18"/><line x1="14" x2="14" y1="4" y2="8"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="16" y2="20"/></svg>';
// Save / diskette — store the held style as a named preset.
export const ICON_SAVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';

// Phosphor "paint-brush" (duotone) — the Paint tile's glyph: the .2-opacity secondary path gives it
// body at corner size without a heavy solid fill. Inherits currentColor for both layers.
export const ICON_PAINTBRUSH_DUO = '<svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M224,32c0,32.81-31.64,67.43-58.64,91.05A84.39,84.39,0,0,0,133,90.64C156.57,63.64,191.19,32,224,32Z" opacity=".2"/><path d="M232,32a8,8,0,0,0-8-8c-44.08,0-89.31,49.71-114.43,82.63A60,60,0,0,0,32,164c0,30.88-19.54,44.73-20.47,45.37A8,8,0,0,0,16,224H92a60,60,0,0,0,57.37-77.57C182.3,121.31,232,76.08,232,32ZM92,208H34.63C41.38,198.41,48,183.92,48,164a44,44,0,1,1,44,44Zm32.42-94.45q5.14-6.66,10.09-12.55A76.23,76.23,0,0,1,155,121.49q-5.9,4.94-12.55,10.09A60.54,60.54,0,0,0,124.42,113.55Zm42.7-2.68a92.57,92.57,0,0,0-22-22c31.78-34.53,55.75-45,69.9-47.91C212.17,55.12,201.65,79.09,167.12,110.87Z"/></svg>';

// ── Type-badge glyphs (Phosphor Bold, 12×12 fill) ───────────────
// One icon per BMP type in the domain-aware badge map (see lib/type-badge.ts).
// Icon carries role, tile colour carries domain. Reused constants above cover
// the rest (table/chart/code/pencil/play/list/clock/variable/lightning/…).
export const ICON_BUILDINGS = ph('M240,204H228V96a20,20,0,0,0-20-20H172V32a20,20,0,0,0-28.45-18.12l-104,48.54A20.06,20.06,0,0,0,28,80.55V204H16a12,12,0,0,0,0,24H240a12,12,0,0,0,0-24ZM204,100V204H172V100ZM52,83.09,148,38.3V204H52ZM132,112v12a12,12,0,0,1-24,0V112a12,12,0,0,1,24,0Zm-40,0v12a12,12,0,0,1-24,0V112a12,12,0,0,1,24,0Zm0,52v12a12,12,0,0,1-24,0V164a12,12,0,0,1,24,0Zm40,0v12a12,12,0,0,1-24,0V164a12,12,0,0,1,24,0Z');
export const ICON_BROWSER = ph('M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36Zm-4,24V84H44V60ZM44,196V108H212v88Z');
export const ICON_CARDS_THREE = ph('M208,96H48a20,20,0,0,0-20,20v84a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V116A20,20,0,0,0,208,96Zm-4,100H52V120H204ZM44,68A12,12,0,0,1,56,56H200a12,12,0,0,1,0,24H56A12,12,0,0,1,44,68ZM60,28A12,12,0,0,1,72,16H184a12,12,0,0,1,0,24H72A12,12,0,0,1,60,28Z');
export const ICON_CARDHOLDER = ph('M208,44H48A28,28,0,0,0,20,72V184a28,28,0,0,0,28,28H208a28,28,0,0,0,28-28V72A28,28,0,0,0,208,44ZM48,68H208a4,4,0,0,1,4,4V88H160a12,12,0,0,0-12,12,20,20,0,0,1-40,0A12,12,0,0,0,96,88H44V72A4,4,0,0,1,48,68ZM208,188H48a4,4,0,0,1-4-4V112H85.66a44,44,0,0,0,84.68,0H212v72A4,4,0,0,1,208,188Z');
export const ICON_TRAY = ph('M208,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28Zm-4,24v92H179.31a19.86,19.86,0,0,0-14.14,5.86L147,168H109L90.83,149.86A19.86,19.86,0,0,0,76.69,144H52V52ZM52,204V168H75l18.14,18.14A19.86,19.86,0,0,0,107.31,192h41.38a19.86,19.86,0,0,0,14.14-5.86L181,168h23v36Z');
export const ICON_TRAY_ARROW_DOWN = ph('M208,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28Zm-4,24v92H179.31a19.86,19.86,0,0,0-14.14,5.86L147,168H109L90.83,149.86A19.86,19.86,0,0,0,76.69,144H52V52ZM52,204V168H75l18.14,18.14A19.86,19.86,0,0,0,107.31,192h41.38a19.86,19.86,0,0,0,14.14-5.86L181,168h23v36Zm35.51-87.51a12,12,0,0,1,17-17L116,111V76a12,12,0,0,1,24,0v35l11.51-11.52a12,12,0,0,1,17,17l-32,32a12,12,0,0,1-17,0Z');
export const ICON_CONTAINER = ph('M237.5,66.8,131.3,36.46a12.07,12.07,0,0,0-5-.34l-105.13,15A20.1,20.1,0,0,0,4,70.94V185.06a20.1,20.1,0,0,0,17.17,19.8l105.13,15a12.15,12.15,0,0,0,1.7.12,12,12,0,0,0,3.3-.46L237.5,189.2A20.09,20.09,0,0,0,252,170V86A20.08,20.08,0,0,0,237.5,66.8ZM92,116H84V66.41l32-4.57V194.16l-32-4.57V140h8a12,12,0,0,0,0-24ZM28,74.41l32-4.57V116H52a12,12,0,0,0,0,24h8v46.16l-32-4.57ZM228,167l-88,25.14V63.91l88,25.14Z');
export const ICON_TABS = ph('M255.49,164.55l0-.06a.29.29,0,0,0,0-.09L233.2,90.25A19.87,19.87,0,0,0,214.05,76H204a12,12,0,0,0,0,24h7.07l16.8,56H196.93L177.2,90.25A19.87,19.87,0,0,0,158.05,76H148a12,12,0,0,0,0,24h7.07l16.8,56H140.93L121.2,90.25A19.87,19.87,0,0,0,102.05,76H42A19.87,19.87,0,0,0,22.8,90.25L.55,164.4a.29.29,0,0,0,0,.09l0,.06a5.68,5.68,0,0,0-.16.62A12,12,0,0,0,12,180H244a12,12,0,0,0,11.49-15.45ZM44.93,100H99.07l16.8,56H28.13Z');
export const ICON_FOLDER = ph('M216,68H133.39l-26-29.29a20,20,0,0,0-15-6.71H40A20,20,0,0,0,20,52V200.62A19.41,19.41,0,0,0,39.38,220H216.89A19.13,19.13,0,0,0,236,200.89V88A20,20,0,0,0,216,68ZM44,56H90.61l10.67,12H44ZM212,196H44V92H212Z');
export const ICON_COMPASS = ph('M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212ZM163.27,77l-56,24a12,12,0,0,0-6.3,6.3l-24,56A12,12,0,0,0,92.73,179l56-24a12,12,0,0,0,6.3-6.3l24-56A12,12,0,0,0,163.27,77Zm-28.41,57.89-24,10.29,10.29-24,24-10.29Z');
export const ICON_STACK = ph('M234.36,170A12,12,0,0,1,230,186.37l-96,56a12,12,0,0,1-12.1,0l-96-56a12,12,0,0,1,12.09-20.74l90,52.48L218,165.63A12,12,0,0,1,234.36,170ZM218,117.63,128,170.11,38.05,117.63A12,12,0,0,0,26,138.37l96,56a12,12,0,0,0,12.1,0l96-56A12,12,0,0,0,218,117.63ZM20,80a12,12,0,0,1,6-10.37l96-56a12.06,12.06,0,0,1,12.1,0l96,56a12,12,0,0,1,0,20.74l-96,56a12,12,0,0,1-12.1,0l-96-56A12,12,0,0,1,20,80Zm35.82,0L128,122.11,200.18,80,128,37.89Z');
export const ICON_GAUGE = ph('M209.88,69.83A115.19,115.19,0,0,0,128,36h-.41C63.85,36.22,12,88.76,12,153.13V176a20,20,0,0,0,20,20H224a20,20,0,0,0,20-20V152A115.25,115.25,0,0,0,209.88,69.83ZM220,172H127.32l46.44-65A12,12,0,1,0,154.24,93L97.82,172H36V153.13c0-1.72,0-3.43.14-5.13H56a12,12,0,0,0,0-24H40.62c10.91-33.39,40-58.52,75.38-63.21V80a12,12,0,0,0,24,0V60.8A92,92,0,0,1,215.66,124H200a12,12,0,0,0,0,24h19.9c.06,1.33.1,2.66.1,4Z');
export const ICON_WARNING_CIRCLE = ph('M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Zm-12-80V80a12,12,0,0,1,24,0v52a12,12,0,0,1-24,0Zm28,40a16,16,0,1,1-16-16A16,16,0,0,1,144,172Z');
export const ICON_CHART_LINE_UP = ph('M236,208a12,12,0,0,1-12,12H32a12,12,0,0,1-12-12V48a12,12,0,0,1,24,0v99l43.51-43.52a12,12,0,0,1,17,0L128,127l43-43H160a12,12,0,0,1,0-24h40a12,12,0,0,1,12,12v40a12,12,0,0,1-24,0V101l-51.51,51.52a12,12,0,0,1-17,0L96,129,44,181v15H224A12,12,0,0,1,236,208Z');
// Terminal-window — the Extended Code editor surface (replaces the lightning
// in the header; lightning stays the per-slot 'expression' glyph).
export const ICON_TERMINAL_WINDOW = ph('M72.5,150.63,100.79,128,72.5,105.37a12,12,0,1,1,15-18.74l40,32a12,12,0,0,1,0,18.74l-40,32a12,12,0,0,1-15-18.74ZM144,172h32a12,12,0,0,0,0-24H144a12,12,0,0,0,0,24ZM236,56V200a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V56A20,20,0,0,1,40,36H216A20,20,0,0,1,236,56Zm-24,4H44V196H212Z', 14);
// Paint-brush-broad — the Paint Format mode glyph (broad brush reads better
// at 14px than the slim artist brush).
export const ICON_PAINT_BROAD = ph('M216,20H72A44.05,44.05,0,0,0,28,64v72a28,28,0,0,0,28,28H95.64L92,207c0,.33,0,.67,0,1a36,36,0,0,0,72,0c0-.33,0-.67,0-1l-3.6-43H200a28,28,0,0,0,28-28V32A12,12,0,0,0,216,20ZM72,44h88V68a12,12,0,0,0,24,0V44h20V96H52V64A20,20,0,0,1,72,44Zm128,96H156a20,20,0,0,0-19.85,22.4l3.84,46a12,12,0,0,1-24,0l3.84-46A20,20,0,0,0,100,140H56a4,4,0,0,1-4-4V120H204v16A4,4,0,0,1,200,140Z', 14);
// Arrow-fat-line-right — the FLOW sub-badge on inspect labels: "this widget
// has a chain to walk" (InputView→InputSet, ActionButton→action, …).
export const ICON_ARROW_FAT_LINE = ph('M240.49,119.51l-96-96A12,12,0,0,0,124,32V68H80A12,12,0,0,0,68,80v96a12,12,0,0,0,12,12h44v36a12,12,0,0,0,20.49,8.49l96-96A12,12,0,0,0,240.49,119.51ZM148,195V176a12,12,0,0,0-12-12H92V92h44a12,12,0,0,0,12-12V61l67,67ZM52,80v96a12,12,0,0,1-24,0V80a12,12,0,0,1,24,0Z');
// Pulse — the status-bar latency meter glyph.
export const ICON_PULSE = ph('M244,128a12,12,0,0,1-12,12H207.42l-36.69,73.37A12,12,0,0,1,160,220h-.6a12,12,0,0,1-10.61-7.72L95,71.15,66.92,133A12,12,0,0,1,56,140H24a12,12,0,0,1,0-24H48.27L85.08,35a12,12,0,0,1,22.13.7l54.28,142.46,27.78-55.56A12,12,0,0,1,200,116h32A12,12,0,0,1,244,128Z');
export const ICON_ARROW_ELBOW_UP = ph('M244,192a12,12,0,0,1-12,12H88a12,12,0,0,1-12-12V77L48.49,104.49a12,12,0,0,1-17-17l48-48a12,12,0,0,1,17,0l48,48a12,12,0,0,1-17,17L100,77V180H232A12,12,0,0,1,244,192Z');
export const ICON_FLOW_ARROW = ph('M248.49,71.51l-32-32a12,12,0,0,0-17,17L211,68h-3c-52,0-64.8,30.71-75.08,55.38-8.82,21.17-15.45,37.05-42.75,40.09a44,44,0,1,0,.28,24.08c43.34-3.87,55.07-32,64.63-54.93C164.9,109,172,92,208,92h3l-11.52,11.51a12,12,0,0,0,17,17l32-32A12,12,0,0,0,248.49,71.51ZM48,196a20,20,0,1,1,20-20A20,20,0,0,1,48,196Z');
export const ICON_ARROW_BEND_UP_LEFT = ph('M236,200a12,12,0,0,1-24,0,84.09,84.09,0,0,0-84-84H61l27.52,27.51a12,12,0,0,1-17,17l-48-48a12,12,0,0,1,0-17l48-48a12,12,0,0,1,17,17L61,92h67A108.12,108.12,0,0,1,236,200Z');
export const ICON_ARROW_LEFT_PH = ph('M228,128a12,12,0,0,1-12,12H69l51.52,51.51a12,12,0,0,1-17,17l-72-72a12,12,0,0,1,0-17l72-72a12,12,0,0,1,17,17L69,116H216A12,12,0,0,1,228,128Z');
export const ICON_DOTS_THREE_V = ph('M112,60a16,16,0,1,1,16,16A16,16,0,0,1,112,60Zm16,52a16,16,0,1,0,16,16A16,16,0,0,0,128,112Zm0,68a16,16,0,1,0,16,16A16,16,0,0,0,128,180Z');
export const ICON_CUBE = ph('M225.6,62.64l-88-48.17a19.91,19.91,0,0,0-19.2,0l-88,48.17A20,20,0,0,0,20,80.19v95.62a20,20,0,0,0,10.4,17.55l88,48.17a19.89,19.89,0,0,0,19.2,0l88-48.17A20,20,0,0,0,236,175.81V80.19A20,20,0,0,0,225.6,62.64ZM128,36.57,200,76,128,115.4,56,76ZM44,96.79l72,39.4v76.67L44,173.44Zm96,116.07V136.19l72-39.4v76.65Z');

// ── Type-badge glyphs (Bold) — added for expanded type coverage ──
// Group icons: scorecard-tree, forms (note-pencil), status (circle).
// Individual: DescriptionView (article), ImageView (image), PdfView (file-pdf).
// Enterprise (Ce*): boules.
export const ICON_TREE_STRUCTURE = ph('M160,116h48a20,20,0,0,0,20-20V48a20,20,0,0,0-20-20H160a20,20,0,0,0-20,20V60H128a28,28,0,0,0-28,28v28H76v-4A20,20,0,0,0,56,92H24A20,20,0,0,0,4,112v32a20,20,0,0,0,20,20H56a20,20,0,0,0,20-20v-4h24v28a28,28,0,0,0,28,28h12v12a20,20,0,0,0,20,20h48a20,20,0,0,0,20-20V160a20,20,0,0,0-20-20H160a20,20,0,0,0-20,20v12H128a4,4,0,0,1-4-4V88a4,4,0,0,1,4-4h12V96A20,20,0,0,0,160,116ZM52,140H28V116H52Zm112,24h40v40H164Zm0-112h40V92H164Z');
export const ICON_NOTE_PENCIL = ph('M232.49,55.51l-32-32a12,12,0,0,0-17,0l-96,96A12,12,0,0,0,84,128v32a12,12,0,0,0,12,12h32a12,12,0,0,0,8.49-3.51l96-96A12,12,0,0,0,232.49,55.51ZM192,49l15,15L196,75,181,60Zm-69,99H108V133l56-56,15,15Zm105-7.43V208a20,20,0,0,1-20,20H48a20,20,0,0,1-20-20V48A20,20,0,0,1,48,28h67.43a12,12,0,0,1,0,24H52V204H204V140.57a12,12,0,0,1,24,0Z');
export const ICON_CIRCLE = ph('M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm0,192a84,84,0,1,1,84-84A84.09,84.09,0,0,1,128,212Z');
export const ICON_ARTICLE = ph('M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36Zm-4,160H44V60H212ZM68,92A12,12,0,0,1,80,80h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,92Zm0,36a12,12,0,0,1,12-12h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,128Zm0,36a12,12,0,0,1,12-12h96a12,12,0,0,1,0,24H80A12,12,0,0,1,68,164Z');
export const ICON_IMAGE = ph('M144,96a16,16,0,1,1,16,16A16,16,0,0,1,144,96Zm92-40V200a20,20,0,0,1-20,20H40a20,20,0,0,1-20-20V56A20,20,0,0,1,40,36H216A20,20,0,0,1,236,56ZM44,60v79.72l33.86-33.86a20,20,0,0,1,28.28,0L147.31,147l17.18-17.17a20,20,0,0,1,28.28,0L212,149.09V60Zm0,136H162.34L92,125.66l-48,48Zm168,0V183l-33.37-33.37L164.28,164l32,32Z');
export const ICON_FILE_PDF = ph('M200,164v8h12a12,12,0,0,1,0,24H200v12a12,12,0,0,1-24,0V152a12,12,0,0,1,12-12h32a12,12,0,0,1,0,24ZM92,172a32,32,0,0,1-32,32H56v4a12,12,0,0,1-24,0V152a12,12,0,0,1,12-12H60A32,32,0,0,1,92,172Zm-24,0a8,8,0,0,0-8-8H56v16h4A8,8,0,0,0,68,172Zm100,8a40,40,0,0,1-40,40H112a12,12,0,0,1-12-12V152a12,12,0,0,1,12-12h16A40,40,0,0,1,168,180Zm-24,0a16,16,0,0,0-16-16h-4v32h4A16,16,0,0,0,144,180ZM36,108V40A20,20,0,0,1,56,20h96a12,12,0,0,1,8.49,3.52l56,56A12,12,0,0,1,220,88v20a12,12,0,0,1-24,0v-4H148a12,12,0,0,1-12-12V44H60v64a12,12,0,0,1-24,0ZM160,57V80h23Z');
export const ICON_BOULES = ph('M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm50.28,40.75L60.75,178.28a84.87,84.87,0,0,1-8.36-13.7L164.58,52.39A84.87,84.87,0,0,1,178.28,60.75Zm17,17a84.87,84.87,0,0,1,8.36,13.7L91.42,203.61a84.87,84.87,0,0,1-13.7-8.36ZM128,44a84.53,84.53,0,0,1,10.37.66L44.66,138.37A83.87,83.87,0,0,1,128,44Zm0,168a84.53,84.53,0,0,1-10.37-.66l93.71-93.71A83.87,83.87,0,0,1,128,212Z');

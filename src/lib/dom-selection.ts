/** Best-effort caret placement for editable DOM that may be synchronously replaced by focus hooks. */
export function moveCaretToEnd(field: HTMLElement): boolean {
  if (!field.isConnected) return false;
  try {
    const range = document.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    const selection = document.getSelection();
    if (!selection || !field.isConnected) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    // A BMP rerender can detach the field between focus and selection.
    return false;
  }
}

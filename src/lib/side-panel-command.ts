/** Open Companion from its keyboard command.
 *
 * Chrome treats a normal extension command as a user gesture, which permits
 * sidePanel.open(). The reserved `_execute_action` shortcut only triggers the
 * action; in current Chrome it does not consistently apply
 * openPanelOnActionClick, even though a real toolbar click does. */
export async function openSidePanelFromCommand(commandTab?: Pick<chrome.tabs.Tab, 'id'>): Promise<boolean> {
  const tabId = commandTab?.id ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId == null) return false;
  await chrome.sidePanel.open({ tabId });
  return true;
}

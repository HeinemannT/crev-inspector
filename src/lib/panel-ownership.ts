export interface PanelClaim {
  panelIncarnation: string;
  panelCreatedAt: number;
}

/** Decide whether an incoming panel document may own a Chrome window.
 * Reconnects from the same document are accepted; an older document can
 * never displace a newer one merely because its delayed port came back. */
export function shouldAcceptPanelClaim(current: PanelClaim | undefined, incoming: PanelClaim): boolean {
  if (!current || current.panelIncarnation === incoming.panelIncarnation) return true;
  if (incoming.panelCreatedAt !== current.panelCreatedAt) {
    return incoming.panelCreatedAt > current.panelCreatedAt;
  }
  // A deterministic tie-break handles the extremely unlikely case of two
  // panel documents created at the exact same high-resolution timestamp.
  return incoming.panelIncarnation > current.panelIncarnation;
}

/**
 * Presentation-only metadata for an inspect identity.
 *
 * The RID and enriched BMP type remain the object's authoritative identity.
 * These hints describe the DOM role of the host: a portal page link can look
 * like a Page without pretending that its backing object is a BMP `Page`
 * class, and a navigation marker can sit inline without changing every
 * overlay caller.
 */
export interface OverlayPresentation {
  /** Optional cosmetic class for surface-specific layout rules. */
  labelClassName?: string;
  /** Type whose icon/color represent the host's portal role. */
  visualType?: string;
  /** Inline navigation markers participate in the link's text flow. */
  placement?: 'inline-start';
  /** Always use the icon-only marker, independent of measured host width. */
  compact?: boolean;
}

export const PAGE_NAV_PRESENTATION: Readonly<OverlayPresentation> = {
  visualType: 'Page',
  placement: 'inline-start',
  compact: true,
};

export const ORGANISATION_NAV_PRESENTATION: Readonly<OverlayPresentation> = {
  visualType: 'Organisation',
  placement: 'inline-start',
  compact: true,
};

export const PAGE_HEADER_PRESENTATION: Readonly<OverlayPresentation> = {
  labelClassName: 'crev-page-label',
  visualType: 'Page',
};

export function resolvedOverlayType(
  objectType: string | undefined,
  presentation?: OverlayPresentation,
): string | undefined {
  return presentation?.visualType ?? objectType;
}

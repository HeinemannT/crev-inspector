/** Build Blueprint's private font declarations through an injected URL resolver. Keeping Chrome's
 * runtime object outside this module gives tests the same seam as production and makes an invalidated
 * extension context a normal empty result instead of an uncaught synchronous exception. */
export function blueprintFontFaceCss(resolveAssetUrl: (path: string) => string): string {
  try {
    const inter = (weight: number) => resolveAssetUrl(`assets/inter-${weight}.woff2`);
    const mono = resolveAssetUrl('assets/jetbrains-mono-400.woff2');
    return [400, 500, 600, 700]
      .map(weight => `@font-face{font-family:'BPInter';font-weight:${weight};font-display:swap;src:url('${inter(weight)}') format('woff2')}`)
      .join('')
      + `@font-face{font-family:'BPMono';font-weight:400;font-display:swap;src:url('${mono}') format('woff2')}`;
  } catch {
    return '';
  }
}

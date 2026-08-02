// Vite replaces this token for every production/watch build. Keeping the
// source fallback readable also makes direct unit-test imports harmless.
export const BUILD_ID = '__CREV_BUILD_ID__';

export function runtimeVersion(version: string): string {
  return `v${version} · ${BUILD_ID}`;
}

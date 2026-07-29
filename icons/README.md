# CREV Inspector icons

`crev-inspector.svg` is the editable source for the CREV Inspector mark.

The side-panel header loads that SVG directly. Chrome uses these PNG exports through `manifest.json`:

- `icon-16.png`
- `icon-32.png`
- `icon-48.png`
- `icon-128.png`

When the mark changes, export all four PNGs from the canonical SVG and inspect the 16 px and 32 px results at native size. Small browser icons need a visual check because correct dimensions do not guarantee readable edges or a clear center mark.

Do not recreate the logo as JavaScript geometry. Any future export helper should read `crev-inspector.svg` so the repository keeps one artwork source.

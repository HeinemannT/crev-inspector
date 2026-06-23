# Handover: CREV Inspector as a CVO development tool

**For:** the CREV Inspector expert.
**This is:** a direction + things we learned, not a spec. Design the actual approach yourself.

## What we'd like it to do

Today, building a CVO means: edit locally, bundle, push the `javascript` over GraphQL, reload the whole BMP page, find the widget. We want the extension to collapse that into a real dev loop. Suggestions, roughly in order of value:

- **Own-page sandbox.** Run a CVO on its own page (not the BMP portal) so you can develop it freely, with real or mocked data, without redeploying or navigating BMP.
- **Instant preview + seamless switch.** Build on save and re-render immediately. One toggle between "run my edit against the live BMP page" and "run it in the sandbox."
- **A proper editor.** Multi-file (CVOs are bundles), type-checking/lint (CVO errors are silent — a throw just blanks the widget), and autocomplete for the CVO API.
- **A resource/dependency panel.** List, upload, and version the FileResources a CVO depends on (charting libs, assets), and hand back the snippet to reference them.

## Why it's feasible (the one useful insight)

A CVO's whole contract with BMP is small: it gets one global, `_data` (the container element + the server-evaluated feeds), and talks to three endpoints — feeds, GraphQL writes, and resource download. Mock `_data` and proxy those three and a CVO runs anywhere, unchanged. The sandbox doesn't reimplement anything — it runs the real CVO with a stand-in `_data` and the network routed through the extension (which has the cookies/permissions a bare page lacks). That's the trick that makes the own-page sandbox real rather than a mock.

## Things to consider (learned this session)

- **Writing a FileResource's `content` has a footgun.** GraphQL `updateObjectBulk` on `content` *silently writes nothing* (succeeds, stores empty). It has to go through EC `.change(content := "name;mime;base64")`, and large payloads need the bridge, not an inline call. Worth baking into the tool so no one rediscovers it.
- **Reading resources is easy.** `/web/download?propName=content&rid=…` serves the decoded bytes with the right mime and no nosniff, so a hosted lib works directly as `<script src>`. (CVO `html`/`javascript`, unlike `content`, *are* normal GraphQL writes.)
- **Dependencies must be hosted in BMP, not a CDN** — BMP may be air-gapped.
- **Charts aren't guaranteed.** `window.Highcharts` only exists if a native chart widget is on the page; other libs must be self-provided (we just moved ECharts into a hosted resource). Scaffolds should guard and degrade rather than crash.
- **The hard unknown: general live-injection.** Re-running an *arbitrary* CVO's code against its live `_data` on the BMP page needs validation. For bundle-shaped CVOs it's easy (override the bootstrap global); the general case is the main thing to prototype early.

## Where to start

The own-page sandbox (mock `_data` + extension-proxied network) is the keystone — it gives you the sandbox, instant preview, and half the live/sandbox switch at once. The resource panel is the other high-value, standalone piece. The editor upgrades layer on top.

## Pointers

- **Worked reference:** ERMQ at `skills/bmp-platform/explorations/ermq/` — a real CVO (`host.js` + bundled parts + `push-ermq.mjs`), including the hosted-library change (commit `1847254`) that proves the resource pattern end-to-end.
- **Build on what's there:** the MAIN-world interceptor (already does fiber→RID and runs before the page), the service worker's BMP client (the privileged-fetch proxy), CodeMirror in `editor/`, plus `diff/`, `codesearch/`, `objectview/`. See `ARCHITECTURE.md`.
- **Deeper mechanics** (the `_data` shape, the exact endpoints, serving details) live in `skills/bmp-platform/reference/cvo-internals.md` and `cvo-design-strategy.md` if you want them.

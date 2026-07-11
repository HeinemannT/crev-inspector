# AI EC-correctness benchmark harness

Measures whether the chat pipeline's system prompt (persona + knowledge packs
+ context envelope, built by the REAL `src/lib/ai/prompt.ts` modules) yields
correct Extended Code from the configured model. Results + failure catalog:
`docs/ai-ec-benchmark.md`.

```bash
node bench/bundle.mjs        # esbuild-bundles build-prompts.ts (handles the
                             # Vite `?raw` pack imports) and writes
                             # bench/out/prompts.json — one real system prompt
                             # per config (selection envelope / no context /
                             # no context + live workspace primer)

DEEPSEEK_API_KEY=... node bench/run-bench.mjs
                             # one plain completion per (config, task), no
                             # tools, default temperature ->
                             # bench/out/results.json (replies, fenced
                             # snippets, usage, latency)
```

- The API key is read from `DEEPSEEK_API_KEY` only — never hardcode it.
- `tasks.mjs` — 22 tasks with live-computed reference answers (Steadfast
  workspace, 2026-07-11) in `expect`; regenerate those if the workspace moves.
- `out/primer.txt` — the `<workspace>` block captured by running the actual
  `PRIMER_EC` (src/lib/handlers/ai-primer.ts) through `ec_preview`.
- Verification of returned snippets is manual-by-agent: dry-run each with the
  `ec_preview` MCP tool (never `ec_execute`) and judge against `expect`.

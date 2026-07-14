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
- Legacy workspace-count and prose cases are judged against `expect`; the
  advanced synthetic slice below is executable and automatically graded.

## Advanced executable slice

Twelve synthetic, workspace-stable cases cover delimiter parsing, primitive and
nested JSON arrays, JSON mutation/escaping, union-vs-merge semantics, MAP
aggregation, table building, heterogeneous table safety, and scalar control-flow
results. Their reference programs and model replies can be graded automatically
through the same read-only bridge used by the integration suite:

```bash
CREV_SERVERS_FILE=/path/to/servers.json node bench/verify-bench.mjs --references

DEEPSEEK_API_KEY=... node bench/run-bench.mjs \
  --advanced --config=synthetic-scorecard --repeats=2 \
  --output=/tmp/ec-advanced.json
CREV_SERVERS_FILE=/path/to/servers.json node bench/verify-bench.mjs \
  --input=/tmp/ec-advanced.json
```

The default benchmark model is the extension default, `deepseek-v4-flash`.
Override it with `DEEPSEEK_MODEL` when comparing models. The verifier treats live
program execution as the primary grader and adds narrow static checks only for
intent that preview cannot prove. Neither script persists credentials.
`synthetic-scorecard` uses production prompt assembly with a fake URL and object
identity, so the provider run never receives private workspace context.
Use `--thinking=enabled|disabled` to compare DeepSeek modes; omitting it mirrors
the production request and accepts the provider default.

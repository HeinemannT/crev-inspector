# AI chat pipeline — EC-correctness benchmark

**Date:** 2026-07-11 · **Model:** `deepseek-chat` (OpenAI-compatible endpoint, default temperature, no tools) · **Workspace:** live Steadfast (`https://crev.theinemann.de/Steadfast/`) · **Verification:** every returned EC snippet dry-run with `ec_preview` (never `ec_execute`).

The benchmark drives the model with the **extension's real system prompts**, produced by importing `buildChatSystem` / `selectChatPacks` / `renderContext` / the bundled knowledge packs directly (no re-implementation). 22 tasks across string ops, list ops, control flow, object refs, class-vs-template, known traps, and 3 "explain this code" tasks. One plain chat completion per (config, task) — this tests the pure-knowledge path; the tool loop (`preview_ec` self-checking) is deliberately out of scope.

## Reproduce

```bash
node bench/bundle.mjs                      # build real system prompts -> bench/out/prompts.json
BENCH_PROVIDER=deepseek BENCH_API_KEY=... node bench/run-bench.mjs
                                                   # 49 calls -> bench/out/results.json
```

The API key is read from the environment only and never written to disk. `bench/tasks.mjs` holds the task set with live-computed reference answers; `bench/out/primer.txt` is the `<workspace>` block captured by running the actual `PRIMER_EC` from `src/lib/handlers/ai-primer.ts` via `ec_preview`.

## Configs

| Config | Envelope | Packs selected by `selectChatPacks` | System size |
|---|---|---|---|
| `selection-scorecard` | selection-kind source on a real Scorecard (Control Register, bid 4761) | **`bmpCore` only — the `ec` pack is dropped** | 5,172 chars |
| `no-context` | no sources (chat with no chips) | `bmpCore` + `ec` | 14,197 chars |
| `no-context-primer` | no sources + live `<workspace>` primer | `bmpCore` + `ec` | 15,040 chars |

## Headline findings

1. **F0 — prompt-assembly bug: attaching a selection chip silently drops the EC knowledge pack.** `selectChatPacks` only adds `ec` when a source carries an `extended` slot *or* there are zero sources. A selection-kind source (Inspect flow) has no slot, so a user who selects a Scorecard and asks an EC question gets **no EC reference at all** — and the persona still tells the model to emit `extended` fenced blocks. Result: **0/19 write tasks clean-pass** in that config (vs 14/19 with the pack). This one-line fix is worth more than every pack edit below combined.
2. **With the `ec` pack the model is largely correct**: 14/19 write tasks pass `ec_preview` with the right result, and *none* of the historical traps (`.toUpperCase()`, `filter(_x: …)`, ternary, `&&`/`==`, `.length`, inline `.size() >` comparison, `:+`) appeared. The pack works.
3. The residual with-pack failures are **three specific pack gaps** (no `businessId` property guidance, no MAP key-enumeration guidance, no negation guidance) plus **one prose inversion** the pack states but the model still explains backwards (`output(.expression)` vs bare `.expression`).
4. Verification surfaced **two previously undocumented EC behaviours** (multi-statement IF branch returns a LIST; `FOR … IN … DO … ENDFOR` parses as a silent no-op) — both worth promoting to the pack and to `skills/extended-code/reference.md` after this write-up.
5. The **workspace primer** removed the model's need to probe before answering the "count Risk objects" question — it answered `filter(linkedTo.name = "*risk*")` → 43 confidently and correctly. Without the primer (both other configs) the model refused to guess and emitted **hallucinated tool-call XML** instead (correct instinct, wrong mechanics — in the real pipeline the tool loop absorbs this).

## Scorecard

Failure classes: **P** = pass · **P\*** = pass with caveat · **F-parse** = `ec_preview` parse error · **F-method** = nonexistent method/property (silent or runtime) · **F-sem** = runs but wrong result/shape · **F-prose** = false claim in prose · **NA-tool** = no code, tried to call a tool.

| Task | Category | no-context (bmpCore+ec) | selection-scorecard (bmpCore only) | no-context-primer |
|---|---|---|---|---|
| str-caseins | string | **P** `true` via `t.4761` + wildcard | **F-parse** `CONTAINS(LCASE(root.find(…)))` | — |
| str-substr | string | **P** `3` via `.indexOf` + `.whenMissing(-1)` | **F-parse** `pos("trol"; …)` / `OUT` | — |
| str-concat | string | **F-method** `filter(businessId = "4761")` → "not found" | **F-parse** `businessId("4761")`, `"${_o.name}"` | — |
| str-strip | string | **P** `Stead` via `.strip()`/`.substring()` | **F-parse** `trim(_s)`, `substring(_s,0,5)` as functions | — |
| list-count | list | **P** `9` | **F-parse** `.matches(?i) ".*register.*"` | **P** `9` |
| list-join | list | **P** `.as(name).join(" \| ")` | **F-parse** `join(" \| ", .name)` | — |
| list-distinct | list | **F-parse** invented `MAP.keys()` | **F-parse** `.collect() ->distinct() ->reduce($r,$n:…)` | — |
| list-avg | list | **P** `12` (forEach accumulation — valid) | **F-parse** `.averageBy(size(name))` | — |
| list-index | list | **P** first/third (`item(2)`)/last all correct | **F-parse** bare `IF` as RHS, `sortBy`, `.get(0)`, `\|\|` | — |
| list-groupby | list | **P** `92` via `.map(className).get(…)` | **P\*** last of 3 snippets valid (92); both `groupBy((key,value)=>…)` snippets F-parse | — |
| flow-ifvalue | flow | **P** `big`; parenthesized IF-value | **F-parse** bare `IF` as RHS | — |
| flow-foreach | flow | **P** count=66 + names; colon syntax, init'd accumulators | **F-parse** `forEach(_d =>`, `;`, `strContains`, `toLower` | **P** count=66 |
| flow-nested | flow | **P** `many`; nested IF inside ELSE | **F-parse** `;` terminator, `ELSE IF` | — |
| ref-fallback | refs | **F-sem** result `[, , (no description)]` — LIST shape (see catalog #5) | **P\*** *lucky*: `organisation("4761")` is a silent MISSING; fallback branch happened to be the right answer | — |
| ref-bid | refs | **F-method** `filter(businessId = …)` → `[]`, 2,234 warnings | **F-parse** `OUTPUT _o.name \|\| …` (lexical error) | **F-method** same `businessId` filter |
| ref-exprtext | refs | **P** `output(t.json_size.expression)` — exactly right | **F-parse** `[0]` indexing; never attempts expression text at all | — |
| tmpl-count-risk | template | **NA-tool** correct instinct ("no Risk class, must probe"), emits fake `<preview_ec>` tag | **NA-tool** fake `<tool_calls>` XML | **P** `43` via `filter(linkedTo.name = "*risk*")`, no probe needed |
| tmpl-count-control | template | **P** `17` via `linkedTo.name.whenMissing("")` | **F-sem** `FOR…IN…DO…ENDFOR` **parses and silently does nothing** → returns 0 | **F-parse** `IF NOT _t.isMissing() AND …` |
| list-append | list | **P** `_names := _names.union(LIST(…))` idiom | **F-parse** `p.forEach <- x IN …` / `APPEND` / `ENDFOR` | — |
| explain-map | explain | **P** map = group-by → Map, `get` returns object list | **P\*** opens with "transforms each object" (JS mental model) but lands on correct multimap semantics | — |
| explain-exprtext | explain | **F-prose** semantics **inverted** (see catalog #6) | **F-prose** inverted *and* invents "numeric byte length" meaning | — |
| explain-filter | explain | **P** case-insensitive ✓, chaining-limit #2 as parse error ✓ | **F-prose** claims match is case-SENSITIVE, recommends nonexistent `lower()`, claims inline chain is legal and merely a style choice | — |

**Pass rates (P + P\*):** `no-context` **16/22 (73%)** · `selection-scorecard` **3/22 (14%, of which 2 are luck/fallback)** · `no-context-primer` **3/5** on the primer subset, and it flipped the class-vs-template task from "must probe" to a confident correct answer.

## Failure catalog

### 1. EC pack dropped for selection-only envelopes → wholesale syntax invention *(prompt-assembly bug)*

With only `bmp-core` in context, the model backfills EC from JS/SQL/DAX intuition. A sample of the invented vocabulary, all verified to fail:

| Model output | ec_preview |
|---|---|
| `CONTAINS(LCASE(root.find('4761').name), "register")` | `Encountered "CONTAINS" at line 1, column 1` |
| `idx := pos("trol"; "Control Register");` | `Encountered "(" at line 1, column 11` |
| `sz := IF cnt > 100 THEN "big" ELSE "small" ENDIF` | `Encountered ":=" at line 2, column 4` (bare IF as RHS) |
| `root.organisation.children().join(" \| ", .name)` | `Encountered "," at line 1, column 40` |
| `.collect(className) ->distinct() ->reduce($r, $n : …)` | `Encountered "-" at line 3, column 3` |
| `OUTPUT _o.name \|\| " (" \|\| _o.className \|\| ")"` | `Lexical error at line 3, column 16 ('124')` |
| `_cvCount := …size();` (semicolon terminator) | `Encountered ";" at line 1, column 70` |

**Root cause:** prompt gap (pack absent), not a model or pack-content problem. Same model + `ec` pack passes 14/19.

### 2. `businessId` treated as an EC property — 3 occurrences, incl. under the primer *(pack gap)*

```
_obj := root.organisation.descendants().filter(businessId = "sc_control_register")
```
`ec_preview`: runs, `Missing value warnings: 1117…2234`, empty result → the model's own guard then prints "not found". The EC property is `id`; the whole lookup should be `t.sc_control_register`. The pack teaches `t.<businessId>` referencing and shows `_o.id` in passing, but never states the negative ("there is no `businessId` property") — and the extension's UI/context vocabulary (`bid=`, `businessId`) actively primes the wrong name. This was the single most repeated with-pack failure.

### 3. Invented `MAP.keys()` *(pack gap)*

```
_distinct := root.organisation.descendants().map(className).keys().join(", ")
```
`ec_preview`: `Encountered "(" at line 1, column 65`. The pack documents `.map(prop)` group-by and `.get()`, but gives no way to enumerate keys, so the model invented one. Correct idiom (`.as(className).distinct().join(", ")`) is in the pack but wasn't preferred once the model had committed to "group-by" framing.

### 4. General-purpose `NOT` *(pack gap — confirmed against reference.md line 156: NOT exists only as `NOT IN` / `NOT CONTAINS`)*

```
IF NOT _t.isMissing() AND _t.name = "*control*" THEN
```
`ec_preview`: `Encountered "NOT" at line 1, column 4` (isolated repro). The pack maps `&&`/`||` → `AND`/`OR` but is silent on negation; an uppercase-keyword language makes `NOT` a very plausible guess.

### 5. Multi-statement IF branch as the final expression returns a LIST *(newly verified EC behaviour; silent wrong shape)*

Model code ended with an ELSE branch containing two assignments plus an inner IF; `ec_preview` result: `[, , (no description)]`. Minimal repro:

```
IF FALSE THEN "a" ELSE _x := 1  _y := 2  "z" ENDIF   →   [1, 2, z]
```

The content is right but the shape is a LIST of every statement's value in the taken branch. Not documented in the pack *or* in `skills/extended-code/reference.md`'s Last Expression Rule. A `preview_ec` self-check in the tool loop catches this class trivially (the wrong shape is visible in the log).

### 6. `output(.expression)` semantics explained exactly backwards *(model limitation, aggravated by pack phrasing)*

The pack states: *"`t.calc.expression` EVALUATES the stored code; `output(t.calc.expression)` returns the raw source TEXT."* Asked to explain those two lines, the model asserted the opposite — `output()` "evaluates then logs, returns MISSING", bare `.expression` "returns the raw source text" — a full inversion, with a fabricated "Verification (tested on live BMP)" section. Both configs failed this; the no-pack config additionally invented a meaning for the object ("encoded byte length"). Notably the same model **wrote the correct code** (`output(t.json_size.expression)`) in the write-task — knowledge retrieval works, explanation-under-intuition-pressure does not. The tool loop cannot catch prose errors; only pack rephrasing (make the counter-intuitiveness explicit) and/or a stronger model helps.

### 7. `FOR … IN … DO … ENDFOR` parses as a silent no-op *(newly verified EC behaviour; most dangerous class)*

```
SUM := 0
FOR _o IN root.organisation.descendants() DO … ENDFOR
SUM   →   0        (ec_preview: OK, 4 missing-value warnings)
```
Minimal repro confirmed: the body never executes, unknown tokens degrade to MISSING, execution continues. No error, plausible-looking result (`0`). Worth a HARD NO-GO entry because it's the one invented loop form that *doesn't* fail loudly.

### 8. Silent-MISSING function calls: `organisation("4761")` *(same silent-trap family)*

Parses, returns MISSING, no error. The surrounding fallback logic then produced the *expected* answer by pure luck — the worst kind of pass. Same family as the pack's existing `.includes()`/`.match()` entries; the general rule ("an unknown function/name evaluates to MISSING silently") is only implied by the pack, never stated.

### 9. Hallucinated tool-call syntax when the model wants to probe *(bench artifact with a real lesson)*

Both non-primer configs answered "count Risk objects" with prose + fake tool XML (`<preview_ec>`, `<tool_calls><invoke name="preview_ec">…`). The *instinct* is exactly what CHAT_PERSONA asks for ("prefer a short EC probe"), and in the real pipeline the tool loop handles it. But it shows the answer to this question is **tool-dependent by design** unless the primer is present — the primer config answered correctly with zero probing.

### 10. Minor / cosmetic

- Indentation: with-pack answers used 4-space or no indent; the pack's 5-space rule is stated only in the closing Formatting section. Cosmetic.
- `str-caseins` returned the strings `"true"`/`"false"` rather than booleans (`TRUE`/`FALSE` literals are never shown in the pack). Semantically acceptable here.
- The pack's chaining-limit #3 ("method chaining inside a forEach body also breaks") is **too broad**: `_o.linkedTo.name.whenMissing("")` inside a forEach body ran fine and produced the correct 17. Over-caution is safe but erodes the pack's "everything here is verified" authority.

## Ranked recommendations

### R1 — Fix pack selection for selection-only envelopes *(code, one line; biggest win by far)*

`src/lib/ai/prompt.ts`, `selectChatPacks`: ship the `ec` pack unless the envelope is demonstrably HTML/JS-only. Current behaviour drops it exactly in the Inspect flow the extension is built around (14% vs 73% pass).

```ts
const langs = envelopeLangs(envelope);
const htmlJsOnly = langs.length > 0 && !langs.includes('extended');
if (!htmlJsOnly) packs.push('ec');
```

(The same reasoning applies to `selectPacks` for the one-shot strip only if a non-`extended` lang can co-occur with EC questions — lower priority there since `lang` is explicit.)

### R2 — Pack: business id is `id`; never filter for it *(fixes catalog #2, the top with-pack failure)*

Add to `src/lib/ai/knowledge/ec.md` under **Non-negotiables**, directly after the object-references bullet:

```
- **Business id lookups:** an object's business id is its `id` property
  (`_o.id`). There is NO `businessId` property — `.filter(businessId = "x")`
  parses, warns "Missing value" once per object, and matches nothing.
  To fetch one object by business id, reference it directly (`t.<businessId>`);
  never scan descendants for it.
```

### R3 — Pack: negation, the no-op FOR loop, and MAP key enumeration *(fixes catalog #4, #7, #3)*

Add to the **HARD NO-GO** parse-error list in `ec.md`:

```
- `NOT cond` — general negation does not exist (`IF NOT _x.isMissing() THEN`
  is a parse error). Only `NOT IN` and `NOT CONTAINS` exist. Negate with
  `!=`, `= FALSE`, or `.isMissing()`.
- `_map.keys()` / `_map.values()` — MAPs support only `.get(key)`, `.size()`
  and aggregate/table methods. To enumerate group keys, go back to the list:
  `list.as(prop).distinct()`.
```

And to the **SILENT traps** list:

```
- `FOR _x IN list DO ... ENDFOR` — parses WITHOUT error but the body never
  runs (verified: accumulator stays 0, only "Missing value" warnings). The
  only loop is `list.forEach(_x: ...)`.
- Any unknown function name — `organisation("4761")`, `find(...)` — parses
  and silently evaluates to MISSING; downstream guards then "work" on garbage.
  If a function is not listed here, it does not exist.
```

### R4 — Pack: last-expression rule corner case *(fixes catalog #5)*

Append to the "last expression is the output" bullet in `ec.md`:

```
  If the last statement is an IF whose taken branch contains multiple
  statements, the script returns a LIST of every statement's value in that
  branch (verified: `IF FALSE THEN "a" ELSE _x := 1  _y := 2  "z" ENDIF`
  → `[1, 2, z]`). Assign inside the branch and put the bare variable after
  ENDIF when you need a scalar result.
```

### R5 — Pack: make the `.expression` rule survive intuition *(mitigates catalog #6)*

Replace the current one-liner in `ec.md` with an explicitly counter-intuitive framing:

```
- **Read code as text vs evaluate — the OPPOSITE of what output() suggests:**
  bare `t.calc.expression` RUNS the stored code and yields its result;
  `output(t.calc.expression)` yields the raw source TEXT without running it.
  output() here is not "print the evaluated value". When asked to *show* a
  stored expression, always wrap it in output(); when asked to *run* it,
  use it bare. Never explain these two the other way around.
```

This is the one failure a pack edit may not fully fix — the model inverted a rule that was already stated. If it persists, it is a model limitation; the tool loop does not check prose. A cheap additional guard is a persona line: *"When explaining EC semantics, restate the matching rule from the reference material verbatim before elaborating; do not reason from general programming conventions."*

### R6 — Ship the workspace primer by default *(quantified value)*

The primer (+~210 tokens, cached) converted the class-vs-template question from "cannot answer without a tool round trip / fake tool XML" into an immediate correct `filter(linkedTo.name = "*risk*")` → 43. It did *not* fix vocabulary errors (`businessId` filter still appeared under the primer), so it complements rather than replaces R2–R4.

### R7 — Narrow chaining-limit #3 *(pack accuracy)*

Change "Method chaining inside a forEach body also breaks — use intermediate variables per step" to the verified narrower claim, e.g.:

```
3. Inside a forEach body, chaining a method onto a FUNCTION-call result or
   comparing a chained expression inline breaks exactly as above; plain
   property/method chains (`_o.linkedTo.name.whenMissing("")`) are fine.
```

### R8 — What only the tool loop or a stronger model fixes

- **Tool loop (preview_ec self-check) catches:** all F-parse failures, the LIST-shape result (#5), the empty-result `businessId` filters (#2 — visible as 1,117+ missing-value warnings), and the FOR no-op (#7 — visible as `0` + warnings) *if* the model sanity-checks the result value, which CHAT_PERSONA already instructs.
- **Only a stronger model fixes:** the prose inversion (#6) when it persists past R5, and the fabricated "verified on live BMP" confidence framing that accompanied it. Consider labelling explanation-type answers as lower-trust, or routing "explain" questions through a preview of the code under discussion so the model sees real behaviour before explaining.
- **Nothing to fix:** hallucinated tool XML (#9) does not occur in the real pipeline, where tools are attached.

## Cost / latency

49 calls total (22 + 22 + 5): **prompt 136,420 tokens** (124,416 cache-hit — the stable system prefix works exactly as designed, ~2,780 prompt tokens/call), **completion 6,658 tokens** (median ~130/call). Latency (non-streaming, full completion): **min 285 ms · median 402 ms · max 527 ms** — unusually fast; treat as a low-load snapshot, not an SLA. Estimated spend at deepseek-chat list prices: **≈ $0.02 for the whole suite** (cache-hit input + ~12k cache-miss input + output).

## Judgment notes

- Single sample per (config, task); treat per-task results as pattern evidence, not point estimates. The `NOT` regression appearing only under the primer config is sampling noise, not a primer effect.
- "Plausible result" was checked against reference values computed live before the run (`bench/tasks.mjs` `expect` fields): e.g. 9 register-scorecards, 92 TextElements, 66 name-matches, 43 risk-templated, 17 control-templated, avg name length 12.
- Ground truth for explain-task grading: `skills/extended-code/reference.md` (notably lines 156/172-173 for NOT, the Map section for group-by semantics, and IF/THEN key rules).

## Post-fix validation (2026-07-11)

The ranked recommendations were applied and the previously-failing
`selection-scorecard` subset re-run with the same harness (rebuild prompts with
`node bench/bundle.mjs`, then `node bench/run-bench.mjs --config=selection-scorecard`;
a `--config` / `--tasks` subset filter was added to `run-bench.mjs`). Every write
snippet re-verified with `ec_preview` against the same live Steadfast workspace;
the three explain tasks graded against `skills/extended-code/reference.md`.

**What changed**
- **R1 (headline):** `selectChatPacks` now ships `bmpCore + ec` unconditionally
  (was `bmpCore` only for a selection-kind envelope). `selection-scorecard`
  system prompt: **5,172 → 16,653 chars, packs `[bmpCore, ec]`**.
- **R2–R5, R7 (pack):** `ec.md` gained the `id`-not-`businessId` rule, the
  `NOT`/`_map.keys()` parse-error entries, the `FOR…ENDFOR` + unknown-function
  silent-trap entries, the multi-statement-IF-returns-LIST corner case, the
  counter-intuitive `output(.expression)` framing, and the narrowed
  chaining-limit #3. Pack size 9.3 KB → 11.2 KB (under the 12 KB budget).
- **Prose lever:** a persona line now tells the model to restate the reference
  rule verbatim before explaining, with the `output(.expression)` direction
  spelled out.

**Before → after (selection-scorecard, P + P\*):**

| | Before (bmpCore only) | After (bmpCore + ec) |
|---|---|---|
| **Pass rate** | **3/22 (14%)** | **20/22 (91%)** |
| Write tasks | 3/19 (2 of them luck/fallback) | 17/19 |
| Explain tasks | 0/3 | 3/3 |

The after rate exceeds the report's `no-context` baseline (16/22, 73%): the
selection config also carries the object `<context>` chip, and the pack edits
(the `id` property, the `output(.expression)` framing) closed catalog gaps #2
and #6. The whole invented-syntax failure family (#1) is gone — all 22 replies
returned real EC, none fell back to hallucinated tool XML.

**Prose inversion (#6) fixed:** `explain-exprtext` now states the direction
correctly ("`output(x.expression)` yields the raw source TEXT without running
it; bare `.expression` RUNS the stored code") instead of inverting it;
`explain-filter` correctly calls the wildcard match case-insensitive and cites
chaining-limit #2. Both were `F-prose` before.

**Residual failures (2/22)** — both model-sampling residuals, not pack
regressions:
- `str-concat` — used `t["4761"]` (bracket ref → `Missing value for .name`).
  Note the R2 fix landed: the model correctly read the business id as `.id`
  (no more `filter(businessId = …)`), but chose a non-existent bracket
  accessor. Correct form is `t.4761` / `t."4761"` (the latter passed in
  `str-caseins` the same run).
- `list-avg` — `…as(name).calculate(str(self).size())` chains `.size()` onto
  the function result `str(self)` — a chaining-limit #1 violation
  (`Encountered ".size("`). The report's `no-context` sample passed this via a
  forEach; this is sampling variance.

Re-run cost: 22 calls, ~2,716 completion tokens, median 425 ms, ~$0.005.

## Advanced executable benchmark (2026-07-14)

A second, workspace-agnostic slice now targets the areas the original suite barely covered: string
parsing, primitive and nested JSON arrays, JSON mutation and escaping, LIST
union/merge semantics, list-valued MAP aggregation, explicit tables, filtered
JSON tables, heterogeneous BMP-object tables, and scalar IF results. The 12
cases use synthetic inputs and store their live-verified reference programs in
`bench/tasks.mjs`; all 12 references passed `ec_preview` on Steadfast.

The provider run uses the real `buildChatSystem` output with a fake server URL,
RID, and scorecard identity (`synthetic-scorecard`). No private workspace data is
sent externally. Grading is execution-first: `bench/verify-bench.mjs` previews
the returned EC and checks observable results, with narrow static requirements
only where the result cannot prove intent (for example, parsing the supplied
JSON instead of replacing it with a native LIST).

### Measured result

| Configuration | Score | Output tokens | Latency |
|---|---:|---:|---:|
| Pre-change prompt, provider-default thinking, 2 samples | **4/24 (17%)** | 58,987 total / 2,458 per answer | old harness measured headers only; invalid |
| JSON/MAP/table prompt added, provider-default thinking | **10/12 (83%)** | 14,371 total / 1,198 per answer | 8.3 s median, 47.8 s max |
| Final prompt, thinking disabled | **9/12 (75%)** | 2,249 total / 187 per answer | 2.0 s median, 4.3 s max |

The baseline score is recalculated with the final intent checks: two apparent
passes had replaced the requested JSON input with a native LIST/string and no
longer count. The improved default-thinking run's two genuine failures were the
JSON filter→table column syntax and character escaping; both later passed
targeted live reruns after the pack gained bare table-property arguments and a
bounded character-loop recipe. A subsequent full non-thinking run still varied:
JSON escaping regressed, one mutation omitted the status field, and one case
emitted a tool request instead of code.

### Changes driven by the failures

- Added compact JSON rules: uppercase `JSON()`, primitive wrapper conversion,
  quote stripping, filter→table reparsing, and platform-native reconstruction.
- Added MAP/table rules: semicolon MAP pairs, list-valued aggregation,
  `createtable`/`addRow`, bare table properties, and heterogeneous positional
  tables.
- Added explicit no-go guidance for `WHILE`, string iteration, and JS
  table/object constructors. Stored helpers are now treated correctly as
  discoverable workspace configuration, never as universal EC vocabulary.
- Told the assistant to implement supplied initialization and answer fully
  self-contained tasks without redundant workspace discovery.
- Fixed the harness's latency timer and added model/thinking/repeat/output
  controls plus a privacy-safe synthetic context.

### Decision

For DeepSeek, do **not** disable thinking in production yet. It reduced output
tokens by about 84% and median latency by about 76%, but the full executable
pass rate fell from 83% to 75% and showed higher format/tool-call variance.
This is a provider-specific measurement, not a product contract: the assistant
and benchmark support Anthropic, OpenAI, DeepSeek, and Grok through the same
shared prompt. Keep each provider's default behavior until repeated comparative
runs justify provider-specific routing.

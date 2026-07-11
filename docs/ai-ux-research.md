# AI Assistant UX & Perf Research — applied to the CREV Inspector

Research date 2026-07-11. Scope: proven UX/latency/cost patterns from shipping AI
coding assistants (Copilot, Cursor, Continue.dev, Cody, Zed, JetBrains, Windsurf)
plus Anthropic/OpenAI caching docs, mapped to OUR constraints: MV3 extension
(SW-only, no server), BYO API key (user pays per token), ~400px sidepanel,
session-lived chat, 6 read-only tools + 8-call loop cap, domain = BMP Extended
Code. Every non-obvious claim is cited; unsourced judgement is marked `(inference)`.

## Executive summary

1. Our biggest untapped lever is **prompt-cache-friendly transcript structuring**.
   For BYO-key this is real money: cache reads cost 0.1x input on Anthropic (90%
   off) and ~50% off on OpenAI, and cut time-to-first-token up to 80%.
2. We render **tool activity always-expanded**; every mature product collapses it
   to one summary line by default. Cheap win in a 400px panel.
3. We lack the three table-stakes chat mechanics: **retry, edit-last-message,
   follow-up suggestions after a reply**. All three are low-effort and proven.
4. Our **whole-slot-replace Apply is the right call** — Cursor found full rewrites
   beat diffs for files < 400 lines; our slots are tiny. Don't over-engineer it.
5. The strongest "do not build" signals: always-on ghost-text autocomplete
   (reviewers find it intrusive), cross-session memory, and loud mid-chat
   summarization interruptions. Our session-lived, explicit-invoke design already
   dodges these — keep it that way.

## Recommendations (ranked by impact / effort)

| # | Recommendation | Proven by | Source | Effort (our code) | Impact |
|---|---|---|---|---|---|
| 1 | **Cache the stable prefix explicitly + cache tool defs.** Put `cache_control` on the last knowledge/system block AND on the last tool definition, so system+tools+packs read from cache every turn. | Anthropic caching guide (tool-def caching, automatic breakpoint moves forward) | [platform.claude.com/docs/…/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | S | High |
| 2 | **Collapse tool trace to one summary line**, expandable on click; default collapsed. We show every call inline. | Copilot agent mode collapses tool calls by default (`chat.agent.thinking.collapsedTools`) | [code.visualstudio.com/docs/copilot/agents/agent-tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools) | S | High |
| 3 | **Add Retry on the last assistant turn** (replay same input). | Standard chat mechanic; Cursor/Claude/ChatGPT all ship regenerate | [thepromptbench.com/…/regenerate-undo-branch](https://thepromptbench.com/ai-product-ux/regenerate-undo-branch-conversation-mechanics/) | S | High |
| 4 | **Add follow-up suggestion chips after a reply** (2-3, context-derived, same grammar as our empty-state suggestions). Cost only if clicked. | Copilot Chat `ChatFollowup` links rendered before the prompt box | [GitHub Copilot follow-ups](https://pascoal.net/2024/12/08/gh-copilot-extension-vscode-followups/) · [docs.github.com](https://docs.github.com/en/copilot/how-tos/chat/asking-github-copilot-questions-in-github) | S | Med-High |
| 5 | **Edit-and-resubmit the last user message** (discard turns after it, re-send). Session-lived transcript makes this trivial. Warn that later turns are dropped. | Regenerate/edit/branch is table stakes; ChatGPT/Claude edit-resubmit | [thepromptbench.com](https://thepromptbench.com/ai-product-ux/regenerate-undo-branch-conversation-mechanics/) | S-M | Med |
| 6 | **Guard the tool-loop against Anthropic's 20-block cache lookback.** 8 tool calls ≈ 16 blocks/turn can push the prior cache entry outside the 20-position lookback → silent cache miss. Add a 2nd explicit breakpoint at the last turn boundary. | Anthropic: lookback checks ≤20 positions per breakpoint | [platform.claude.com/docs/…/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | M | Med (Anthropic cost) |
| 7 | **Optional "fast model" for cheap subtasks** (preview-fix retries, follow-up generation, any future summarization) routed to a cheaper model than the main chat model. | Cody uses a targeted Qwen 2.5 Coder for Smart Apply latency; Cursor uses a "smaller, faster flash model" for summarization | [sourcegraph.com/docs/cody/capabilities/chat](https://sourcegraph.com/docs/cody/capabilities/chat) · [cursor.com/changelog/1-6](https://cursor.com/changelog/1-6) | M | Med |
| 8 | **Soft context cap + quiet trim/summary** when the session transcript grows large. Deferred, non-interrupting (see anti-features). | Cursor auto-summarizes at the context-window limit with a cheap model | [cursor.com/changelog/1-6](https://cursor.com/changelog/1-6) | M | Med |
| 9 | **`@`-mention to attach more objects** to context beyond the two auto-chips, for the narrow panel. | Cody's `@`-mention context chips (repo/file/selection) | [sourcegraph.com/docs/cody/capabilities/chat](https://sourcegraph.com/docs/cody/capabilities/chat) | M-L | Low-Med |
| 10 | **Stream the Edit merge diff** instead of waiting for the full reply. Low value for tiny EC slots. | Cursor streams diffs in real time during generation | [fireworks.ai/blog/cursor](https://fireworks.ai/blog/cursor) | M | Low |

Notes on ordering: 1-4 are the high-leverage, low-effort tier — do these first.
5-8 are solid medium bets. 9-10 are optional given our slot sizes and panel width.

### Detail on the top items

**#1 — cache structuring (the money item).** Anthropic reads cost **0.1x** base
input, 5-min cache writes **1.25x**, 1-hour writes **2x**; minimum cacheable
prefix is **1,024 tokens** for Opus 4.8 / Sonnet 5 (Haiku 4.5 needs 4,096), and
short prefixes silently don't cache. Automatic caching (one top-level
`cache_control`) moves the breakpoint to the last cacheable block each turn and is
"recommended for most conversations"; explicit breakpoints (max 4) are for
fine-grained control. Tool definitions cache as one unit — put `cache_control` on
the **last** tool. Crucially, changing the tool set invalidates the tools→system→
messages caches downstream, so **keep the 6 tool defs byte-stable for the whole
session**. Source: [platform.claude.com/docs/…/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
For OpenAI-compat providers caching is **fully automatic** on prefixes > 1,024
tokens (then 128-token increments), giving ~50% input discount and up to 80% TTFT
reduction with **no API changes** — the only requirement is a byte-stable prefix,
so keep the knowledge-pack order fixed (our plan already does). Source:
[openai.com/index/api-prompt-caching](https://openai.com/index/api-prompt-caching/) ·
[developers.openai.com/api/docs/guides/prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching).

**#2 — collapse tool activity.** Copilot agent mode collapses tool-call details by
default and expands them when the user clicks the summary line
([code.visualstudio.com/docs/copilot/agents/agent-tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools)).
Our `buildToolTrace` lists every call as a visible mono line — in a 400px panel a
multi-call trace pushes the answer below the fold. Recommend a single collapsed
line ("Read 3 objects · searched code · previewed EC") that expands to the
per-call list. The optimistic streaming ticks (·/✓/✕) we already have are good
latency-perception UX — keep those while the turn is live, collapse once committed.
*(inference: collapse-on-commit is our synthesis, not a cited product behaviour.)*

**#3/#4/#5 — the missing chat mechanics.** A chat product is "a place where the
user can edit, retry, and rewind"; the minimum set is regenerate, edit-and-
resubmit, and undo/branch
([thepromptbench.com](https://thepromptbench.com/ai-product-ux/regenerate-undo-branch-conversation-mechanics/)).
We have none. Retry (#3) and follow-ups (#4) are the cheapest and highest-value.
Copilot renders follow-ups as links **before** the prompt box; each is a
`vscode.ChatFollowup`
([docs.github.com](https://docs.github.com/en/copilot/how-tos/chat/asking-github-copilot-questions-in-github)).
For edit-resubmit (#5), heed Cursor's cautionary tale: editing a previous message
"wipes work without warning" is a top user complaint
([forum.cursor.com](https://forum.cursor.com/t/editing-a-previous-chat-message-in-agent-mode-wipes-work-without-warning/137786))
— we must state "this discards the replies after it" before dropping turns.

**Apply / diff (validating what we have).** Cursor deliberately has the model
**rewrite the entire file** rather than emit diffs: LLMs are worse at diff-format
edits, and full rewrites beat diffs for files under ~400 lines
([blog.getbind.co](https://blog.getbind.co/2024/10/02/how-cursor-ai-implemented-instant-apply-file-editing-at-1000-tokens-per-second/) ·
[github.com/Aider-AI/aider#625](https://github.com/paul-gauthier/aider/issues/625)).
Our whole-slot-replace behind a `@codemirror/merge` Accept/Reject is exactly this
pattern at slot scale — **no change needed**. Copilot's "Apply in Editor" likewise
updates the whole file then shows an inline diff with Keep/Undo
([code.visualstudio.com/docs/copilot/chat/inline-chat](https://code.visualstudio.com/docs/copilot/chat/inline-chat) ·
[learn.microsoft.com](https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-github-copilot-chat)).
Cody's Smart Apply, which "analyzes the file, finds where the code should live, and
adds a diff", matters only for partial insertion into large files
([sourcegraph.com/docs/cody](https://sourcegraph.com/docs/cody/capabilities/chat)) —
not our case. Our one real gap vs. Cody/Copilot is that Apply needs an open editor
surface; that's an architectural constraint of the extension, keep the disabled
state + "open an editor to apply" hint we already show.

## Do NOT build (with reasoning)

- **Always-on inline autocomplete / ghost text.** Reviewers consistently flag it as
  intrusive: it blocks native IntelliSense/Emmet and "interrupts flow, clutters the
  screen"; Microsoft had to add logic to suppress Copilot completions while
  IntelliSense is open. Our explicit Ctrl+K invocation is the correct posture — do
  not add passive suggestions. [github.com/microsoft/vscode#320940](https://github.com/microsoft/vscode/issues/320940) ·
  [learn.microsoft.com](https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-github-copilot-extension)
- **Cross-session chat memory / persistence.** Session-lived is a deliberate design
  decision (ai-chat-plan.md) and it sidesteps memory-bloat and stale-grounding
  problems. A profile switch already resets the transcript; keep it.
- **Loud mid-chat summarization.** Cursor's "Chat context summarized" interruptions
  are a recurring user annoyance ("💀"), and its on-demand `/summarize` exists
  precisely because the automatic one is disruptive
  ([forum.cursor.com](https://forum.cursor.com/t/summarizing-chat-content/102148) ·
  [cursor.com/changelog/1-6](https://cursor.com/changelog/1-6)). If we do #8, make it
  quiet and deferred, never a modal or a turn-blocking banner.
- **Per-tool approval dialogs.** Copilot needs them because agent tools mutate files
  and risk prompt injection
  ([code.visualstudio.com/docs/copilot/agents/agent-tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools)).
  Our 6 tools are read-only and all mutation flows through user-applied code blocks,
  so approval gates would be pure friction. Do not add them.
- **Cache-write pre-warming (`max_tokens: 0`).** Anthropic supports it to cut TTFT,
  but it bills a cache-creation write with no output — on a BYO key that's spending
  the user's money speculatively. Skip it; rely on natural cache warming.
  [platform.claude.com/docs/…/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **Conversation titles/summaries UI.** These serve persistence/history browsing,
  which a session-lived single-thread panel doesn't have. No value here. *(inference)*
- **Silent model auto-switching.** If we add a fast model (#7), always show which
  model produced a reply (we already show the model in the composer footer) — don't
  swap models invisibly. *(inference, informed by the anti-features above.)*

## Cost levers (BYO-key specific)

The user pays per token, so every lever below is a user-visible feature, not just
an optimisation.

1. **Prompt caching is the dominant lever.** Anthropic: cache reads = **0.1x**
   input (90% off), writes 1.25x (5m) / 2x (1h). For Opus 4.8 at ~$5/MTok base
   that's **$0.50/MTok** on cached reads vs $5 uncached. OpenAI-compat: automatic
   ~50% input discount on repeated prefixes, no code change. Both also cut TTFT
   (OpenAI: up to 80%), so caching improves *latency perception* too. Requirement:
   a byte-stable prefix (system + knowledge packs + tool defs, fixed order) that
   clears the **1,024-token** minimum — verify our selected packs exceed it or the
   cache silently never forms.
   [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
   [OpenAI](https://openai.com/index/api-prompt-caching/)
2. **Don't resend full tool results across user turns.** Our plan already keeps tool
   details as display-only summaries and does not persist them into the next turn's
   provider messages — this is a real token saving; keep it. (ai-chat-plan.md,
   History format note.)
3. **Truncate tool results** to the ~8-10KB hard cap with a `truncated:true` marker.
   Already planned; this bounds the per-call token cost. (ai-chat-plan.md, Tools.)
4. **The 8-call loop cap bounds worst-case spend per turn.** Already implemented —
   this is a cost feature, not just a safety one; surface it if a turn hits the cap.
5. **Route cheap subtasks to a cheaper model** (#7). Cody/Cursor both do this
   (Qwen for apply; flash model for summarization). For us: preview-fix retries and
   any summarization don't need the top chat model.
   [Cody](https://sourcegraph.com/docs/cody/capabilities/chat) ·
   [Cursor](https://cursor.com/changelog/1-6)
6. **Keep the tool set stable within a session.** Changing tool defs invalidates the
   entire downstream cache (tools→system→messages), forcing a full re-write cost on
   the next turn.
   [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
7. **Model-role separation as a config option** (Continue.dev): distinct `chat`,
   `edit`, `apply`, `summarize` model roles let a user put a cheap model on the
   mechanical roles and a strong one on chat. A lightweight version of #7.
   [docs.continue.dev/customize/model-roles](https://docs.continue.dev/customize/model-roles/intro)

## Latency perception (SSE-over-service-worker)

- **Prompt caching is also a latency feature** (see cost lever 1): OpenAI cites up
  to 80% TTFT reduction on cache hits, Anthropic likewise for warm caches — the same
  change that saves money makes the first token feel instant.
  [OpenAI](https://openai.com/index/api-prompt-caching/)
- **Optimistic tool traces** (streaming ·→✓ ticks) fill the gap before text tokens
  arrive; we already do this and it matches how agent products signal progress.
  Keep them live during the turn, collapse on commit (#2).
- **"Thinking…" placeholder** before first token — we have it. Zed's distinction
  between explicit prompt-driven assistance and automatic prediction is worth
  internalising: we are firmly in the *explicit* camp, so a visible working state
  per user action is correct.
  [zed.dev/docs/ai/inline-assistant](https://zed.dev/docs/ai/inline-assistant)
- We do **not** need speculative-decoding "fast apply" (Cursor's 1000 tok/s
  full-file rewrites) — that solves large-file apply latency; our slots are small
  and the merge view is instant.
  [cursor.com instant-apply / fireworks.ai](https://fireworks.ai/blog/cursor)

## Sources

- Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- OpenAI prompt caching — https://openai.com/index/api-prompt-caching/ · https://developers.openai.com/api/docs/guides/prompt-caching
- Copilot inline chat / Apply in Editor — https://code.visualstudio.com/docs/copilot/chat/inline-chat · https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-github-copilot-chat
- Copilot agent tools (collapse, approval) — https://code.visualstudio.com/docs/copilot/agents/agent-tools
- Copilot follow-ups — https://pascoal.net/2024/12/08/gh-copilot-extension-vscode-followups/ · https://docs.github.com/en/copilot/how-tos/chat/asking-github-copilot-questions-in-github
- Copilot ghost-text intrusiveness — https://github.com/microsoft/vscode/issues/320940 · https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-github-copilot-extension
- Cursor instant apply / speculative edits — https://fireworks.ai/blog/cursor · https://blog.getbind.co/2024/10/02/how-cursor-ai-implemented-instant-apply-file-editing-at-1000-tokens-per-second/ · https://github.com/paul-gauthier/aider/issues/625
- Cursor summarization / side chats — https://cursor.com/changelog/1-6 · https://forum.cursor.com/t/summarizing-chat-content/102148
- Cursor edit-message-wipes-work complaint — https://forum.cursor.com/t/editing-a-previous-chat-message-in-agent-mode-wipes-work-without-warning/137786
- Continue.dev model roles — https://docs.continue.dev/customize/model-roles/intro
- Cody chat / Smart Apply / context chips — https://sourcegraph.com/docs/cody/capabilities/chat
- Zed inline assistant / edit prediction — https://zed.dev/docs/ai/inline-assistant · https://zed.dev/docs/ai/edit-prediction
- Chat conversation mechanics (regenerate/edit/branch) — https://thepromptbench.com/ai-product-ux/regenerate-undo-branch-conversation-mechanics/

# opencode-condense

Long opencode sessions die when they hit the context window. The built-in
compaction saves them by summarizing — and a summary loses exactly the
things you needed later: the file path, the exact error, the constraint.

opencode-condense doesn't summarize. A small **scorer model** reads the
session and decides which old tool calls and results are no longer needed;
those are dropped or truncated, and everything else stays **verbatim**.
User and assistant text is never touched. The session's effective window
becomes its raw window **plus everything the scorer has pruned** — a 240k
model keeps working long past 240k of transcript.

The design point is a small scorer running **locally**: a small GGUF on
llama.cpp with `--parallel 1`. It is cheap, the transcript never leaves the
machine, and it is slow — one slot, prefill-bound, sleeping when idle.
Every part of the plugin below exists because of that.

## Quick start

```sh
git clone https://github.com/condottab/opencode-condense
```

`opencode.json` (Node ≥ 18, opencode ≥ 1.18.31):

```jsonc
{
  "plugins": [
    {
      "package": "C:/path/to/opencode-condense/opencode/entry.ts",
      "options": { "baseUrl": "http://127.0.0.1:8000/v1", "model": "your-scorer" }
    }
  ]
}
```

Current opencode reads `plugins` (entries `{package, options}`). The older
`plugin: [[path, options]]` form is ignored by new versions — the plugin
then silently never loads.

Restart opencode — no build step, 2.x imports the TypeScript source
directly. Every option can also be set as a `CONDENSE_*` env var
([Configuration](#configuration)). Windows:
`scripts\install-opencode-plugin-v2.ps1` writes this entry and the env vars
for you.

## How it works

Per context event, in order:

1. **Apply** the stashed decisions of the previous background pass.
2. **Gate** — no-op while occupancy is below `compactAtPercent` (60%).
3. **Guard** — a pass re-arms only after `passCooldownMs` (3 min) *and*
   regrowth of `minRegrowth` (10%) since the last pass. One pass per
   session is ever in flight.
4. **Pass** — in the background, on a deep copy: project the transcript
   into a state, fit it, batch the questions, score them one request at a
   time.
5. **Apply on the next dispatch** — a dropped call disappears with its
   result; a dropped result is truncated to `truncateHeadChars` plus a
   marker. A pass removing less than `minReductionRatio` (25%) is discarded.
6. **Fail-open** — any scorer error, timeout or malformed answer leaves the
   conversation untouched. The plugin cannot break a session.

Scoring cost is prefill, so the pass is built to spend as little of it as
possible:

- **Sequential, single-flight requests.** A `--parallel 1` server queues
  concurrent requests, so concurrency only eats the pass budget. Batches are
  sized to fit one request (`maxRequestTokens`) and run one after another.
- **Incremental ledger.** Scores that cannot flip within `scoreMargin`
  (0.15) are carried over per session; only new and borderline calls, plus
  drift anchors every `reaskEvery` (4) passes, are re-asked. A cold pass on
  a large session costs tens of round-trips; steady state costs a handful.
- **Budgets sized for a slow scorer.** 60 s per round-trip, 60 s per pass —
  generous enough for a model waking out of `--sleep-idle-seconds`.
- **Embedded-payload proxy.** Large base64 blobs in a message (photos) are
  priced as a flat 3000-token proxy in everything the estimator sees, so one
  pasted photo cannot fake the gate. History is never modified.

## Decision protocol

```
POST <baseUrl>   { "model", "state", "questions" }   →   { "answers" }

state:     { context, goal, history }  — the whole conversation, oldest
           first, tool results reduced to one-line notes, fitted into
           maxStateTokens (inputs truncated, long texts abridged, old
           calls collapsed)
questions: { "call_t1":   { "type": "noul", ... },
            "result_t1": { "type": "noul", ... } }
answers:   { "call_t1":   { "noul": 0.91 },
            "result_t1": { "noul": 0.04 } }
```

Two `noul` probabilities per tool call, against `keepThreshold` (0.5):
result ≥ threshold → keep both; call ≥ threshold → keep the call, truncate
the result; else → remove the call with its result.

Any endpoint answering this protocol works. The default is TypeSafe's
System One (`jev-latest`); `scripts/fake-decision-server.mjs` is a
protocol-true stand-in (keeps calls, drops results) for development and
tests.

## Tuning a local scorer

- `--parallel 1`, and keep `maxRequestTokens` below the server ubatch: with
  a systemone endpoint llama-server rejects a prompt above `-ub` with HTTP
  500 instead of chunking it. For the default `-ub 8192` use
  `maxRequestTokens: 7800` (estimation slack included). `--ctx-size` covers
  KV for the whole session (32k is enough for the defaults).
- `--cache-type-k/v q8_0` halves KV memory; measured decision drift is far
  below `keepThreshold`, so it is a safe capacity trade.
- Keep the ubatch in VRAM. On Windows (WDDM) an oversized ubatch can
  silently spill to system RAM at several-times throughput loss —
  `scripts/probe-1batch.ts` times a large prefill against a small one to
  verify you are not in that trap.
- `--sleep-idle-seconds` to give the VRAM back when idle, if you share the
  GPU with your main model.
- `scripts/measure-pass.ts` times a real pass batch-by-batch against your
  scorer — use it to size `maxRequestTokens` for your model and GPU.

## Configuration

`resolveOpenCodeConfig(options?, env?)`; precedence **option > env >
default**; malformed or empty env values fall back, never `NaN`, never
throw.

| Key | Env | Default |
| --- | --- | --- |
| `apiKey` | `CONDENSE_API_KEY`, `TYPESAFE_API_KEY` | — (scoring throws, fail-open) |
| `model` | `CONDENSE_MODEL` | `jev-latest` |
| `baseUrl` | `CONDENSE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` |
| `goal` | `CONDENSE_GOAL` | derived from the last user prompts |
| `minReductionRatio` | `CONDENSE_MIN_REDUCTION_RATIO` | `0.25` |
| `compactAtPercent` | `CONDENSE_COMPACT_AT_PERCENT` | `60` |
| `keepThreshold` | `CONDENSE_KEEP_THRESHOLD` | `0.5` |
| `preserveRecentMessages` | `CONDENSE_PRESERVE_RECENT_MESSAGES` | `6` |
| `maxStateTokens` | `CONDENSE_MAX_STATE_TOKENS` | `25000` |
| `maxRequestTokens` | `CONDENSE_MAX_REQUEST_TOKENS` | `30000` |
| `truncateHeadChars` | `CONDENSE_TRUNCATE_HEAD_CHARS` | `300` |
| `fetchTimeoutMs` | `CONDENSE_FETCH_TIMEOUT_MS` | `60000` |
| `passBudgetMs` | `CONDENSE_PASS_BUDGET_MS` | `60000` |
| `passCooldownMs` | `CONDENSE_PASS_COOLDOWN_MS` | `180000` |
| `minRegrowth` | `CONDENSE_MIN_REGROWTH` | `0.1` |
| `backgroundPass` | `CONDENSE_BACKGROUND_PASS` | `true` (off = blocking pass) |
| `incrementalScoring` | `CONDENSE_INCREMENTAL_SCORING` | `true` |
| `scoreMargin` | `CONDENSE_SCORE_MARGIN` | `0.15` |
| `reaskEvery` | `CONDENSE_REASK_EVERY` | `4` |

Gate/trigger/pass/apply events are mirrored to a file because the opencode
service doesn't capture plugin console output: `CONDENSE_DIAG_LOG` (path;
empty value disables; default `<tmpdir>/opencode/condense-diag.log`).

## Development

```sh
npm install
npm run typecheck     # library + hook + opencode adapters
npm test              # vitest; fake scorer, no network
npm run build         # tsc → dist
npm run build:plugin  # esbuild → dist/opencode-plugin.js (1.x bundle)
```

Offline end-to-end:

```sh
node scripts/fake-decision-server.mjs 8971   # leave running
CONDENSE_BASE_URL=http://127.0.0.1:8971 npm run demo
```

## Also in this repo

- `src/` — the core as a library; bring your own transport via
  `DecisionAsker` (`ask(state, questions)`), or use the exported
  `buildDecisionRequest` / `parseDecisionResponse`.
- `opencode/plugin.ts` — the opencode **1.x** bundle
  (`scripts\install-opencode-plugin.ps1` builds and installs it).
- `hooks/`, `.claude-plugin/` — a Claude Code function-hook plugin
  (early access, 2.1.274+; replaces the built-in summary, falls back to it
  on errors). See [`hooks/README.md`](hooks/README.md).

## Attribution

Derived from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT) — the original compaction core and Claude Code hook. The opencode
plugin and the background pass pipeline are new work on top of that core.

MIT — see `LICENSE`.

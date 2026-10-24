// opencode 2.x plugin entry (`Plugin.define` + `ctx.session.hook("context")`).
//
// This is the V2 port of `./plugin.ts`. V1 returned a
// `{"experimental.chat.messages.transform": ...}` hook object; V2 registers a
// hook on the session domain instead:
//
//   V1: experimental.chat.messages.transform (input, output) -> output.messages
//   V2: ctx.session.hook("context", (event) => ...) -> event.messages
//
// The gate, the pruner delegation, and the fail-open contract are unchanged
// from V1. Verified against opencode 2.0.8 (see README "opencode 2.x"):
//   - `event.messages` is a mutable array of `@opencode/ai` Message objects and
//     survives to provider dispatch (in-place edits are observed by the model).
//   - `ctx.model.list()` resolves inside the hook and carries `limit.context`.
//   - `ctx.session.get()` resolves inside the hook and carries `tokens`.
//
// [2026-10-12] sequential batching in the core + per-session pass re-arm
// guard + 60 s round-trip timeout and pass budget (see v2-pruner.ts).

import { Plugin as PluginNs } from '@opencode/plugin';
import type { Context } from '@opencode/plugin/promise/plugin';
import { resolveOpenCodeConfig, type ResolvedOpenCodeConfig } from './config.js';
import { createV2Pruner, type V2Message } from './v2-pruner.js';
import { estimateTokens } from '../src/state.js';
import { resolveOptions } from '../src/compact.js';
import type { CallDecision } from '../src/types.js';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'opencode-condense';

// [diagnostic] file-based decision tracing. The opencode service does not
// capture plugin `console` output, so the gate decision, the pass report and
// any throw are mirrored to a file. Path: the CONDENSE_DIAG_LOG env var, or
// <tmpdir>/opencode/condense-diag.log by default; an EMPTY env value disables
// file tracing (the fail-open plugin behaviour is unaffected either way).
const DIAG_LOG: string | null = (() => {
  const fromEnv = process.env.CONDENSE_DIAG_LOG;
  if (fromEnv !== undefined) return fromEnv.trim().length > 0 ? fromEnv.trim() : null;
  return join(tmpdir(), 'opencode', 'condense-diag.log');
})();
function dlog(line: string): void {
  if (process.env.VITEST_WORKER_ID || DIAG_LOG === null)
    return; // test runs must not pollute the live log
  try {
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} [condense-core] ${line}\n`);
  } catch {
    /* silent — never throw out of the hook */
  }
}

dlog('v2-plugin module (re-)evaluated');

// ---------------------------------------------------------------------------
// Context-usage gate
//
// The gate must measure the size of the request about to be dispatched, not
// a running total. `ctx.session.get({ sessionID }).tokens` is a CUMULATIVE
// session total (its input/cache counters only grow): against a 240k limit a
// long session reports ~27000% and the gate is permanently open, so the
// pruner ran on every dispatch. Occupancy is now measured from the assembled
// `event.messages` itself, in priority order:
//   1. its serialized size measured with the core's word-based
//      `estimateTokens` (a plain chars/4 ratio undercounts JSON-heavy
//      contexts by up to 40% and would open the gate far too late);
//   2. the last assistant message's own per-request usage
//      (`input + cache.read + cache.write`), if the runtime carries it and
//      the number passes a cumulative-value sanity cap (<= 2x the limit).
// The denominator comes from the model registry (`limit.context`).
// ---------------------------------------------------------------------------

const MODEL_LIMIT_TTL_MS = 10 * 60 * 1000;

type TokenUsage = {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown } | null;
};

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Context occupancy percent: `(input + cache.read + cache.write) / limit`.
 * Output/reasoning are excluded (they are not context occupancy). Returns null
 * when the limit or the usage is missing, so the caller treats the percent as
 * unknown and skips.
 */
export function computeContextPercent(
  tokens: TokenUsage | undefined,
  limit: unknown,
): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  if (!tokens || typeof tokens !== 'object') return null;
  const used = num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write);
  return Math.round((used / limit) * 100);
}

/**
 * Occupancy percent of the serialized request, measured with the core's
 * word-based estimator (the same one that sizes the Jev state — calibrated
 * to land slightly above the true count, i.e. it errs toward compacting).
 * Returns null when the limit or the payload is unusable (caller treats
 * percent as unknown -> skip).
 */
export function percentFromSerialized(serialized: string | null, limit: unknown): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  if (!serialized || serialized.length === 0) return null;
  return Math.round((estimateTokens(serialized) / limit) * 100);
}

/**
 * The last assistant message's per-request usage, if the runtime carries it
 * on the message object. Stops at the last assistant message (older messages
 * describe smaller, earlier contexts). Returns undefined when absent, or when
 * the number looks like a cumulative session total (> 2x the limit — a single
 * request cannot meaningfully exceed the window it was served from).
 */
export function lastAssistantUsage(
  messages: Array<Record<string, unknown> | null>,
  limit: number,
): TokenUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const tokens = message.tokens as TokenUsage | undefined;
    if (!tokens || typeof tokens !== 'object') return undefined;
    const used = num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write);
    if (used <= 0 || used > limit * 2) return undefined;
    return tokens;
  }
  return undefined;
}

/**
 * Resolve `limit.context` for a model from the V2 model registry. `ctx.model.list()`
 * returns `{ location, data: Model.Info[] }`; entries carry `id`, `modelID`,
 * `providerID`, and `limit.context`. Missing client/API/model -> undefined
 * (caller treats percent as unknown -> skip).
 */
export function limitFromModelList(
  payload: unknown,
  providerID: string,
  modelID: string,
): number | undefined {
  const root = payload as { data?: unknown } | null | undefined;
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : [];
  const valid = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  for (const entry of list) {
    const model = entry as {
      id?: unknown;
      modelID?: unknown;
      providerID?: unknown;
      limit?: { context?: unknown };
    } | null;
    if (!model || typeof model !== 'object') continue;
    if (model.providerID !== providerID) continue;
    if (model.id !== modelID && model.modelID !== modelID) continue;
    const context = valid(model.limit?.context);
    if (context !== undefined) return context;
  }
  return undefined;
}

type Ctx = Context;

// V2's `App` exposes only name/version/channel — there is no `client.app.log`
// like V1 had. The V2 convention (see the local ollama-cloud V2 plugin) is
// `console`, which the server captures into its own log stream.
function safeLog(_ctx: Ctx | undefined, level: 'info' | 'error', message: string): void {
  try {
    if (level === 'error') console.error(`[${SERVICE}] ${message}`);
    else console.info(`[${SERVICE}] ${message}`);
  } catch {
    // last resort: stay silent, never throw out of the hook
  }
}

/** `${id}:${tool}:${action}/call=…/result=…` — mirrors the V1 decision log. */
function decisionLine(decision: {
  id: string;
  tool: string;
  action: string;
  keepCall: number;
  keepResult: number;
}): string {
  return (
    `${decision.id}:${decision.tool}:${decision.action}` +
    `/call=${decision.keepCall.toFixed(2)}/result=${decision.keepResult.toFixed(2)}`
  );
}

// Caches are module-level (per plugin runtime), like V1's contextLimitCache.
const limitCache = new Map<string, number>();

/** Test seam: drop cached model limits (module state is shared across tests). */
export function clearModelLimitCache(): void {
  limitCache.clear();
}

// ---------------------------------------------------------------------------
// Pass re-arm guard (per session)
//
// Without this, a session above `compactAtPercent` pays a full scoring pass
// on EVERY dispatch. After the first pass the easy wins are gone, so the
// follow-ups discover "nothing to reduce" only AFTER paying the round trip
// (or dying in the queue). A pass is therefore re-armed only once at least
// MIN_PASS_INTERVAL_MS have passed since the last attempt, and — after a
// SUCCESSFUL attempt — the serialized context has grown by at least
// MIN_REGROWTH (10%) since its baseline: enough new content for another pass
// to matter. A successful pass re-arms against its NEW (smaller) size, so
// the next pass fires 10% above the post-compaction context. A FAILED pass
// scores nothing, so requiring +10% above its (large) pre-pass size can sit
// above the context limit itself — at 95% occupancy the retry would be
// blocked until overflow — and it re-arms on the cooldown alone. The entry
// is recorded BEFORE the pass starts either way (ok:false), so a failed
// attempt already paid its cost and does not re-fire on the next dispatch.
// ---------------------------------------------------------------------------

export const MIN_PASS_INTERVAL_MS = 3 * 60 * 1000;
export const MIN_REGROWTH = 0.1;

export interface PassGuardEntry {
  /** Epoch ms of the last pass attempt (successful, failed, or timed out). */
  at: number;
  /** Serialized context char count used as the re-arm baseline. */
  chars: number;
  /**
   * Whether the last attempt succeeded. A failure scores nothing, so the
   * growth requirement is waived: the retry re-arms on the cooldown alone.
   */
  ok: boolean;
}

const passGuard = new Map<string, PassGuardEntry>();

/** Test seam: drop the per-session pass guard (module state, shared). */
export function clearPassGuard(): void {
  passGuard.clear();
}

/** Test seam: overwrite a session's guard entry (e.g. an elapsed cooldown). */
export function setPassGuardEntry(sessionID: string, entry: PassGuardEntry): void {
  passGuard.set(sessionID, entry);
}

// ---------------------------------------------------------------------------
// Off-critical-path pass state (option B)
//
// The slow decision round-trips run in the BACKGROUND (on a deep copy of the
// messages), so the current dispatch is never frozen by a pass. The scored
// decisions are stashed per session and APPLIED on the next dispatch (fast,
// in place, by stable tool_use_id) — the same mutation path that persists the
// reduction today. `inFlightPasses` guarantees at most one background pass per
// session, so passes never overlap.
// ---------------------------------------------------------------------------

export interface PendingCompaction {
  decisions: CallDecision[];
  /** Epoch ms the background scoring finished (also the guard `at`). */
  at: number;
  /** Chars the scored pass removed (from the snapshot), for the apply log. */
  removedChars: number;
  ratio: number;
}

const pendingCompactions = new Map<string, PendingCompaction>();
const inFlightPasses = new Set<string>();

/** Test seam: drop all stashed background-pass decisions and in-flight marks. */
export function clearPendingCompactions(): void {
  pendingCompactions.clear();
  inFlightPasses.clear();
}

/** Test seam: inspect / seed the stashed decision for a session. */
export function getPendingCompaction(sessionID: string): PendingCompaction | undefined {
  return pendingCompactions.get(sessionID);
}

/** Test seam: is a background pass currently running for the session? */
export function isPassInFlight(sessionID: string): boolean {
  return inFlightPasses.has(sessionID);
}

/**
 * Deep-clone a value (structuredClone, JSON fallback). The background pass
 * scores a copy so the live in-flight messages are never touched mid-dispatch.
 */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to the JSON clone below */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Embedded-payload shrinking (attached files)
// ---------------------------------------------------------------------------
// A message can carry attached files (photos) whose `data` field holds the
// full base64 payload — megabytes for a single shot. That payload is NOT
// text: the provider turns it into a handful of image tokens, so measuring
// its base64 chars with the text estimator inflates the occupancy gate ~10x
// (a 5.4 MB pair of photos reads as ~1.4M "tokens" against a 240k limit).
// For every measurement and snapshot below, each large embedded `data` blob
// is swapped for a fixed digit proxy that the estimator prices at exactly
// IMAGE_PROXY_TOKENS (~3k tokens, the cost of a photo as image tokens). The
// swap walks O(messages) and never re-reads the payload bytes.
const EMBEDDED_PAYLOAD_MIN_CHARS = 8192;
export const IMAGE_PROXY_TOKENS = 3000;
const IMAGE_PROXY = '0'.repeat(IMAGE_PROXY_TOKENS * 2); // digits: 1/2 token each
const FILE_CONTAINER_KEYS = ['files', 'parts', 'content'] as const;
// A `data` blob with no (or non-text) mime is treated as binary when it is
// pure base64 alphabet; a `text/*` mime is counted in full (the provider
// would inline it into the prompt as text).
const BASE64_ALPHABET = /^[A-Za-z0-9+/=\s]*$/;

function isEmbeddedBinary(record: Record<string, unknown>, data: string): boolean {
  const mime = record['mime'] ?? record['mimeType'];
  if (typeof mime === 'string') {
    if (mime.startsWith('image/')) return true;
    if (mime.startsWith('text/')) return false;
  }
  return BASE64_ALPHABET.test(data);
}

export interface ShrinkResult<T> {
  /** The messages with large binary `data` blobs swapped for the proxy. */
  value: T;
  /** Total raw chars of the blobs that were swapped (for the gate log). */
  embeddedChars: number;
  /** Number of blobs that were swapped. */
  fileCount: number;
}

/**
 * Swap large binary file payloads for the image-token proxy. Pure: the input
 * array and its messages are never mutated; untouched inputs are returned by
 * reference.
 */
export function shrinkEmbeddedPayloads<T>(value: T): ShrinkResult<T> {
  if (!Array.isArray(value)) return { value, embeddedChars: 0, fileCount: 0 };
  let embeddedChars = 0;
  let fileCount = 0;
  let touched = false;
  const out = (value as unknown[]).map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const rec = msg as Record<string, unknown>;
    const containers = FILE_CONTAINER_KEYS.filter((key) => Array.isArray(rec[key]));
    if (containers.length === 0) return msg;
    let msgTouched = false;
    const copy: Record<string, unknown> = { ...rec };
    for (const key of containers) {
      copy[key] = (rec[key] as unknown[]).map((item) => {
        if (item && typeof item === 'object') {
          const irec = item as Record<string, unknown>;
          const data = irec['data'];
          if (
            typeof data === 'string' &&
            data.length > EMBEDDED_PAYLOAD_MIN_CHARS &&
            isEmbeddedBinary(irec, data)
          ) {
            embeddedChars += data.length;
            fileCount += 1;
            msgTouched = true;
            return { ...irec, data: IMAGE_PROXY };
          }
        }
        return item;
      });
    }
    if (!msgTouched) return msg;
    touched = true;
    return copy;
  });
  return { value: (touched ? out : value) as T, embeddedChars, fileCount };
}

/**
 * Pure re-arm decision (clock and context size injected for testability):
 * skip while the cooldown is fresh, or while the context has not grown by
 * the threshold since the baseline of the last attempt.
 */
export function shouldSkipPass(
  last: PassGuardEntry | undefined,
  now: number,
  ctxChars: number,
  cooldownMs: number = MIN_PASS_INTERVAL_MS,
  regrowth: number = MIN_REGROWTH,
): { skip: boolean; reason: string } {
  if (last === undefined) return { skip: false, reason: '' };
  const ageMs = now - last.at;
  if (ageMs < cooldownMs) {
    return {
      skip: true,
      reason:
        `last pass ${Math.round(ageMs / 1000)}s ago ` +
        `(< ${Math.round(cooldownMs / 1000)}s cooldown)`,
    };
  }
  // Only a SUCCESSFUL attempt banks progress: re-arm once the context has
  // regrown by the threshold above its (smaller) post-pass size. A failed
  // attempt scored nothing, and near the context limit its +10% baseline is
  // unreachable — it re-arms on the cooldown alone.
  if (last.ok) {
    const threshold = last.chars * (1 + regrowth);
    // The +1e-6 absorbs float noise on the exact boundary (100_000 * 1.1 is
    // 110_000.00000000001 in binary): exactly the growth must re-arm.
    if (ctxChars + 1e-6 < threshold) {
      return {
        skip: true,
        reason:
          `ctxChars ${ctxChars} < ${Math.round(threshold)} ` +
          `(no ${Math.round(regrowth * 100)}% growth since last pass)`,
      };
    }
  }
  return { skip: false, reason: '' };
}

export interface FastJevV2Deps {
  /** Override config resolution (tests). Defaults to `resolveOpenCodeConfig()`. */
  config?: ResolvedOpenCodeConfig;
  /** Injectable fetch, forwarded to the pruner (tests). */
  fetch?: typeof fetch;
}

export function createCondenseV2Plugin(deps: FastJevV2Deps = {}): PluginNs.Plugin {
  return {
    id: 'opencode-condense',
    async setup(ctx: Ctx) {
      // V2 hands plugins their config entry through `ctx.options`, so explicit
      // options still win over env vars (resolveOpenCodeConfig precedence:
      // options > env > default). V1 had no equivalent and used env only.
      const options = (ctx as unknown as { options?: Record<string, unknown> }).options ?? {};
      const config = deps.config ?? resolveOpenCodeConfig(options);
      const pruner = createV2Pruner({
        config,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        // Decision timeouts from the plugin config (option > env > default in
        // resolveOpenCodeConfig); absent -> the pruner's 60 s defaults.
        ...(config.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: config.fetchTimeoutMs } : {}),
        ...(config.passBudgetMs !== undefined ? { passBudgetMs: config.passBudgetMs } : {}),
      });

      await ctx.session.hook('context', async (event) => {
        try {
          const messages = (event as unknown as { messages?: unknown }).messages;
          if (!Array.isArray(messages)) return;

          const model = (event as unknown as { model?: { providerID?: unknown; id?: unknown } })
            .model;
          const providerID = typeof model?.providerID === 'string' ? model.providerID : undefined;
          const modelID = typeof model?.id === 'string' ? model.id : undefined;
          const sessionID = (event as unknown as { sessionID?: unknown }).sessionID;

          const guardKey =
            typeof sessionID === 'string' && sessionID.length > 0 ? sessionID : '__unknown__';

          // (B) APPLY any pending background-pass decisions from a PREVIOUS
          // dispatch. Fast (no backend call), in place, matched by the stable
          // tool_use_id — the same mutation path that persists today. It runs
          // BEFORE the gate so the gate sees the (smaller) post-apply size and
          // does not immediately re-trigger on the pass we just applied.
          if (pendingCompactions.has(guardKey)) {
            const pending = pendingCompactions.get(guardKey);
            pendingCompactions.delete(guardKey);
            if (pending) {
              try {
                const headChars = resolveOptions(config.compactOptions).truncateHeadChars;
                const applyOutcome = pruner.apply(
                  messages as V2Message[],
                  pending.decisions,
                  headChars,
                );
                if (applyOutcome.applied > 0) {
                  safeLog(
                    ctx,
                    'info',
                    `${SERVICE}: applied ${applyOutcome.applied} stored decisions ` +
                      `(${applyOutcome.removedChars} chars) from background pass ` +
                      `(scored ${Math.round((Date.now() - pending.at) / 1000)}s ago, ` +
                      `ratio ${(pending.ratio * 100).toFixed(0)}%)`,
                  );
                  dlog(
                    `APPLY: applied ${applyOutcome.applied} decisions, ` +
                      `${applyOutcome.removedChars} chars, ratio=${pending.ratio.toFixed(3)} ` +
                      `decisions=[${pending.decisions.map(decisionLine).join(' ')}]`,
                  );
                  // Re-arm against the NEW (smaller) context, exactly like a
                  // successful inline pass used to. Measured with the same
                  // file-payload proxy as the gate (consistent units).
                  try {
                    const postChars = JSON.stringify(shrinkEmbeddedPayloads(messages).value).length;
                    if (postChars >= 0)
                      passGuard.set(guardKey, { at: pending.at, chars: postChars, ok: true });
                  } catch {
                    /* keep the pre-pass entry */
                  }
                } else {
                  dlog(
                    `APPLY: 0 decisions applied (parts no longer present); nothing removed`,
                  );
                }
              } catch (applyError) {
                // Fail-open: history is left untouched for this dispatch.
                const message =
                  applyError instanceof Error ? applyError.message : String(applyError);
                safeLog(
                  ctx,
                  'error',
                  `${SERVICE}: apply error (${message}); history left untouched`,
                );
                dlog(`APPLY CATCH: ${message}`);
              }
            }
          }

          // Serialized form of what is about to be sent — the primary gate
          // input (measured with the core's token estimator) and the dlog
          // probe. Attached-file payloads (photos) are swapped for the
          // image-token proxy BEFORE measuring: they cost a few thousand
          // image tokens on the wire, not their megabytes of base64.
          let serialized: string | null = null;
          let ctxChars = -1;
          let embeddedChars = 0;
          let fileCount = 0;
          try {
            const shrunk = shrinkEmbeddedPayloads(messages);
            embeddedChars = shrunk.embeddedChars;
            fileCount = shrunk.fileCount;
            serialized = JSON.stringify(shrunk.value);
            ctxChars = serialized.length;
          } catch {
            serialized = null;
            ctxChars = -1;
          }

          // Occupancy gate: below `compactAtPercent` (or unknown) -> no-op.
          // Primary: the char estimate of THIS request (what actually goes
          // out). Fallback: the last assistant message's per-request usage,
          // if the runtime carries it. Never the cumulative session total.
          let percent: number | null = null;
          let percentSource: 'estimate' | 'message' | 'unknown' = 'unknown';
          if (providerID !== undefined && modelID !== undefined) {
            const key = `${providerID}\0${modelID}`;
            let limit = limitCache.get(key);
            if (limit === undefined) {
              try {
                const payload = await ctx.model.list();
                limit = limitFromModelList(payload, providerID, modelID);
                if (limit !== undefined) limitCache.set(key, limit);
                else
                  safeLog(
                    ctx,
                    'info',
                    `${SERVICE}: context limit absent from model list for ${providerID}/${modelID}; percent unknown`,
                  );
              } catch (error) {
                safeLog(
                  ctx,
                  'error',
                  `${SERVICE}: model list lookup failed for ${providerID}/${modelID} (${
                    error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
                  }); percent unknown`,
                );
              }
            }
            if (limit !== undefined) {
              const fromSerialized = percentFromSerialized(serialized, limit);
              if (fromSerialized !== null) {
                percent = fromSerialized;
                percentSource = 'estimate';
              } else {
                const usage = lastAssistantUsage(
                  messages as Array<Record<string, unknown> | null>,
                  limit,
                );
                if (usage !== undefined) {
                  percent = computeContextPercent(usage, limit);
                  if (percent !== null) percentSource = 'message';
                }
              }
            }
          }

          dlog(
            `gate: session=${String(sessionID)} percent=${percent} src=${percentSource} ` +
              `gate=${config.compactAtPercent} provider=${String(providerID)}/${String(modelID)} ` +
              `msgCount=${messages.length} ctxChars=${ctxChars}` +
              (fileCount > 0
                ? ` files=${fileCount} embeddedChars=${embeddedChars} (proxied as ${fileCount * IMAGE_PROXY_TOKENS} tokens)`
                : ''),
          );
          if (percent === null || percent < config.compactAtPercent) {
            const detail =
              percent === null
                ? 'context unknown'
                : `context ${percent}% < ${config.compactAtPercent}%`;
            safeLog(ctx, 'info', `${SERVICE}: noop (${detail})`);
            dlog(`noop: ${detail}`);
            return;
          }

          // Pass re-arm guard (see shouldSkipPass): skip while the cooldown
          // is fresh, or (after a success) while the context has not grown.
          // Record BEFORE the pass as ok:false so a failed/timed-out attempt
          // cools down on the interval alone; a successful pass re-arms
          // against its post-compaction size below (ok:true).
          const guardNow = Date.now();
          const guardChars = Math.max(ctxChars, 0);
          // (A) The re-arm cooldown and growth are now config-driven
          // (passCooldownMs / minRegrowth); the historical constants are the
          // defaults, so omitting them from the config keeps the old cadence.
          const verdict = shouldSkipPass(
            passGuard.get(guardKey),
            guardNow,
            guardChars,
            config.passCooldownMs ?? MIN_PASS_INTERVAL_MS,
            config.minRegrowth ?? MIN_REGROWTH,
          );
          if (verdict.skip) {
            safeLog(ctx, 'info', `${SERVICE}: skip pass (${verdict.reason})`);
            dlog(
              `skip: session=${String(sessionID)} ctxChars=${ctxChars} ${verdict.reason}`,
            );
            return;
          }

          if (config.backgroundPass !== false) {
            // (B) Off-critical-path: trigger a BACKGROUND scoring pass on a
            // deep copy. The current dispatch proceeds UNCOMPACTED (it stays
            // below the hard limit by the gate headroom); the scored decisions
            // are stashed per session and applied on the NEXT dispatch. The
            // hook returns immediately, so the dispatch is never held.
            if (inFlightPasses.has(guardKey)) {
              safeLog(ctx, 'info', `${SERVICE}: skip pass (background pass already running)`);
              dlog(`skip: session=${String(sessionID)} background pass in flight`);
              return;
            }
            passGuard.set(guardKey, { at: guardNow, chars: guardChars, ok: false });
            inFlightPasses.add(guardKey);
            // The pruner's projection only reads text and tool parts, so the
            // file-payload proxy is invisible to scoring — but it spares the
            // clone (and every transform walk) megabytes of base64.
            const snapshot = deepClone(shrinkEmbeddedPayloads(messages).value as V2Message[]);
            const sid = typeof sessionID === 'string' ? sessionID : undefined;
            void (async () => {
              const startedAt = Date.now();
              try {
                const outcome = await pruner.score(snapshot, sid);
                const { result, ratio } = outcome;
                const asked =
                  result.stats.calls - result.stats.pinned - result.stats.carried;
                const removedChars = result.stats.charsBefore - result.stats.charsAfter;
                if (ratio >= outcome.minReductionRatio) {
                  pendingCompactions.set(guardKey, {
                    decisions: result.decisions,
                    at: Date.now(),
                    removedChars,
                    ratio,
                  });
                  safeLog(
                    ctx,
                    'info',
                    `${SERVICE}: background pass scored (ratio ${(ratio * 100).toFixed(0)}%, ` +
                      `asked ${asked}, carried ${result.stats.carried}); applying on next dispatch`,
                  );
                  dlog(
                    `PASS(scored,bg): ms=${Date.now() - startedAt} ratio=${ratio.toFixed(3)} ` +
                      `asked=${asked} carried=${result.stats.carried} removedChars=${removedChars} ` +
                      `decisions=[${result.decisions.map(decisionLine).join(' ')}] -> pending apply`,
                  );
                } else {
                  safeLog(
                    ctx,
                    'info',
                    `${SERVICE}: background pass below minReductionRatio ` +
                      `(${ratio.toFixed(3)} < ${outcome.minReductionRatio}); nothing to apply`,
                  );
                  dlog(
                    `PASS(scored,bg): ms=${Date.now() - startedAt} ` +
                      `ratio=${ratio.toFixed(3)} < ${outcome.minReductionRatio} -> no apply`,
                  );
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                safeLog(
                  ctx,
                  'error',
                  `${SERVICE}: background pass error (${message}); no compaction this pass`,
                );
                dlog(`PASS(FAIL,bg): ms=${Date.now() - startedAt} ${message}`);
              } finally {
                inFlightPasses.delete(guardKey);
              }
            })();
            safeLog(
              ctx,
              'info',
              `${SERVICE}: compaction triggered in the background; this dispatch is NOT blocked`,
            );
            dlog(
              `TRIGGER(bg): session=${String(sessionID)} ctxChars=${ctxChars} ` +
                `dispatch proceeds uncompacted; scoring runs in the background`,
            );
            return;
          }

          // Synchronous (blocking) path: the original behaviour, kept for hosts
          // and tests that block on the hook anyway.
          passGuard.set(guardKey, { at: guardNow, chars: guardChars, ok: false });

          // NEVER reassign event.messages: the pruner mutates it in place
          // (rewriting result values, splicing removed parts and emptied
          // messages out), so the outer array identity is preserved.
          const outcome = await pruner.transform(
            messages as V2Message[],
            typeof sessionID === 'string' ? sessionID : undefined,
          );
          const { report } = outcome;
          const pct = Math.round(report.ratio * 100);
          safeLog(
            ctx,
            'info',
            `${SERVICE}: scored ${report.scored} (asked ${report.asked}, carried ${report.carried}), ` +
              `applied ${report.applied}, ` +
              `removed ${report.removedChars}/${report.scoredChars} chars (${pct}% reduction)`,
          );
          safeLog(
            ctx,
            'info',
            report.decisions.length > 0
              ? `decisions: ${report.decisions.map(decisionLine).join(' ')}`
              : 'decisions: (none)',
          );
          dlog(
            `PASS: ratio=${report.ratio.toFixed(3)} scored=${report.scored} ` +
              `asked=${report.asked} carried=${report.carried} applied=${report.applied} ` +
              `removedChars=${report.removedChars}/${report.scoredChars} ` +
              `decisions=[${report.decisions.map(decisionLine).join(' ')}]`,
          );
          // Successful pass: re-arm against the NEW (smaller) context, so the
          // next pass fires above the post-compaction size. (A thrown pass
          // never reaches here — the pre-pass ok:false entry stays in place
          // and re-arms on the cooldown alone.) Measured with the same
          // file-payload proxy as the gate (consistent units).
          try {
            const postChars = JSON.stringify(shrinkEmbeddedPayloads(messages).value).length;
            if (postChars >= 0)
              passGuard.set(guardKey, { at: guardNow, chars: postChars, ok: true });
          } catch {
            /* keep the pre-pass entry (ok:false) */
          }
        } catch (error) {
          // Fail-open at the hook boundary: history is left untouched.
          const message = error instanceof Error ? error.message : String(error);
          safeLog(
            ctx,
            'error',
            `${SERVICE}: hook error (${message}); history left untouched`,
          );
          dlog(`CATCH: ${message}`);
        }
      });
    },
  };
}

export default createCondenseV2Plugin();

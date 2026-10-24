// opencode 2.x adapter for the opencode-condense core.
//
// V2 replaced the V1 `experimental.chat.messages.transform` hook with the
// `ctx.session.hook("context", ...)` hook, which hands the plugin the assembled
// `Message[]` (a tagged union of text/media/tool-call/tool-result content
// parts from `@opencode/ai`) immediately before provider dispatch. This module
// is the V2 counterpart of `./pruner.ts`:
//
// (1) project V2 messages into the library's `Message[]` shape,
// (2) delegate eligibility, batching, decisions, and reduction to `compact()`,
// (3) map the core decisions back onto the native V2 parts.
//
// As in V1, the projection is read-only and delegates all policy to the core;
// only the application step below is platform-specific. V2 tool results are
// `tool-result` parts on their own `role: "tool"` messages (V1 kept the call
// and result on adjacent opencode messages), so a call and its result can live
// in different projected messages — the core pairs them by id either way.

import { compact, isStableScore, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildDecisionRequest, parseDecisionResponse } from '../src/request.js';
import type {
  CallDecision,
  CallPolicy,
  CompactResult,
  DecisionAsker,
  DecisionQuestions,
  DecisionState,
  Message,
  ResolvedCompactOptions,
  Role,
} from '../src/types.js';
import type { ResolvedOpenCodeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Native V2 shapes (structural, deliberately local: V2 is beta and the plugin
// is loaded as a bare .ts file, so the host is the only source of these).
// ---------------------------------------------------------------------------

/** A `tool-call` content part (`@opencode/ai` Message content union). */
export type V2ToolCallPart = {
  type: 'tool-call';
  id: string;
  name: string;
  namespace?: string;
  input: unknown;
};

/** A `tool-result` content part. `result.value` is the tool's output. */
export type V2ToolResultPart = {
  type: 'tool-result';
  id: string;
  name: string;
  namespace?: string;
  result: {
    type: 'json' | 'text' | 'error' | 'content';
    value: unknown;
  };
};

export type V2TextPart = {
  type: 'text';
  text: string;
};

export type V2ContentPart =
  | V2ToolCallPart
  | V2ToolResultPart
  | V2TextPart
  | { type: string; [key: string]: unknown };

/** A `@opencode/ai` Message: role plus a tagged-union content array. */
export type V2Message = {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: V2ContentPart[];
  /**
   * Attached files (photos, documents) on user messages (wire shape). Each
   * entry carries the full base64 payload in `data` — NOT text: the provider
   * turns it into image tokens. The plugin's size measurement proxies it
   * (see `shrinkEmbeddedPayloads` in v2-plugin).
   */
  files?: Array<Record<string, unknown>>;
};

export interface V2PruneReport {
  scored: number;
  applied: number;
  /** Candidates asked of the model this pass. */
  asked: number;
  /** Candidates answered from the incremental-scoring ledger. */
  carried: number;
  removedChars: number;
  scoredChars: number;
  ratio: number;
  decisions: CallDecision[];
}

export type V2TransformOutcome = {
  status: 'scored';
  applied: number;
  report: V2PruneReport;
};

/**
 * Result of scoring a SNAPSHOT (read-only projection + decision round-trips),
 * without mutating it. This is the slow, D3-bound half of a pass; run it off
 * the dispatch critical path (e.g. in the background on a deep copy).
 */
export interface V2ScoreOutcome {
  result: CompactResult;
  ratio: number;
  minReductionRatio: number;
  resolved: ResolvedCompactOptions;
}

/** Result of applying stored decisions to a live array, in place. */
export interface V2ApplyOutcome {
  applied: number;
  removedChars: number;
  lines: string[];
}

export interface V2PrunerDeps {
  config: ResolvedOpenCodeConfig;
  asker?: DecisionAsker;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  /**
   * Hard cap for one decision round-trip, in ms. Without it a fetch inherits
   * the host's ~300 s default and a stuck backend freezes the dispatch for
   * five minutes before failing. Default: {@link DEFAULT_FETCH_TIMEOUT_MS}.
   */
  fetchTimeoutMs?: number;
  /**
   * Total budget for ALL decision round-trips of one pass, in ms. Batches are
   * asked sequentially, so a healthy backend finishes a pass in seconds; this
   * caps a degraded one. When exhausted the asker stops answering and the core
   * applies the batches already scored. Default: {@link DEFAULT_PASS_BUDGET_MS}.
   */
  passBudgetMs?: number;
}

/** Hard cap for one decision round-trip: 60 s (fail-open, per round-trip). */
export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

/** Total budget for one pass's decision round-trips: 60 s (per pass). */
export const DEFAULT_PASS_BUDGET_MS = 60_000;

/**
 * A saved score is stable if its decision cannot flip within this margin of
 * the keep threshold. Configurable via `scoreMargin`.
 */
export const DEFAULT_SCORE_MARGIN = 0.15;

/** A carried ledger entry is re-asked at least once every N passes (drift anchor). */
export const DEFAULT_REASK_EVERY = 4;

export interface V2Pruner {
  /**
   * Score AND apply in one pass (the original behaviour): blocks on the
   * decision backend for the whole pass, then mutates `messages` in place.
   * Kept for tests and for hosts that block on the hook anyway.
   * @param sessionID scopes the incremental-scoring ledger to the session
   *        (undefined: a shared anonymous ledger, fine for tests).
   */
  transform(messages: V2Message[], sessionID?: string): Promise<V2TransformOutcome>;
  /**
   * Score a SNAPSHOT (read-only projection + decision round-trips) WITHOUT
   * mutating it. This is the slow, D3-bound part; run it off the dispatch
   * critical path (e.g. in the background on a deep copy). The incremental
   * ledger is folded in here, when the scoring finishes.
   * @param sessionID scopes the incremental-scoring ledger (see transform).
   */
  score(snapshot: V2Message[], sessionID?: string): Promise<V2ScoreOutcome>;
  /**
   * Apply previously scored decisions to a live `messages` array, IN PLACE,
   * matched by the STABLE `tool_use_id` (short ids are renumbered per pass).
   * Fast (no backend call); this is the half that persists the reduction.
   * Outer-array identity is preserved; a throw leaves history untouched.
   */
  apply(
    messages: V2Message[],
    decisions: readonly CallDecision[],
    headChars: number,
  ): V2ApplyOutcome;
}

// ---------------------------------------------------------------------------
// Incremental-scoring ledger (per session, keyed by the STABLE tool_use_id —
// the short ids t1, t2, ... are renumbered every pass).
// ---------------------------------------------------------------------------

interface LedgerEntry {
  keepCall: number;
  keepResult: number;
  /** Passes carried without re-asking (ages the staleness re-ask). */
  passes: number;
}

const scoreLedger = new Map<string, Map<string, LedgerEntry>>();

/** Bounds: one live session's call set, and the number of sessions tracked. */
const LEDGER_MAX_CALLS = 4_000;
const LEDGER_MAX_SESSIONS = 32;

/** Test hook: forget every session's saved scores. */
export function clearScoreLedger(): void {
  scoreLedger.clear();
}

function sessionLedger(key: string): Map<string, LedgerEntry> {
  let map = scoreLedger.get(key);
  if (!map) {
    map = new Map();
    scoreLedger.set(key, map);
    if (scoreLedger.size > LEDGER_MAX_SESSIONS) {
      const oldest = scoreLedger.keys().next().value;
      if (oldest !== undefined && oldest !== key) scoreLedger.delete(oldest);
    }
  }
  return map;
}

/**
 * Folds one finished pass into the ledger:
 *  - asked calls store their fresh scores and restart the staleness counter;
 *  - carried calls age by one (their scores are unchanged);
 *  - pinned calls and calls that were not asked (failed batch) keep their
 *    entry untouched — they are retried on the next pass;
 *  - ids that vanished from the history are pruned.
 */
function updateLedger(ledger: Map<string, LedgerEntry>, decisions: readonly CallDecision[]): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    const id = decision.tool_use_id;
    if (!id) continue;
    seen.add(id);
    if (decision.reason === 'pinned') continue;
    if (decision.asked === true) {
      ledger.set(id, { keepCall: decision.keepCall, keepResult: decision.keepResult, passes: 0 });
    } else if (decision.asked === false) {
      const entry = ledger.get(id);
      if (entry) entry.passes += 1;
    }
  }
  for (const id of [...ledger.keys()]) {
    if (!seen.has(id)) ledger.delete(id);
  }
  if (ledger.size > LEDGER_MAX_CALLS) {
    const overflow = ledger.size - LEDGER_MAX_CALLS;
    for (const [i, id] of [...ledger.keys()].entries()) {
      if (i >= overflow) break;
      ledger.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

const PROJECTED_TEXT_LIMIT = 2000;

function isToolCallPart(part: V2ContentPart): part is V2ToolCallPart {
  return part.type === 'tool-call' && typeof (part as V2ToolCallPart).id === 'string';
}

function isToolResultPart(part: V2ContentPart): part is V2ToolResultPart {
  return part.type === 'tool-result' && typeof (part as V2ToolResultPart).id === 'string';
}

function messageTextOf(message: V2Message): string {
  const texts: string[] = [];
  for (const part of message.content ?? []) {
    if (part.type === 'text' && typeof (part as V2TextPart).text === 'string') {
      texts.push((part as V2TextPart).text);
    }
  }
  const joined = texts.join('\n');
  return joined.length > PROJECTED_TEXT_LIMIT ? joined.slice(0, PROJECTED_TEXT_LIMIT) : joined;
}

/** The projected role for a V2 message. Only user vs assistant matters to the core. */
function projectedRole(role: V2Message['role'] | undefined): Role {
  return role === 'user' ? 'user' : 'assistant';
}

/** Tool output as plain text, mirroring V1's `errorTextOf`. */
export function toolResultText(result: V2ToolResultPart['result'] | undefined): string {
  if (!result || typeof result !== 'object') return '';
  const { type, value } = result;
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (type === 'content' && Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const record = item as Record<string, unknown> | null;
      if (record && record['type'] === 'text' && typeof record['text'] === 'string') {
        parts.push(record['text'] as string);
      } else if (record && record['type'] === 'file') {
        parts.push(`[file ${String(record['uri'] ?? '')}]`);
      }
    }
    return parts.join('\n');
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isErrorResult(result: V2ToolResultPart['result'] | undefined): boolean {
  return result?.type === 'error';
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Pruner
// ---------------------------------------------------------------------------

export function createV2Pruner(deps: V2PrunerDeps): V2Pruner {
  const config = deps.config;
  const log = deps.log ?? ((): void => {});

  function defaultAsker(): DecisionAsker {
    const fetchFn = deps.fetch ?? (globalThis.fetch as typeof fetch);
    const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const passBudgetMs = deps.passBudgetMs ?? DEFAULT_PASS_BUDGET_MS;
    const passStartedAt = Date.now();
    return {
      async ask(state: DecisionState, questions: DecisionQuestions) {
        // Whole-pass budget: batches are asked one at a time, so a pass can
        // only outgrow its budget on a slow backend. Stop there; the core
        // applies the batches already scored (unasked calls keep).
        if (Date.now() - passStartedAt >= passBudgetMs) {
          throw new Error(`decision pass budget of ${passBudgetMs} ms exhausted`);
        }
        if (!config.apiKey) throw new Error('missing API key');
        const request = buildDecisionRequest(
          { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl },
          state,
          questions,
        );
        // Hard cap on one round-trip (see V2PrunerDeps.fetchTimeoutMs). The
        // hook is fail-open, so aborting here only means "no compaction this
        // pass" — it must not hold a provider dispatch hostage.
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(
            new Error(`decision request timed out after ${fetchTimeoutMs} ms`),
          );
        }, fetchTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        try {
          const response = (await fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
          } as Parameters<typeof fetch>[1])) as unknown as {
            ok: boolean;
            status: number;
            text: string | (() => Promise<string>);
          };
          const text =
            typeof response.text === 'function'
              ? await (response.text as () => Promise<string>)()
              : String(response.text ?? '');
          return parseDecisionResponse(response.status ?? 0, !!response.ok, text);
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  // Read-only projection of native V2 messages into the library's Message[].
  // (Extracted from transform so the background `score` path reuses it.)
  function project(messages: V2Message[]): Message[] {
    const projected: Message[] = messages.map((message) => ({
      role: projectedRole(message.role),
      text: messageTextOf(message),
      toolUses: [],
    }));
    messages.forEach((message, messageIndex) => {
      const target = projected[messageIndex];
      if (!target) return;
      for (const part of message.content ?? []) {
        if (isToolCallPart(part)) {
          const call: (typeof target.toolUses)[number] = {
            tool_use_id: part.id,
            tool: part.namespace ? `${part.namespace}.${part.name}` : part.name,
            input: inputRecord(part.input),
          };
          target.toolUses.push(call);
          continue;
        }
        if (isToolResultPart(part)) {
          const text = toolResultText(part.result);
          if (text.length === 0) continue;
          if (!target.toolResults) target.toolResults = [];
          target.toolResults.push({
            tool_use_id: part.id,
            text,
            isError: isErrorResult(part.result),
          });
        }
      }
    });
    return projected;
  }

  // Fast, in-place application of scored decisions to a native array, matched
  // by the STABLE tool_use_id (short ids are renumbered per pass, so a decision
  // scored in one pass is applied to a LATER dispatch by tool_use_id, never by
  // short id). Stages every mutation first so a throw leaves history untouched.
  function applyNative(
    messages: V2Message[],
    decisions: readonly CallDecision[],
    headChars: number,
  ): V2ApplyOutcome {
    const staged: Array<{
      part: V2ToolResultPart | V2ToolCallPart;
      messageIndex: number;
      action: 'drop_result' | 'drop_call';
      next?: V2ToolResultPart['result'];
      chars: number;
      line: string;
    }> = [];

    for (const decision of decisions) {
      if (decision.action === 'keep') continue;
      const uid = decision.tool_use_id;
      if (!uid) continue;
      const line =
        `${decision.id}:${decision.tool}:${decision.action}` +
        `/call=${decision.keepCall.toFixed(2)}/result=${decision.keepResult.toFixed(2)}`;
      messages.forEach((message, messageIndex) => {
        for (const part of message.content ?? []) {
          if (decision.action === 'drop_call' && isToolCallPart(part) && part.id === uid) {
            staged.push({
              part,
              messageIndex,
              action: 'drop_call',
              chars: JSON.stringify(part.input ?? '').length,
              line,
            });
            continue;
          }
          if (decision.action === 'drop_call' && isToolResultPart(part) && part.id === uid) {
            staged.push({
              part,
              messageIndex,
              action: 'drop_call',
              chars: toolResultText(part.result).length,
              line,
            });
            continue;
          }
          if (decision.action === 'drop_result' && isToolResultPart(part) && part.id === uid) {
            const text = toolResultText(part.result);
            const next = truncateForOpencode(text, isErrorResult(part.result), headChars);
            if (next === text) continue;
            const nextResult: V2ToolResultPart['result'] =
              part.result?.type === 'content'
                ? { type: 'content', value: [{ type: 'text', text: next }] }
                : { type: part.result?.type ?? 'text', value: next };
            staged.push({
              part,
              messageIndex,
              action: 'drop_result',
              next: nextResult,
              chars: Math.max(0, text.length - next.length),
              line,
            });
          }
        }
      });
    }

    let applied = 0;
    let removedChars = 0;
    const lines: string[] = [];
    const removedPartIds = new Set<V2ContentPart>();
    for (const item of staged) {
      if (item.action === 'drop_result') {
        const part = item.part as V2ToolResultPart;
        if (!item.next) continue;
        part.result = item.next;
        applied += 1;
        removedChars += item.chars;
        lines.push(item.line);
      } else {
        removedPartIds.add(item.part);
      }
    }
    if (removedPartIds.size > 0) {
      const touchedMessages = new Set<number>();
      messages.forEach((message, messageIndex) => {
        const content = message.content;
        if (!Array.isArray(content)) return;
        for (let i = content.length - 1; i >= 0; i -= 1) {
          const part = content[i];
          if (part && removedPartIds.has(part)) {
            content.splice(i, 1);
            touchedMessages.add(messageIndex);
          }
        }
      });
      for (const item of staged) {
        if (item.action === 'drop_call' && removedPartIds.has(item.part)) {
          applied += 1;
          removedChars += item.chars;
          lines.push(item.line);
        }
      }
      const emptied = [...touchedMessages].filter(
        (index) => (messages[index]?.content?.length ?? 0) === 0,
      );
      emptied.sort((a, b) => b - a);
      for (const index of emptied) messages.splice(index, 1);
    }
    return { applied, removedChars, lines };
  }

  // score: read-only projection + decision round-trips + ledger fold. The slow
  // (D3-bound) half of a pass. Run it off the dispatch critical path, on a deep
  // copy of the messages. It does NOT mutate its input.
  async function scoreImpl(
    snapshot: V2Message[],
    sessionID?: string,
  ): Promise<V2ScoreOutcome> {
    const resolved = resolveOptions(config.compactOptions);
    const asker = deps.asker ?? defaultAsker();

    // Incremental scoring: reuse the previous pass's scores for calls whose
    // decision is stable (margin around the keep threshold), ask only new,
    // borderline, and the once-every-N staleness-anchor calls. Off with
    // `incrementalScoring: false` (every candidate is asked, as before).
    const incremental = config.incrementalScoring !== false;
    const margin = config.scoreMargin ?? DEFAULT_SCORE_MARGIN;
    const reaskEvery = config.reaskEvery ?? DEFAULT_REASK_EVERY;
    let policy: CallPolicy | undefined;
    if (incremental) {
      const ledger = sessionLedger(sessionID ?? '');
      const threshold = resolved.keepThreshold;
      policy = (call) => {
        const entry = ledger.get(call.tool_use_id);
        if (!entry) return { ask: true };
        if (entry.passes + 1 >= reaskEvery) return { ask: true };
        if (isStableScore(entry, threshold, margin)) {
          return { ask: false, saved: { keepCall: entry.keepCall, keepResult: entry.keepResult } };
        }
        return { ask: true };
      };
    }

    // 1. Read-only projection of the snapshot (shared with transform).
    const projected = project(snapshot);

    // 2. Core policy: eligibility, pinning, batching, decisions, ratio.
    // Batches are asked sequentially; a failed or budget-stopped batch is
    // skipped (its calls keep), so a partially scored pass can still apply.
    const result = await compact(projected, asker, {
      ...config.compactOptions,
      ...(policy ? { callPolicy: policy } : {}),
    });

    // Fold the pass into the ledger when the scoring finishes: fresh scores
    // stay valid even when the pass ends without applying (the history is
    // unchanged, so the saved decisions are still about it).
    if (incremental) updateLedger(sessionLedger(sessionID ?? ''), result.decisions);

    return {
      result,
      ratio: reductionRatio(result),
      minReductionRatio: config.minReductionRatio,
      resolved,
    };
  }

  // apply: fast in-place mutation of a live array by stable tool_use_id. This
  // is the half that persists the reduction (the proven V2 mutation path).
  function applyImpl(
    messages: V2Message[],
    decisions: readonly CallDecision[],
    headChars: number,
  ): V2ApplyOutcome {
    return applyNative(messages, decisions, headChars);
  }

  // transform: score + ratio gate + apply (the original blocking behaviour).
  async function transformImpl(
    messages: V2Message[],
    sessionID?: string,
  ): Promise<V2TransformOutcome> {
    const outcome = await scoreImpl(messages, sessionID);
    const { result, ratio, resolved } = outcome;

    // History is left untouched when nothing was reduced enough.
    if (ratio < config.minReductionRatio) {
      throw new Error(
        `below minReductionRatio (${ratio.toFixed(3)} < ${config.minReductionRatio}` +
          (result.stats.failedBatches > 0
            ? `, ${result.stats.failedBatches} batch(es) failed`
            : '') +
          `): history left untouched`,
      );
    }

    const applyOutcome = applyNative(messages, result.decisions, resolved.truncateHeadChars);
    const carried = result.stats.carried;
    const report: V2PruneReport = {
      scored: result.decisions.length,
      applied: applyOutcome.applied,
      asked: result.stats.calls - result.stats.pinned - carried,
      carried,
      removedChars: result.stats.charsBefore - result.stats.charsAfter,
      scoredChars: result.stats.charsBefore,
      ratio,
      decisions: result.decisions,
    };
    log(
      `asked ${report.asked} carried ${carried}; applied ${applyOutcome.applied} of ${result.decisions.length} decisions`,
    );
    return { status: 'scored', applied: applyOutcome.applied, report };
  }

  return {
    transform: transformImpl,
    score: scoreImpl,
    apply: applyImpl,
  };
}

/**
 * Truncation marker for a dropped result. Mirrors `./pruner.ts` so both
 * platforms produce the same text.
 */
export function truncateForOpencode(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[opencode-condense truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

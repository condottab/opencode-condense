import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { collectToolCalls } from '../src/state.js';
import { buildDecisionRequest, parseDecisionResponse } from '../src/request.js';
import type {
  CallDecision,
  DecisionAsker,
  DecisionQuestions,
  DecisionState,
  Message,
} from '../src/types.js';
import type { ResolvedOpenCodeConfig } from './config.js';

export type AnyToolPart = {
  type?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    output?: unknown;
    error?: unknown;
    time?: { start?: number; end?: number; compacted?: number };
  };
};

export type AnyMessage = {
  info?: { id?: string; role?: string; sessionID?: string };
  parts?: AnyToolPart[];
};

export interface PruneReport {
  scored: number;
  applied: number;
  removedChars: number;
  scoredChars: number;
  ratio: number;
  decisions: CallDecision[];
}

export type TransformOutcome = {
  status: 'scored';
  applied: number;
  report: PruneReport;
};

export interface PrunerDeps {
  config: ResolvedOpenCodeConfig;
  asker?: DecisionAsker;
  fetch?: typeof fetch;
  /** Ignored (kept so existing call sites typecheck); the pruner is stateless. */
  now?: () => number;
  log?: (line: string) => void;
}

export interface OpenCodePruner {
  transform(messages: AnyMessage[]): Promise<TransformOutcome>;
}

function errorTextOf(state: NonNullable<AnyToolPart['state']>): string {
  const raw = state.error;
  if (typeof raw === 'string') return raw;
  if (raw != null) {
    try {
      return JSON.stringify(raw) ?? String(raw);
    } catch {
      return String(raw);
    }
  }
  return typeof state.output === 'string' ? (state.output as string) : '';
}

function messageTextOf(message: AnyMessage): string {
  const texts: string[] = [];
  for (const part of message.parts ?? []) {
    const record = part as unknown as Record<string, unknown>;
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      texts.push(record['text'] as string);
    }
  }
  const joined = texts.join('\n');
  return joined.length > 2000 ? joined.slice(0, 2000) : joined;
}

function isToolPart(part: AnyToolPart): boolean {
  if (typeof part.type === 'string' && part.type.includes('tool')) return true;
  if (typeof part.callID === 'string' && part.callID.length > 0 && part.state !== undefined) return true;
  return false;
}

export function truncateForOpencode(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[opencode-condense truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

function readStateInput(part: AnyToolPart): Record<string, unknown> {
  const state = part.state as (Record<string, unknown> & { input?: unknown }) | undefined;
  const raw = state?.input;
  if (raw !== undefined && typeof raw === 'object' && raw !== null) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/**
 * Eligibility mirrors the original library's candidate shape: completed or
 * errored tool parts with a callID, a non-empty result text, and no
 * `state.time.compacted` marker. Pending/running parts (no output yet) and
 * already-compacted parts are skipped.
 */
function eligibleOutput(part: AnyToolPart): { output: string; isError: boolean } | null {
  const state = part.state;
  if (!state || (state.status !== 'completed' && state.status !== 'error')) return null;
  if (state.time?.compacted != null) return null;
  const callID = part.callID;
  if (typeof callID !== 'string' || callID.length === 0) return null;
  const isError = state.status === 'error' || state.error != null;
  const output = typeof state.output === 'string' ? state.output : errorTextOf(state);
  if (typeof output !== 'string' || output.length === 0) return null;
  return { output, isError };
}

export function createOpenCodePruner(deps: PrunerDeps): OpenCodePruner {
  const config = deps.config;
  const log = deps.log ?? ((): void => {});

  function defaultAsker(): DecisionAsker {
    const fetchFn = deps.fetch ?? (globalThis.fetch as typeof fetch);
    return {
      async ask(state: DecisionState, questions: DecisionQuestions) {
        if (!config.apiKey) throw new Error('missing API key');
        const request = buildDecisionRequest(
          { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl },
          state,
          questions,
        );
        const response = (await fetchFn(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
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
      },
    };
  }

  return {
    async transform(messages: AnyMessage[]): Promise<TransformOutcome> {
      // DEVIATION NOTE (minimal, honest): the library core decides
      // eligibility, pinned exclusion, batching, decisions, and reduction; this
      // adapter only (1) projects opencode messages into the library's
      // Message[] shape, (2) delegates to compact(), and (3) maps the core
      // decisions back onto the native parts in place. The drop_result
      // truncation marker is kept as the opencode-platform way to show a
      // shortened result.
      const resolved = resolveOptions(config.compactOptions);
      const asker = deps.asker ?? defaultAsker();

      // Projection (read-only): one projected message per input message. Text
      // comes from the real opencode text parts so fitState derives a
      // non-empty goal from genuine user intent; an explicit config.goal
      // override still wins via compactOptions inside compact(). Each
      // completed/errored non-pending tool part contributes a ToolUse, and the
      // following projected message (or same if last) holds its ToolResult.
      const projected: Message[] = messages.map((message) => ({
        role: message.info?.role === 'user' ? 'user' : 'assistant',
        text: messageTextOf(message),
        toolUses: [],
      }));
      messages.forEach((message, messageIndex) => {
        for (const part of message.parts ?? []) {
          if (!isToolPart(part)) continue;
          const callID = part.callID;
          if (typeof callID !== 'string' || callID.length === 0) {
            log(`warning: tool part without callID skipped (tool=${part.tool ?? 'tool'})`);
            continue;
          }
          const eligible = eligibleOutput(part);
          if (!eligible) continue;
          const target = projected[messageIndex];
          if (!target) continue;
          target.toolUses.push({
            tool_use_id: callID,
            tool: part.tool ?? 'tool',
            input: readStateInput(part),
            text: undefined,
            isError: eligible.isError,
          });
          const resultIndex =
            messageIndex + 1 < projected.length ? messageIndex + 1 : messageIndex;
          const holder = projected[resultIndex];
          if (!holder) continue;
          if (!holder.toolResults) holder.toolResults = [];
          holder.toolResults.push({
            tool_use_id: callID,
            text: eligible.output,
            isError: eligible.isError,
          });
        }
      });

      // The core restores pinned exclusion (!call.pinned filter), Promise.all
      // batching, core decisions, core applyDecisions, and core ratio
      // arithmetic. It throws when Jev fails, so failure leaves history
      // untouched (application below happens only after a successful ask).
      const result = await compact(projected, asker, config.compactOptions);
      const ratio = reductionRatio(result);
      if (ratio < config.minReductionRatio) {
        throw new Error(
          `below minReductionRatio (${ratio.toFixed(3)} < ${config.minReductionRatio}` +
            (result.stats.failedBatches > 0
              ? `, ${result.stats.failedBatches} batch(es) failed`
              : '') +
            `): history left untouched`,
        );
      }

      // Map core decisions (short ids t1, t2, …) back onto native parts via
      // the library's own pairing. Keep decisions only map to native parts
      // that are still eligible; anything else stays untouched.
      const calls = collectToolCalls(projected, resolved.preserveRecentMessages);
      const callById = new Map(calls.map((call) => [call.id, call]));
      const headChars = resolved.truncateHeadChars;

      // Stage every native mutation AND build every log line (toFixed and
      // friends can throw) BEFORE touching history, so a throw leaves it
      // byte-identical and the reported `applied` count never contradicts
      // reality.
      const staged: Array<{
        part: AnyToolPart;
        messageIndex: number;
        action: 'drop_result' | 'drop_call';
        next: string;
        line: string;
      }> = [];
      for (const decision of result.decisions) {
        if (decision.action === 'keep') continue;
        const call = callById.get(decision.id);
        if (!call) continue;
        const line =
          `${decision.id}:${decision.tool}:${decision.action}` +
          `/call=${decision.keepCall.toFixed(2)}/result=${decision.keepResult.toFixed(2)}`;
        messages.forEach((message, messageIndex) => {
          for (const part of message.parts ?? []) {
            if (!isToolPart(part) || part.callID !== call.tool_use_id) continue;
            const eligible = eligibleOutput(part);
            if (!eligible) continue;
            if (decision.action === 'drop_result') {
              if (typeof part.state?.output !== 'string') continue;
              const next = truncateForOpencode(eligible.output, eligible.isError, headChars);
              if (next === eligible.output) continue;
              staged.push({ part, messageIndex, action: 'drop_result', next, line });
            } else {
              staged.push({ part, messageIndex, action: 'drop_call', next: '', line });
            }
          }
        });
      }

      // Apply: drop_result truncates the tool part's output in place;
      // drop_call REMOVES the tool part (never an "empty head" truncation),
      // and any message left with no parts is spliced out of the outer array
      // in place (outer-array identity preserved; surviving messages and
      // parts keep their identity).
      let applied = 0;
      const touchedMessages = new Set<number>();
      const lines: string[] = [];
      for (const item of staged) {
        if (item.action === 'drop_result') {
          const state = item.part.state;
          if (!state || typeof state.output !== 'string') continue;
          state.output = item.next;
          applied += 1;
          lines.push(item.line);
        } else {
          const parts = messages[item.messageIndex]?.parts;
          if (!parts) continue;
          const at = parts.indexOf(item.part);
          if (at === -1) continue;
          parts.splice(at, 1);
          touchedMessages.add(item.messageIndex);
          applied += 1;
          lines.push(item.line);
        }
      }
      const emptied = [...touchedMessages].filter(
        (index) => (messages[index]?.parts?.length ?? 0) === 0,
      );
      emptied.sort((a, b) => b - a);
      for (const index of emptied) messages.splice(index, 1);

      log(`applied ${applied} of ${result.decisions.length} decisions`);
      if (lines.length > 0) log(`decisions: ${lines.join(' ')}`);
      const report: PruneReport = {
        scored: result.decisions.length,
        applied,
        removedChars: result.stats.charsBefore - result.stats.charsAfter,
        scoredChars: result.stats.charsBefore,
        ratio,
        decisions: result.decisions,
      };
      return { status: 'scored', applied, report };
    },
  };
}

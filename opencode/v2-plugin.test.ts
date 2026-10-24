import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearModelLimitCache,
  clearPassGuard,
  clearPendingCompactions,
  createCondenseV2Plugin,
  computeContextPercent,
  getPendingCompaction,
  IMAGE_PROXY_TOKENS,
  isPassInFlight,
  lastAssistantUsage,
  limitFromModelList,
  MIN_PASS_INTERVAL_MS,
  MIN_REGROWTH,
  percentFromSerialized,
  setPassGuardEntry,
  shouldSkipPass,
  shrinkEmbeddedPayloads,
  type PassGuardEntry,
} from './v2-plugin.js';
import {
  clearScoreLedger,
  createV2Pruner,
  DEFAULT_FETCH_TIMEOUT_MS,
  truncateForOpencode,
  toolResultText,
} from './v2-pruner.js';
import type { V2Message } from './v2-pruner.js';
import type { ResolvedOpenCodeConfig } from './config.js';
import { resolveOptions } from '../src/compact.js';
import { estimateTokens } from '../src/state.js';
import type { CallDecision } from '../src/types.js';

// All shapes below were captured from a live opencode 2.0.8 session (see the
// README "opencode 2.x" section): the context hook event, the model registry
// payload, and the tool-call/tool-result parts.

function config(over: Partial<ResolvedOpenCodeConfig> = {}): ResolvedOpenCodeConfig {
  return {
    apiKey: 'sk-test',
    model: 'jev-latest',
    minReductionRatio: 0.25,
    compactAtPercent: 60,
    compactOptions: resolveOptions({}),
    // Legacy behaviour for the pre-ledger tests; the incremental-scoring
    // describes opt in explicitly with `incrementalScoring: true`.
    incrementalScoring: false,
    // The original blocking pass: these hook tests assert the inline
    // (score+apply) behaviour. The background path has its own describe.
    backgroundPass: false,
    ...over,
  };
}

/** Jev stub: drop every result but keep its call. */
function stubFetch() {
  const fn = vi.fn(async (_url: unknown, init: { body?: string | null } | undefined) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      questions?: Record<string, unknown>;
    };
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(body.questions ?? {})) {
      answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
  });
  return fn as unknown as typeof fetch;
}

/** A V2 tool-result message as captured on the wire. */
function toolResultMessage(id: string, name: string, value: string): V2Message {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', id, name, result: { type: 'text', value } }],
  };
}

function assistantCallMessage(id: string, name: string, at: number): V2Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: `calling ${name}` },
      { type: 'tool-call', id, name, input: { path: `file${at}.ts` } },
    ],
  };
}

/**
 * A transcript long enough that a call is unpinned: `preserveRecentMessages`
 * defaults to 6, so the call near the front is a candidate. The padding after
 * the result keeps the call and its result outside the newest 6 messages.
 */
function transcript(output: string): V2Message[] {
  return [
    { role: 'user', content: [{ type: 'text', text: 'Fix the failing test.' }] },
    assistantCallMessage('call_1', 'read', 1),
    toolResultMessage('call_1', 'read', output),
    { role: 'assistant', content: [{ type: 'text', text: 'Looking into it.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Any progress?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Almost.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Status?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Still there?' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Yes, nearly done.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Okay.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done soon.' }] },
  ];
}

/**
 * A transcript with one tool call per stretch of padding, so every call sits
 * outside the newest-6 preserve window. Returns a factory: the transform
 * mutates its input in place, so each use needs a fresh copy.
 */
function multiTranscript(outputs: string[]): () => V2Message[] {
  return () => {
    const messages: V2Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Fix the failing test.' }] },
    ];
    outputs.forEach((output, index) => {
      messages.push(assistantCallMessage(`call_${index + 1}`, 'read', index + 1));
      messages.push(toolResultMessage(`call_${index + 1}`, 'read', output));
      for (let padding = 0; padding < 12; padding += 1) {
        messages.push({ role: 'user', content: [{ type: 'text', text: 'Progress?' }] });
        messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Working.' }] });
      }
    });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] });
    return messages;
  };
}

describe('V2 context usage gate', () => {
  it('computes occupancy from input + cache read/write only', () => {
    expect(
      computeContextPercent(
        { input: 600, output: 9_999, reasoning: 9_999, cache: { read: 200, write: 200 } },
        1_000,
      ),
    ).toBe(100);
  });

  it('returns null when the limit or usage is missing', () => {
    expect(computeContextPercent({ input: 10 }, 0)).toBeNull();
    expect(computeContextPercent({ input: 10 }, undefined)).toBeNull();
    expect(computeContextPercent(undefined, 1_000)).toBeNull();
  });

  it('estimates occupancy with the core word estimator on the serialized request', () => {
    // 4000 identical letters = 1 + floor(3999/6) = 667 estimator tokens.
    expect(percentFromSerialized('x'.repeat(4_000), 1_000)).toBe(67);
    expect(percentFromSerialized('x'.repeat(2_000), 1_000)).toBe(33);
    expect(percentFromSerialized(null, 1_000)).toBeNull();
    expect(percentFromSerialized('', 1_000)).toBeNull();
    expect(percentFromSerialized('x', 0)).toBeNull();
    expect(percentFromSerialized('x', undefined)).toBeNull();
  });

  it('reads the last assistant message usage, rejecting cumulative numbers', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant', tokens: { input: 500, output: 9_999, cache: { read: 100, write: 0 } } },
    ];
    expect(lastAssistantUsage(messages as never, 1_000)).toEqual({
      input: 500,
      output: 9_999,
      cache: { read: 100, write: 0 },
    });
    // A cumulative session total (>> 2x the limit) must be rejected — that
    // is exactly the number `ctx.session.get().tokens` reports.
    const cumulative = [
      { role: 'assistant', tokens: { input: 5_000_000, cache: { read: 59_000_000, write: 0 } } },
    ];
    expect(lastAssistantUsage(cumulative as never, 1_000)).toBeUndefined();
    // No assistant message -> undefined.
    expect(lastAssistantUsage([{ role: 'user' }] as never, 1_000)).toBeUndefined();
    // The last assistant message without usage -> undefined (no walking back
    // to older, smaller contexts).
    expect(
      lastAssistantUsage(
        [
          { role: 'assistant', tokens: { input: 100 } },
          { role: 'assistant' },
        ] as never,
        1_000,
      ),
    ).toBeUndefined();
  });

  it('resolves limit.context from the model registry payload', () => {
    const payload = {
      location: {},
      data: [
        { id: 'other', modelID: 'other', providerID: 'p1', limit: { context: 10 } },
        {
          id: 'deepseek-v4-flash',
          modelID: 'deepseek-v4-flash',
          providerID: 'ollama-cloud',
          limit: { context: 1_048_576 },
        },
      ],
    };
    expect(limitFromModelList(payload, 'ollama-cloud', 'deepseek-v4-flash')).toBe(1_048_576);
    expect(limitFromModelList(payload, 'ollama-cloud', 'missing')).toBeUndefined();
    // A provider mismatch must not leak another provider's limit.
    expect(limitFromModelList(payload, 'other-provider', 'deepseek-v4-flash')).toBeUndefined();
  });
});

describe('V2 pruner', () => {
  it('projects V2 parts, drops the result, and keeps the call', async () => {
    const messages = transcript('x'.repeat(4_000));
    const pruner = createV2Pruner({ config: config(), fetch: stubFetch() });

    const outcome = await pruner.transform(messages);

    expect(outcome.applied).toBe(1);
    // The tool-result value is truncated in place, with the marker.
    const resultPart = messages[2]!.content?.[0] as { result: { value: string } };
    expect(resultPart.result.value).toContain('[opencode-condense truncated');
    expect(resultPart.result.value.length).toBeLessThan(4_000);
    // The call itself survives a drop_result decision.
    const callPart = messages[1]!.content?.[1] as { type: string };
    expect(callPart.type).toBe('tool-call');
  });

  it('does not leave a result without its call', async () => {
    const messages = transcript('x'.repeat(4_000));
    // keepCall low and keepResult low -> drop_call, which must remove BOTH.
    const dropBoth = vi.fn(async (_url: unknown, init: { body?: string | null } | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        questions?: Record<string, unknown>;
      };
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(body.questions ?? {})) answers[name] = { noul: 0.01 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
    });
    const pruner = createV2Pruner({
      config: config(),
      fetch: dropBoth as unknown as typeof fetch,
    });

    await pruner.transform(messages);

    const flat = messages.flatMap((m) => m.content ?? []).map((p) => (p as { type: string }).type);
    expect(flat).not.toContain('tool-call');
    expect(flat).not.toContain('tool-result');
  });

  it('leaves history untouched below minReductionRatio', async () => {
    const messages = transcript('small');
    const before = JSON.stringify(messages);
    const pruner = createV2Pruner({
      config: config({ minReductionRatio: 0.9 }),
      fetch: stubFetch(),
    });

    await expect(pruner.transform(messages)).rejects.toThrow(/below minReductionRatio/);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('throws on a missing API key and leaves history untouched', async () => {
    const messages = transcript('x'.repeat(4_000));
    const before = JSON.stringify(messages);
    const pruner = createV2Pruner({ config: config({ apiKey: undefined }) });

    await expect(pruner.transform(messages)).rejects.toThrow(/missing API key/);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('aborts a decision fetch that hangs past the timeout', async () => {
    // A fetch that only settles when its signal aborts — the shape of a
    // request stuck in a saturated backend queue.
    const hanging = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // no signal -> the test hangs, not the server
          if (signal.aborted) {
            reject(signal.reason ?? new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
        }),
    );
    const messages = transcript('x'.repeat(4_000));
    const before = JSON.stringify(messages);
    const pruner = createV2Pruner({
      config: config(),
      fetch: hanging as unknown as typeof fetch,
      fetchTimeoutMs: 50,
    });

    // The single batch IS the first batch, so its failure is rethrown as-is
    // (the core only tolerates a failure after a scored batch).
    await expect(pruner.transform(messages)).rejects.toThrow(/timed out after 50 ms/);
    expect(hanging).toHaveBeenCalledTimes(1);
    expect(hanging.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('defaults the fetch timeout to 60 s', () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('stops a slow pass at the budget and applies the batches already scored', async () => {
    const mk = multiTranscript(['o1'.repeat(4_000), 'o2'.repeat(4_000), 'o3'.repeat(4_000)]);
    // Probe one fast pass to measure this transcript's state (estimator
    // tokens) and per-call question cost, then size the request budget so
    // two calls fit per batch (never three).
    const probeBodies: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
    const probeFetch = vi.fn((async (_url: unknown, init: { body?: string | null } | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        state: unknown;
        questions?: Record<string, unknown>;
      };
      probeBodies.push({ state: body.state, questions: body.questions ?? {} });
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(body.questions ?? {})) {
        answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
    })) as unknown as typeof fetch;
    await createV2Pruner({ config: config(), fetch: probeFetch }).transform(mk());
    expect(probeBodies).toHaveLength(1);
    const probeQuestions = probeBodies[0]!.questions as Record<
      string,
      { type: string; instructions: string }
    >;
    const perCall = estimateTokens(
      JSON.stringify({
        call_t1: probeQuestions['call_t1'],
        result_t1: probeQuestions['result_t1'],
      }),
    );
    const stateTokens = estimateTokens(JSON.stringify(probeBodies[0]!.state));
    const maxRequestTokens = stateTokens + 2 * perCall + 3;

    // A slow backend: each round-trip takes 30 ms against a 20 ms pass budget,
    // so the second batch's ask is refused before its fetch and the pass ends.
    const slow = vi.fn(
      (_url: unknown, init: { body?: string | null } | undefined) =>
        new Promise((resolve) => {
          setTimeout(() => {
            const body = JSON.parse((init?.body as string) ?? '{}') as {
              questions?: Record<string, unknown>;
            };
            const answers: Record<string, { noul: number }> = {};
            for (const name of Object.keys(body.questions ?? {})) {
              answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
            }
            resolve({ ok: true, status: 200, text: async () => JSON.stringify({ answers }) });
          }, 30);
        }),
    );
    const pruner = createV2Pruner({
      config: config({
        compactOptions: resolveOptions({ maxRequestTokens }),
        minReductionRatio: 0.1,
      }),
      fetch: slow as unknown as typeof fetch,
      passBudgetMs: 20,
    });
    const messages = mk();
    const contentOf = (id: string) =>
      JSON.stringify(
        messages.find((m) => (m.content ?? []).some((p) => p.type === 'tool-result' && p.id === id))
          ?.content,
      );

    const outcome = await pruner.transform(messages);

    expect(slow).toHaveBeenCalledTimes(1); // the budget stopped the pass after batch 1
    expect(outcome.applied).toBeGreaterThan(0);
    expect(contentOf('call_1')).toContain('opencode-condense truncated');
    // call_3 sits in the unasked second batch: its result is byte-identical.
    expect(contentOf('call_3')).toContain('o3'.repeat(4_000));
  });

  it('reads text out of a content-typed result', () => {
    expect(
      toolResultText({
        type: 'content',
        value: [
          { type: 'text', text: 'hello' },
          { type: 'file', uri: 'file:///a.ts', mime: 'text/plain' },
        ],
      }),
    ).toBe('hello\n[file file:///a.ts]');
  });

  it('does not truncate a short result', () => {
    expect(truncateForOpencode('short', false, 300)).toBe('short');
  });

  it('keeps a content-typed result as an array of text parts when truncated', async () => {
    // Regression: replacing a `content` result's array with a bare string
    // violates the tagged result schema; the truncation must stay a content
    // part array.
    const messages: V2Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Fix the failing test.' }] },
      assistantCallMessage('call_1', 'read', 1),
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            id: 'call_1',
            name: 'read',
            result: { type: 'content', value: [{ type: 'text', text: 'y'.repeat(4_000) }] },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking into it.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Any progress?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Almost.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Status?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Working.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Still there?' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Yes, nearly done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Okay.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done soon.' }] },
    ];
    const pruner = createV2Pruner({ config: config(), fetch: stubFetch() });

    await pruner.transform(messages);

    const part = messages[2]!.content?.[0] as {
      result: { type: string; value: unknown };
    };
    expect(part.result.type).toBe('content');
    expect(Array.isArray(part.result.value)).toBe(true);
    const value = part.result.value as Array<{ type: string; text: string }>;
    expect(value[0]!.type).toBe('text');
    expect(value[0]!.text).toContain('[opencode-condense truncated');
  });
});

describe('V2 pruner: score / apply split (option B)', () => {
  it('score is read-only on the snapshot; apply mutates the live array in place', async () => {
    const snapshot = transcript('x'.repeat(4_000));
    const snapshotBefore = JSON.stringify(snapshot);
    const pruner = createV2Pruner({ config: config(), fetch: stubFetch() });

    // The slow, D3-bound half: decision round-trips, read-only.
    const outcome = await pruner.score(snapshot);
    expect(JSON.stringify(snapshot)).toBe(snapshotBefore); // untouched
    expect(outcome.result.decisions.length).toBe(1);
    expect(outcome.ratio).toBeGreaterThan(0);
    expect(outcome.minReductionRatio).toBe(0.25);

    // The fast half: apply the stashed decisions to a LIVE (fresh) array.
    const live = transcript('x'.repeat(4_000));
    const liveBefore = JSON.stringify(live);
    const applyOutcome = pruner.apply(live, outcome.result.decisions, 300);
    expect(applyOutcome.applied).toBe(1);
    expect(applyOutcome.removedChars).toBeGreaterThan(0);
    expect(JSON.stringify(live)).not.toBe(liveBefore); // mutated in place
    const resultPart = live[2]!.content?.[0] as { result: { value: string } };
    expect(resultPart.result.value).toContain('[opencode-condense truncated');
  });

  it('apply matches by the STABLE tool_use_id and ignores absent parts and keeps', () => {
    const live = transcript('x'.repeat(4_000));
    const pruner = createV2Pruner({ config: config(), fetch: stubFetch() });
    const decisions: CallDecision[] = [
      {
        id: 't1',
        tool: 'read',
        action: 'drop_result',
        reason: 'result_dropped',
        tool_use_id: 'call_1',
        keepCall: 0.9,
        keepResult: 0.1,
      },
      {
        id: 't2',
        tool: 'read',
        action: 'drop_result',
        reason: 'result_dropped',
        tool_use_id: 'call_missing', // not present in this history -> ignored
        keepCall: 0.9,
        keepResult: 0.1,
      },
      {
        id: 't3',
        tool: 'read',
        action: 'keep',
        reason: 'kept',
        tool_use_id: 'call_1', // a keep is never applied, even when it matches
        keepCall: 0.9,
        keepResult: 0.9,
      },
    ];

    const applyOutcome = pruner.apply(live, decisions, 300);
    expect(applyOutcome.applied).toBe(1); // only the drop_result on call_1
    expect(applyOutcome.removedChars).toBeGreaterThan(0);
    const resultPart = live[2]!.content?.[0] as { result: { value: string } };
    expect(resultPart.result.value).toContain('[opencode-condense truncated');

    // A keep-only decision list leaves the history byte-identical.
    const untouched = transcript('x'.repeat(4_000));
    const before = JSON.stringify(untouched);
    const onlyKeeps: CallDecision[] = [
      {
        id: 't1',
        tool: 'read',
        action: 'keep',
        reason: 'kept',
        tool_use_id: 'call_1',
        keepCall: 1,
        keepResult: 1,
      },
    ];
    expect(pruner.apply(untouched, onlyKeeps, 300).applied).toBe(0);
    expect(JSON.stringify(untouched)).toBe(before);
  });

  it('apply drop_call removes the call AND its result (no orphan)', () => {
    const live = transcript('x'.repeat(4_000));
    const pruner = createV2Pruner({ config: config(), fetch: stubFetch() });
    const decisions: CallDecision[] = [
      {
        id: 't1',
        tool: 'read',
        action: 'drop_call',
        reason: 'call_dropped',
        tool_use_id: 'call_1',
        keepCall: 0.01,
        keepResult: 0.01,
      },
    ];

    const applyOutcome = pruner.apply(live, decisions, 300);
    expect(applyOutcome.applied).toBe(2); // the call part + the result part
    const flat = live.flatMap((m) => m.content ?? []).map((p) => (p as { type: string }).type);
    expect(flat).not.toContain('tool-call');
    expect(flat).not.toContain('tool-result');
    // The emptied result message is spliced out.
    expect(live.some((m) => m.role === 'tool')).toBe(false);
  });
});

describe('V2 plugin hook', () => {
  // The limit cache, the pass guard and the background-pass state are module
  // state; stale entries from an earlier test would answer with the previous
  // test's limit / cooldown / in-flight mark.
  beforeEach(() => {
    clearModelLimitCache();
    clearPassGuard();
    clearPendingCompactions();
  });

  /** Minimal V2 context: only the domains the hook touches. */
  function fakeCtx(over: { percent?: number; modelLimit?: number | undefined } = {}) {
    const hooks: Record<string, (event: unknown) => Promise<void>> = {};
    const list = vi.fn(async () => ({
      location: {},
      data:
        over.modelLimit === undefined
          ? []
          : [
              {
                id: 'deepseek-v4-flash',
                modelID: 'deepseek-v4-flash',
                providerID: 'ollama-cloud',
                limit: { context: over.modelLimit },
              },
            ],
    }));
    const get = vi.fn(async () => ({
      tokens: {
        input: (over.percent ?? 0) * 10,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }));
    return {
      ctx: {
        app: { name: 'test', version: '2.0.8', channel: 'latest' },
        location: { directory: 'C:\\tmp', project: { id: 'p', directory: 'C:\\tmp', canonical: 'C:\\tmp' } },
        options: {},
        model: { list },
        session: {
          get,
          hook: async (name: string, cb: (event: unknown) => Promise<void>) => {
            hooks[name] = cb;
            return { dispose: async () => {} };
          },
        },
      },
      hooks,
      list,
      get,
    };
  }

  function event(messages: V2Message[], sessionID = 'ses_test') {
    return {
      sessionID,
      agent: 'build',
      model: { id: 'deepseek-v4-flash', providerID: 'ollama-cloud', variant: 'default' },
      system: [],
      messages,
      tools: {},
      options: {},
    };
  }

  it('registers the context hook on the session domain', async () => {
    const { ctx, hooks } = fakeCtx({ modelLimit: 1_000 });
    const plugin = createCondenseV2Plugin({ config: config(), fetch: stubFetch() });
    await plugin.setup(ctx as never);
    expect(typeof hooks['context']).toBe('function');
  });

  it('no-ops below compactAtPercent', async () => {
    // Small enough that the char estimate stays under the gate: ~150 chars
    // serialized ~= 40 tokens ~= 4% of a 1000-token limit.
    const messages: V2Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi, how can I help?' }] },
    ];
    const before = JSON.stringify(messages);
    const { ctx, hooks, get } = fakeCtx({ percent: 10, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({
      config: config({ compactAtPercent: 60 }),
      fetch,
    });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages));

    expect(fetch).not.toHaveBeenCalled();
    // The cumulative session total must no longer be read by the gate.
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('prunes in place once the gate is passed', async () => {
    // The 4000-char tool result dominates the serialized size: ~5k chars
    // ~= 1250 tokens ~= 125% of the 1000-token limit -> gate open.
    const messages = transcript('x'.repeat(4_000));
    const { ctx, hooks, get } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({
      config: config({ compactAtPercent: 60 }),
      fetch,
    });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages));

    expect(fetch).toHaveBeenCalledTimes(1);
    // The cumulative session total must no longer be read by the gate.
    expect(get).not.toHaveBeenCalled();
    const resultPart = messages[2]!.content?.[0] as { result: { value: string } };
    expect(resultPart.result.value).toContain('[opencode-condense truncated');
  });

  it('no-ops when the model limit is unknown', async () => {
    const messages = transcript('x'.repeat(4_000));
    const before = JSON.stringify(messages);
    const { ctx, hooks } = fakeCtx({ modelLimit: undefined });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({ config: config(), fetch });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages));

    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('fail-opens when scoring throws (history untouched)', async () => {
    const messages = transcript('x'.repeat(4_000));
    const before = JSON.stringify(messages);
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    const plugin = createCondenseV2Plugin({
      config: config(),
      fetch: failing,
    });
    await plugin.setup(ctx as never);

    await expect(hooks['context']!(event(messages))).resolves.toBeUndefined();
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('a failed pass still cools down the session (no immediate re-fire)', async () => {
    const messages = transcript('x'.repeat(4_000));
    const before = JSON.stringify(messages);
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    const plugin = createCondenseV2Plugin({
      config: config(),
      fetch: failing,
    });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages)); // attempt 1: fails
    expect(failing).toHaveBeenCalledTimes(1);

    const fresh = transcript('x'.repeat(4_000));
    await hooks['context']!(event(fresh)); // attempt 2: cooldown -> skip
    expect(failing).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fresh)).toBe(before);
  });

  it('re-arms a failed pass after the cooldown without growth', async () => {
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const failing = vi.fn(async () => {
      throw new Error('network down');
    });
    const plugin = createCondenseV2Plugin({ config: config(), fetch: failing });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(transcript('x'.repeat(4_000)))); // fails
    expect(failing).toHaveBeenCalledTimes(1);

    // Cooldown elapsed, context unchanged: a failure must not demand growth
    // (its pre-pass baseline could be unreachable near the limit), so the
    // retry goes out.
    setPassGuardEntry('ses_test', {
      at: Date.now() - MIN_PASS_INTERVAL_MS - 1_000,
      chars: JSON.stringify(transcript('x'.repeat(4_000))).length,
      ok: false,
    });
    const fresh = transcript('x'.repeat(4_000));
    await hooks['context']!(event(fresh)); // attempt 2: re-armed -> fails again
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('skips a second pass that follows within the cooldown', async () => {
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({ config: config(), fetch });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(transcript('x'.repeat(4_000))));
    expect(fetch).toHaveBeenCalledTimes(1);

    // Same session, milliseconds later, same-size context: the cooldown
    // must suppress the pass (no round trip, no mutation).
    const fresh = transcript('x'.repeat(4_000));
    const before = JSON.stringify(fresh);
    await hooks['context']!(event(fresh));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fresh)).toBe(before);
  });

  it('does not re-arm after the cooldown without 10% growth', async () => {
    const original = transcript('x'.repeat(4_000));
    const c0 = JSON.stringify(original).length;
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({ config: config(), fetch });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(transcript('x'.repeat(4_000))));
    expect(fetch).toHaveBeenCalledTimes(1);

    // Simulate the cooldown having elapsed; ok:true (a successful attempt)
    // means the entry demands 10% growth above its baseline to re-arm.
    setPassGuardEntry('ses_test', {
      at: Date.now() - MIN_PASS_INTERVAL_MS - 1_000,
      chars: c0,
      ok: true,
    });

    const fresh = transcript('x'.repeat(4_000)); // unchanged size
    const before = JSON.stringify(fresh);
    await hooks['context']!(event(fresh));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fresh)).toBe(before);
  });

  it('re-arms after the cooldown once the context grew by 10%', async () => {
    const c0 = JSON.stringify(transcript('x'.repeat(4_000))).length;
    const grown = transcript('x'.repeat(5_000));
    expect(JSON.stringify(grown).length).toBeGreaterThanOrEqual(c0 * (1 + MIN_REGROWTH));

    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({ config: config(), fetch });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(transcript('x'.repeat(4_000))));
    expect(fetch).toHaveBeenCalledTimes(1);

    setPassGuardEntry('ses_test', {
      at: Date.now() - MIN_PASS_INTERVAL_MS - 1_000,
      chars: c0,
      ok: true,
    });
    const before = JSON.stringify(grown);
    await hooks['context']!(event(grown));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(grown)).not.toBe(before); // the new pass pruned it
  });

  it('keeps independent cooldowns per session', async () => {
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({ config: config(), fetch });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(transcript('x'.repeat(4_000)), 'ses_a'));
    expect(fetch).toHaveBeenCalledTimes(1);

    // A different session is not cooled down by ses_a's pass.
    const other = transcript('x'.repeat(4_000));
    await hooks['context']!(event(other, 'ses_b'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe('background pass (off-critical-path)', () => {
    /** Wait until the fire-and-forget background pass has settled. */
    async function settle(sessionID = 'ses_test') {
      await vi.waitFor(() => expect(isPassInFlight(sessionID)).toBe(false), {
        timeout: 2_000,
      });
    }

    it('returns before the pass finishes and does not mutate the dispatch', async () => {
      const messages = transcript('x'.repeat(4_000));
      const before = JSON.stringify(messages);
      const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
      const fetch = stubFetch();
      const plugin = createCondenseV2Plugin({
        config: config({ backgroundPass: true }),
        fetch,
      });
      await plugin.setup(ctx as never);

      // The hook must NOT wait for the (slow) pass to finish.
      await hooks['context']!(event(messages));

      // The dispatch was not held: history is still byte-identical — the
      // scored decisions are stashed, not yet applied.
      expect(JSON.stringify(messages)).toBe(before);
      expect(isPassInFlight('ses_test') || getPendingCompaction('ses_test') !== undefined).toBe(
        true,
      );

      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(getPendingCompaction('ses_test')?.decisions.length).toBeGreaterThan(0);
    });

    it('applies the stashed decisions on the NEXT dispatch', async () => {
      const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
      const fetch = stubFetch();
      const plugin = createCondenseV2Plugin({
        config: config({ backgroundPass: true }),
        fetch,
      });
      await plugin.setup(ctx as never);

      await hooks['context']!(event(transcript('x'.repeat(4_000)))); // trigger
      await settle();
      expect(getPendingCompaction('ses_test')).toBeDefined();

      // Next dispatch: the stashed decisions are applied in place by id.
      const next = transcript('x'.repeat(4_000));
      const before = JSON.stringify(next);
      await hooks['context']!(event(next));
      await settle();

      expect(JSON.stringify(next)).not.toBe(before); // it was compacted
      const resultPart = next[2]!.content?.[0] as { result: { value: string } };
      expect(resultPart.result.value).toContain('[opencode-condense truncated');
      // The pending was consumed (applied), so it is gone.
      expect(getPendingCompaction('ses_test')).toBeUndefined();
    });

    it('never runs two background passes for one session (in-flight skip)', async () => {
      // A fetch I hold open: the first pass stays in flight until released.
      let release: (() => void) | undefined;
      const hanging = vi.fn(
        (_url: unknown, _init?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ answers: {} }),
              });
          }),
      );
      const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 1_000 });
      const plugin = createCondenseV2Plugin({
        config: config({ backgroundPass: true }),
        fetch: hanging as unknown as typeof fetch,
      });
      await plugin.setup(ctx as never);

      await hooks['context']!(event(transcript('x'.repeat(4_000)))); // trigger 1
      expect(isPassInFlight('ses_test')).toBe(true);
      expect(hanging).toHaveBeenCalledTimes(1);

      // A second dispatch while the first is in flight: skipped, no 2nd fetch.
      await hooks['context']!(event(transcript('x'.repeat(4_000))));
      expect(hanging).toHaveBeenCalledTimes(1);

      release?.(); // let the held pass settle (cleanup)
      await settle();
    });
  });

  it('does not let a megabyte photo inflate the gate', async () => {
    // The photo alone (2 MB base64) reads as ~333k tokens under the text
    // estimator. With the proxy, the history below — 500k chars ≈ 86k est.
    // tokens — sits at ~36% of the 240k limit, below the 60% gate. Without
    // the proxy the same dispatch would read ~174% and fire a pass.
    const messages: V2Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Examine this driver board.' }],
        files: [{ data: 'A'.repeat(2_000_000), mime: 'image/jpeg', name: 'photo.jpg' }],
      },
      ...transcript('x'.repeat(500_000)),
    ];
    const before = JSON.stringify(messages);
    const { ctx, hooks } = fakeCtx({ percent: 36, modelLimit: 240_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({
      config: config({ compactAtPercent: 60 }),
      fetch,
    });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages));

    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('still triggers when the non-photo content crosses the gate', async () => {
    // Same photo, but a 2M-char tool result: ~333k est. tokens on its own,
    // far above 60% of 240k even with the photo proxied.
    const messages: V2Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Examine this driver board.' }],
        files: [{ data: 'A'.repeat(2_000_000), mime: 'image/jpeg', name: 'photo.jpg' }],
      },
      ...transcript('x'.repeat(2_000_000)),
    ];
    const { ctx, hooks } = fakeCtx({ percent: 90, modelLimit: 240_000 });
    const fetch = stubFetch();
    const plugin = createCondenseV2Plugin({
      config: config({ compactAtPercent: 60 }),
      fetch,
    });
    await plugin.setup(ctx as never);

    await hooks['context']!(event(messages));

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('V2 pass re-arm guard', () => {
  it('runs with no prior attempt', () => {
    expect(shouldSkipPass(undefined, 1_000, 100_000)).toEqual({ skip: false, reason: '' });
  });

  it('skips inside the cooldown window', () => {
    const verdict = shouldSkipPass(
      { at: 1_000_000, chars: 100_000, ok: true },
      1_000_000 + MIN_PASS_INTERVAL_MS - 1,
      500_000,
    );
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toMatch(/cooldown/);
  });

  it('skips after the cooldown without 10% growth', () => {
    const verdict = shouldSkipPass(
      { at: 0, chars: 100_000, ok: true },
      MIN_PASS_INTERVAL_MS + 1,
      Math.round(100_000 * (1 + MIN_REGROWTH)) - 1,
    );
    expect(verdict.skip).toBe(true);
    expect(verdict.reason).toMatch(/growth/);
  });

  it('re-arms exactly at the 10% growth boundary', () => {
    const at = MIN_PASS_INTERVAL_MS + 1;
    expect(
      shouldSkipPass({ at: 0, chars: 100_000, ok: true }, at, Math.round(100_000 * (1 + MIN_REGROWTH))).skip,
    ).toBe(false);
    // ...and at 11% growth (the live traffic case).
    expect(shouldSkipPass({ at: 0, chars: 100_000, ok: true }, at, 111_000).skip).toBe(false);
  });

  it('re-arms a failed attempt after the cooldown without growth', () => {
    // A failed pass scores nothing; near the context limit a +10% baseline
    // would sit above the limit, so the retry must not demand growth.
    expect(
      shouldSkipPass({ at: 0, chars: 100_000, ok: false }, MIN_PASS_INTERVAL_MS + 1, 10).skip,
    ).toBe(false);
    // ...but the cooldown still holds right after the failure.
    expect(
      shouldSkipPass({ at: 0, chars: 100_000, ok: false }, MIN_PASS_INTERVAL_MS - 1, 500_000).skip,
    ).toBe(true);
  });

  it('honors the config-driven cooldown and growth (less-often triggers, A)', () => {
    const entry = { at: 0, chars: 100_000, ok: true };
    // Production knobs: 300 s cooldown, 20% regrowth.
    // 4 min after a successful pass: inside the 300 s cooldown -> skip,
    // even though the context already grew 15%.
    expect(shouldSkipPass(entry, 4 * 60_000, 115_000, 300_000, 0.2)).toMatchObject({
      skip: true,
      reason: expect.stringMatching(/cooldown/),
    });
    // 6 min later the cooldown elapsed, but 15% < the 20% requirement -> skip.
    expect(shouldSkipPass(entry, 6 * 60_000, 115_000, 300_000, 0.2)).toMatchObject({
      skip: true,
      reason: expect.stringMatching(/growth/),
    });
    // Exactly 20% regrowth re-arms.
    expect(shouldSkipPass(entry, 6 * 60_000, 120_000, 300_000, 0.2).skip).toBe(false);
    // The same 4-min / 15% state under the DEFAULT knobs (180 s / 10%)
    // re-arms — the point of A is that the knobs make triggers less often.
    expect(shouldSkipPass(entry, 4 * 60_000, 115_000).skip).toBe(false);
  });
});

describe('V2 incremental scoring (ledger)', () => {
  beforeEach(() => {
    clearScoreLedger();
  });

  /** A fetch that records every request body (state + questions). */
  function recordingFetch() {
    const bodies: Array<{ state: unknown; questions: Record<string, unknown> }> = [];
    const fn = vi.fn(async (_url: unknown, init: { body?: string | null } | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        state: unknown;
        questions?: Record<string, unknown>;
      };
      bodies.push({ state: body.state, questions: body.questions ?? {} });
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(body.questions ?? {})) {
        answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
    });
    return { fn: fn as unknown as typeof fetch, bodies };
  }

  it('asks only new calls; stable calls are carried without a round-trip', async () => {
    const { fn, bodies } = recordingFetch();
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: true, minReductionRatio: 0.1 }),
      fetch: fn,
    });

    const first = multiTranscript(['a1'.repeat(4_000), 'b1'.repeat(4_000)]);
    const o1 = await pruner.transform(first(), 'ses_ledger');
    expect(Object.keys(bodies[0]!.questions)).toHaveLength(4); // 2 calls x 2 questions
    expect(o1.report.asked).toBe(2);
    expect(o1.report.carried).toBe(0);

    // Pass 2: the same two calls (now a stable drop_result each) plus one new.
    const grown = multiTranscript(['a1'.repeat(4_000), 'b1'.repeat(4_000), 'c1'.repeat(4_000)]);
    const o2 = await pruner.transform(grown(), 'ses_ledger');

    expect(bodies).toHaveLength(2);
    expect(Object.keys(bodies[1]!.questions).sort()).toEqual(['call_t3', 'result_t3']);
    expect(o2.report.asked).toBe(1);
    expect(o2.report.carried).toBe(2);
    expect(o2.applied).toBeGreaterThan(0);
  });

  it('makes no round-trip when every candidate is carried and enforces the ratio gate', async () => {
    const { fn } = recordingFetch();
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: true }),
      fetch: fn,
    });
    const msgs = multiTranscript(['x'.repeat(4_000)])();

    await pruner.transform(msgs, 'ses_l2'); // pass 1: asked, drop_result applied
    expect(fn).toHaveBeenCalledTimes(1);

    // Pass 2 on the pass-1 output: the single call is a stable drop_result ->
    // carried; the result is already truncated, so nothing new is removable ->
    // the ratio gate rejects and no request goes out.
    const before = JSON.stringify(msgs);
    await expect(pruner.transform(msgs, 'ses_l2')).rejects.toThrow(/below minReductionRatio/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('re-asks a borderline score on every pass', async () => {
    const border = vi.fn(async (_url: unknown, init: { body?: string | null } | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        questions?: Record<string, unknown>;
      };
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(body.questions ?? {})) answers[name] = { noul: 0.55 };
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
    });
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: true }),
      fetch: border as unknown as typeof fetch,
    });
    const mk = multiTranscript(['x'.repeat(4_000)]);

    // keep (0.55 >= 0.5) but inside the margin: nothing is removed, the ratio
    // gate rejects, and the score stays unstable so the next pass asks again.
    await expect(pruner.transform(mk(), 'ses_l3')).rejects.toThrow(/below minReductionRatio/);
    await expect(pruner.transform(mk(), 'ses_l3')).rejects.toThrow(/below minReductionRatio/);
    expect(border).toHaveBeenCalledTimes(2);
  });

  it('re-asks a stable call once the reaskEvery cap is reached', async () => {
    const { fn } = recordingFetch();
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: true, reaskEvery: 2 }),
      fetch: fn,
    });
    const msgs = multiTranscript(['x'.repeat(4_000)])();

    await pruner.transform(msgs, 'ses_l4'); // pass 1: asked (drop_result applied)
    // pass 2: carried (passes 0 -> 1); the result is already truncated, so
    // nothing new is removable and the ratio gate rejects
    await expect(pruner.transform(msgs, 'ses_l4')).rejects.toThrow(/below minReductionRatio/);
    // pass 3: the cap (reaskEvery 2) is reached -> asked again
    await expect(pruner.transform(msgs, 'ses_l4')).rejects.toThrow(/below minReductionRatio/);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('asks everything on every pass when incrementalScoring is off', async () => {
    const { fn, bodies } = recordingFetch();
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: false }),
      fetch: fn,
    });
    const mk = multiTranscript(['x'.repeat(4_000)]);

    const o1 = await pruner.transform(mk(), 'ses_l5');
    await pruner.transform(mk(), 'ses_l5');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(o1.report.carried).toBe(0);
    expect(Object.keys(bodies[1]!.questions)).toHaveLength(2);
  });

  it('keeps the ledger separate per session', async () => {
    const { fn } = recordingFetch();
    const pruner = createV2Pruner({
      config: config({ incrementalScoring: true }),
      fetch: fn,
    });
    const mk = multiTranscript(['x'.repeat(4_000)]);

    await pruner.transform(mk(), 'ses_A');
    // A different session has no saved scores: it must ask again.
    const o2 = await pruner.transform(mk(), 'ses_B');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(o2.report.asked).toBe(1);
  });
});

describe('Embedded file payloads (attached photos): shrinkEmbeddedPayloads', () => {
  it('swaps large binary file payloads for the image-token proxy', () => {
    const bigB64 = 'A'.repeat(2_000_000);
    const messages: V2Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Examine this board.' }],
        files: [
          { data: bigB64, mime: 'image/jpeg', name: 'photo.jpg' },
          { data: 'short', mime: 'text/plain', name: 'note.txt' },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    const { value, embeddedChars, fileCount } = shrinkEmbeddedPayloads(messages);

    expect(fileCount).toBe(1);
    expect(embeddedChars).toBe(bigB64.length);
    const files = ((value as V2Message[])[0] as V2Message).files as Array<Record<string, unknown>>;
    // The binary payload is replaced by the proxy; small payloads stay.
    expect(files[0]!.data).toBe('0'.repeat(IMAGE_PROXY_TOKENS * 2));
    expect(files[1]!.data).toBe('short');
    // The proxy is priced at exactly IMAGE_PROXY_TOKENS by the core estimator.
    expect(estimateTokens(files[0]!.data as string)).toBe(IMAGE_PROXY_TOKENS);
    // The input is never mutated.
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('proxies parts/content containers and counts text/* payloads in full', () => {
    const binary = 'QUJD'.repeat(3000); // 12k base64-alphabet chars, no mime
    const text = 'word '.repeat(1600); // 8k chars of prose with a text mime
    const messages: V2Message[] = [
      { role: 'user', content: [{ type: 'file', data: binary }] },
      { role: 'user', files: [{ data: text, mime: 'text/plain' }] },
    ];
    const { value, embeddedChars, fileCount } = shrinkEmbeddedPayloads(messages);

    expect(fileCount).toBe(1);
    expect(embeddedChars).toBe(binary.length);
    const out = value as V2Message[];
    expect((out[0]!.content?.[0] as unknown as { data: string }).data).toBe(
      '0'.repeat(IMAGE_PROXY_TOKENS * 2),
    );
    // A text/* mime is real prompt text: it is NOT proxied.
    expect((out[1]!.files?.[0] as { data: string }).data).toBe(text);
  });

  it('returns untouched inputs by reference (no allocation)', () => {
    const messages: V2Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', files: [{ data: 'A'.repeat(100), mime: 'image/png' }] },
    ];
    const { value, embeddedChars, fileCount } = shrinkEmbeddedPayloads(messages);
    expect(value).toBe(messages);
    expect(embeddedChars).toBe(0);
    expect(fileCount).toBe(0);
    expect(shrinkEmbeddedPayloads(null as never).value).toBeNull();
  });
});

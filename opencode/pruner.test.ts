import { describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeConfig } from './config.js';
import { createOpenCodePruner, type AnyMessage } from './pruner.js';

// ---------- helpers ----------

function cfg(over: Record<string, unknown> = {}) {
  return resolveOpenCodeConfig({
    apiKey: 'test-key',
    preserveRecentMessages: 0,
    minNewEligibleChars: 10,
    truncateHeadChars: 300,
    ...over,
  });
}

function toolPart(
  callID: string,
  tool: string,
  output: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'tool',
    tool,
    callID,
    state: {
      status: 'completed',
      output,
      time: { start: 1, end: 2 },
    },
    ...extra,
  };
}

/** 3-message snapshot so the tool call at index 1 is unpinned with preserve=0. */
function snap(
  sessionID: string | undefined,
  parts: Record<string, unknown>[],
  opts: { role?: string } = {},
): AnyMessage[] {
  const info = (id: string): Record<string, unknown> =>
    sessionID === undefined ? { id, role: opts.role ?? 'assistant' } : { id, role: opts.role ?? 'assistant', sessionID };
  return [
    { info: info('m1') as AnyMessage['info'], parts: [] },
    { info: info('m2') as AnyMessage['info'], parts: parts as AnyMessage['parts'] },
    { info: info('m3') as AnyMessage['info'], parts: [] },
  ] as AnyMessage[];
}

function big(n: number, ch = 'x'): string {
  return ch.repeat(n);
}

/** fetch mock: reads Jev request body question keys, answers per mode. */
function mockFetch(mode: 'drop_result' | 'drop_call' | 'keep' = 'drop_result') {
  const fn = vi.fn(async (_url: unknown, init: Record<string, unknown>) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      questions?: Record<string, unknown>;
    };
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(body.questions ?? {})) {
      if (mode === 'keep') answers[name] = { noul: 0.9 };
      else if (mode === 'drop_result') answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
      else answers[name] = { noul: 0.1 }; // drop_call: both low
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ answers }),
    };
  });
  return fn as unknown as typeof fetch;
}

function outOf(msgs: AnyMessage[], idx = 0): string {
  const p = msgs[1]?.parts?.[idx] as { state?: { output?: unknown } };
  return p?.state?.output as string;
}

// ---------- tests ----------

describe('opencode pruner', () => {
  it('3) unknown/extraneous properties survive untouched', async () => {
    const fetch = mockFetch('drop_result');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const part = toolPart('c1', 'bash', big(2000)) as Record<string, unknown>;
    (part as Record<string, unknown>).customPart = { hello: 1 };
    const st = (part as Record<string, unknown>).state as Record<string, unknown>;
    st.extraState = 'keep-me';
    const msgs = snap('s1', [part]);
    (msgs[0] as Record<string, unknown>).customMsg = 42;
    await pruner.transform(msgs);
    expect((msgs[0] as Record<string, unknown>).customMsg).toBe(42);
    expect((msgs[1]?.parts?.[0] as Record<string, unknown>).customPart).toEqual({ hello: 1 });
    expect(((msgs[1]?.parts?.[0] as Record<string, unknown>).state as Record<string, unknown>).extraState).toBe('keep-me');
  });

  it('5) below minReductionRatio throws and leaves history untouched', async () => {
    const fetch = mockFetch('keep');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const text = big(2000);
    const msgs = snap('s1', [toolPart('c1', 'bash', text)]);
    const before = JSON.stringify(msgs);
    await expect(pruner.transform(msgs)).rejects.toThrow(/minReductionRatio/);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('5b) stateless: repeated identical input asks again (no cache)', async () => {
    const ask = vi.fn(async (state: unknown, questions: Record<string, unknown>) => {
      void state;
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions ?? {})) {
        answers[name] = { noul: 0.9 }; // keep everything -> ratio 0 -> throws
      }
      return { answers };
    });
    const asker = { ask };
    const pruner = createOpenCodePruner({ config: cfg(), asker, now: () => 0 });
    const text = big(2000);
    const first = snap('s-dedupe', [toolPart('c1', 'bash', text)]);
    await expect(pruner.transform(first)).rejects.toThrow(/minReductionRatio/);
    expect(ask).toHaveBeenCalledTimes(1);
    const second = snap('s-dedupe', [toolPart('c1', 'bash', text)]);
    const before = JSON.stringify(second);
    await expect(pruner.transform(second)).rejects.toThrow(/minReductionRatio/);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second)).toBe(before);
  });

  it('6) timeout/network/malformed leave output byte-identical and throw', async () => {
    for (const [name, f] of [
      ['reject', vi.fn(async () => { throw new Error('boom'); })],
      ['http-error', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'oops' }))],
      ['malformed', vi.fn(async () => ({ ok: true, status: 200, text: async () => 'not json' }))],
    ] as const) {
      const pruner = createOpenCodePruner({
        config: cfg(),
        fetch: f as unknown as typeof fetch,
        now: () => 0,
      });
      const text = big(2000);
      const msgs = snap('s1', [toolPart('c1', 'bash', text)]);
      const before = JSON.stringify(msgs);
      await expect(pruner.transform(msgs), name).rejects.toThrow();
      expect(JSON.stringify(msgs), name).toBe(before);
    }
  });

  it('7) pending/running parts never mutated; error parts eligible with (error)', async () => {
    const fetch = mockFetch('drop_result');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const mk = (status: string, id: string, extra: Record<string, unknown> = {}) => ({
      type: 'tool', tool: 'bash', callID: id,
      state: { status, output: big(2000, id), time: { start: 1, end: 2 }, ...extra },
    });
    const msgs = snap('s1', [
      toolPart('c-ok', 'bash', big(2000, 'z')),
      mk('error', 'e', { error: 'boom' }),
      mk('pending', 'p'),
      mk('running', 'r'),
    ]);
    const before = structuredClone(msgs);
    await pruner.transform(msgs);
    // pending + running untouched (no output yet)
    for (let i = 2; i < 4; i++) {
      expect(JSON.stringify(msgs[1]?.parts?.[i])).toBe(JSON.stringify(before[1]?.parts?.[i]));
    }
    // error part is eligible and keeps the failure signal
    expect(JSON.stringify(msgs[1]?.parts?.[1])).not.toBe(JSON.stringify(before[1]?.parts?.[1]));
    expect((msgs[1]?.parts?.[1] as { state: { output: string } }).state.output).toContain('(error)');
  });

  it('8) compacted parts excluded and never cleared', async () => {
    const fetch = mockFetch('drop_call');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const compactedPart = {
      type: 'tool', tool: 'bash', callID: 'c-old',
      state: { status: 'completed', output: big(2000, 'q'), time: { start: 1, end: 2, compacted: 99 } },
    };
    const msgs = snap('s1', [compactedPart, toolPart('c-new', 'bash', big(2000, 'w'))]);
    await pruner.transform(msgs);
    const got = msgs[1]?.parts?.[0] as { state?: { output?: string; time?: { compacted?: number } } };
    expect(got?.state?.output).toBe(big(2000, 'q'));
    expect(got?.state?.time?.compacted).toBe(99);
  });

  it('removes a drop_call tool part and its now-empty message', async () => {
    const fetch = mockFetch('drop_call');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const N = 2000;
    const msgs = snap('s1', [toolPart('c1', 'bash', big(N))]);
    const m1 = msgs[0];
    const m3 = msgs[2];
    const r = await pruner.transform(msgs);
    expect(r.status).toBe('scored');
    const flat = JSON.stringify(msgs);
    // (a) tool part absent, (b) now-empty containing message absent,
    // (c) no truncation marker remains
    expect(flat).not.toContain('c1');
    expect(flat).not.toContain('[opencode-condense truncated');
    expect(msgs.length).toBe(2);
    // (d) unrelated messages retain identity
    expect(msgs[0]).toBe(m1);
    expect(msgs[1]).toBe(m3);
  });

  it('exact truncated wording', async () => {
    // exact wording 2000-char output, head 300
    const fetch3 = mockFetch('drop_result');
    const p3 = createOpenCodePruner({ config: cfg(), fetch: fetch3, now: () => 0 });
    const head = big(300, 'h');
    const rest = big(1700, 't');
    const msgs = snap('s1', [toolPart('c1', 'bash', head + rest)]);
    const r = await p3.transform(msgs);
    expect(r.status).toBe('scored');
    expect(outOf(msgs)).toBe(
      `${head}\n[opencode-condense truncated ${2000 - 300} chars of this tool result; re-run the tool if needed]`,
    );
  });

  it('missing apiKey throws without fetch and leaves history untouched', async () => {
    const fetch = mockFetch('drop_result');
    const pruner = createOpenCodePruner({
      config: resolveOpenCodeConfig({ apiKey: undefined, preserveRecentMessages: 0, minNewEligibleChars: 10 }),
      fetch,
      now: () => 0,
    });
    const msgs = snap('s1', [toolPart('c1', 'bash', big(2000))]);
    const before = JSON.stringify(msgs);
    await expect(pruner.transform(msgs)).rejects.toThrow(/missing api key/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

// ---------- RED-first tests for review findings F2-F6 ----------
describe('opencode pruner review findings (RED first)', () => {
  it('F3) errored part is eligible and truncated note carries (error) marker', async () => {
    const fetch = mockFetch('drop_result');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const errPart = {
      type: 'tool',
      tool: 'bash',
      callID: 'e1',
      state: { status: 'error', output: big(2000, 'e'), error: 'boom failed', time: { start: 1, end: 2 } },
    };
    const msgs = snap('s1', [errPart]);
    const r = await pruner.transform(msgs);
    expect(r.status).toBe('scored');
    expect(outOf(msgs)).toContain('(error)');
  });

  it('F4) user text populates Jev goal (non-empty)', async () => {
    let seenGoal = '';
    const asker = {
      async ask(state: unknown, questions: Record<string, unknown>) {
        const g = (state as { goal?: unknown })?.goal;
        if (typeof g === 'string') seenGoal = g;
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(questions ?? {})) {
          answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
        }
        return { answers };
      },
    };
    const pruner = createOpenCodePruner({ config: cfg(), asker, now: () => 0 });
    const msgs: AnyMessage[] = [
      { info: { id: 'm1', role: 'user', sessionID: 's1' }, parts: [{ type: 'text', text: 'Fix the failing deploy script' } as unknown as AnyMessage['parts'] extends (infer U)[] | undefined ? U : never] },
      { info: { id: 'm2', role: 'assistant', sessionID: 's1' }, parts: [toolPart('c1', 'bash', big(2000)) as unknown as AnyMessage['parts'] extends (infer U)[] | undefined ? U : never] },
      { info: { id: 'm3', role: 'assistant', sessionID: 's1' }, parts: [] },
    ];
    await pruner.transform(msgs);
    expect(seenGoal.length).toBeGreaterThan(0);
  });

  it('F4b) explicit config.goal override wins over derived text', async () => {
    let seenGoal = '';
    const asker = {
      async ask(state: unknown, questions: Record<string, unknown>) {
        const g = (state as { goal?: unknown })?.goal;
        if (typeof g === 'string') seenGoal = g;
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(questions ?? {})) {
          answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
        }
        return { answers };
      },
    };
    const pruner = createOpenCodePruner({
      config: cfg({ goal: 'explicit-goal-xyz' }),
      asker,
      now: () => 0,
    });
    await pruner.transform(snap('s1', [toolPart('c1', 'bash', big(2000))]));
    expect(seenGoal).toBe('explicit-goal-xyz');
  });

  it('F5) log-entry throw leaves output untouched (mutation after log build)', async () => {
    const fetch = mockFetch('drop_result');
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const msgs = snap('s1', [toolPart('c1', 'bash', big(2000))]);
    const before = JSON.stringify(msgs);
    const orig = Number.prototype.toFixed;
    (Number.prototype as unknown as Record<string, unknown>).toFixed = function () {
      throw new Error('log build boom');
    };
    try {
      await expect(pruner.transform(msgs)).rejects.toThrow('log build boom');
      expect(JSON.stringify(msgs)).toBe(before);
    } finally {
      Number.prototype.toFixed = orig;
    }
  });
});

// ---------- RED-first: pinned calls must not be asked about ----------
describe('opencode pruner pinned exclusion', () => {
  it('pinned (first-message) tool calls are never asked about, non-pinned still are', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const asker = {
      async ask(_state: unknown, questions: Record<string, unknown>) {
        seen.push({ ...(questions ?? {}) });
        const answers: Record<string, { noul: number }> = {};
        for (const name of Object.keys(questions ?? {})) {
          answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
        }
        return { answers };
      },
    };
    const pruner = createOpenCodePruner({
      config: cfg({ preserveRecentMessages: 2, maxJevCallsPerMessage: 5 }),
      asker,
      now: () => 0,
    });
    // 5 messages, preserve=2: index 0 is pinned (first), index 1 is unpinned.
    const pinnedText = big(2000, 'p');
    const midText = big(2000, 'm');
    type ToolPart = NonNullable<NonNullable<AnyMessage['parts']>[number]>;
    const msgs: AnyMessage[] = [
      { info: { id: 'm1', role: 'assistant', sessionID: 's-pin' }, parts: [toolPart('c-pinned', 'bash', pinnedText) as unknown as ToolPart] },
      { info: { id: 'm2', role: 'assistant', sessionID: 's-pin' }, parts: [toolPart('c-mid', 'bash', midText) as unknown as ToolPart] },
      { info: { id: 'm3', role: 'assistant', sessionID: 's-pin' }, parts: [] },
      { info: { id: 'm4', role: 'assistant', sessionID: 's-pin' }, parts: [] },
      { info: { id: 'm5', role: 'assistant', sessionID: 's-pin' }, parts: [] },
    ];
    const r = await pruner.transform(msgs);
    expect(r.status).toBe('scored');
    expect(seen.length).toBeGreaterThan(0);
    const keys = seen.flatMap((q) => Object.keys(q));
    // Projection order matches message order: pinned (index 0) -> t1, mid (index 1) -> t2.
    expect(keys).not.toContain('call_t1');
    expect(keys).not.toContain('result_t1');
    expect(keys).toContain('call_t2');
    expect(keys).toContain('result_t2');
    // Fail-open: pinned output kept verbatim, non-pinned truncated.
    expect((msgs[0]?.parts?.[0] as { state: { output: string } }).state.output).toBe(pinnedText);
    expect((msgs[1]?.parts?.[0] as { state: { output: string } }).state.output).toContain(
      '[opencode-condense truncated',
    );
  });
});

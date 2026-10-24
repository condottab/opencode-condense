import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// F9: NO vi.mock('./pruner.js') — the identity test below drives the REAL
// pruner (stubbed fetch + env key) so it genuinely proves in-place mutation.
// A mocked pruner would keep passing even if the real one spliced the array.

import { CondensePlugin } from './plugin.js';

const ENV_KEY = 'TYPESAFE_API_KEY';
let savedEnv: string | undefined;
let savedFetch: typeof globalThis.fetch | undefined;

function fakeCtx(over: Record<string, unknown> = {}) {
  return {
    client: { app: { log: vi.fn() } },
    session: { messages: vi.fn() },
    directory: 'C:\\tmp',
    worktree: 'C:\\tmp',
    project: {},
    ...over,
  } as unknown as Parameters<typeof CondensePlugin>[0];
}

function toolPart(callID: string, tool: string, output: string) {
  return {
    type: 'tool',
    tool,
    callID,
    state: { status: 'completed', output, time: { start: 1, end: 2 } },
  };
}

/** 10-message snapshot so the tool call at index 2 is unpinned (preserve=6). */
function bigSnap(sessionID: string, output: string) {
  const messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ info: { id: `m${i}`, role: 'assistant', sessionID }, parts: [] });
  }
  messages[2]!.parts.push(toolPart('c1', 'bash', output));
  return messages;
}

function snap(sessionID: string | undefined, parts: Record<string, unknown>[]) {
  const info = (id: string) =>
    sessionID === undefined
      ? { id, role: 'assistant' }
      : { id, role: 'assistant', sessionID };
  return [
    { info: info('m1'), parts: [] },
    { info: info('m2'), parts },
    { info: info('m3'), parts: [] },
  ];
}

/** Stub global fetch with Jev-style answers (drop_result: keep call, drop result). */
function stubFetch() {
  const fn = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
    const body = JSON.parse((init?.body as string) ?? '{}') as {
      questions?: Record<string, unknown>;
    };
    const answers: Record<string, { noul: number }> = {};
    for (const name of Object.keys(body.questions ?? {})) {
      answers[name] = name.startsWith('call_') ? { noul: 0.9 } : { noul: 0.1 };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  globalThis.fetch = savedFetch as typeof globalThis.fetch;
});

describe('opencode plugin hook', () => {
  it('exposes EXACTLY the "experimental.chat.messages.transform" key', async () => {
    const hooks = await CondensePlugin(fakeCtx());
    expect(Object.keys(hooks)).toEqual(['experimental.chat.messages.transform']);
  });

  it('keeps output.messages array identity but permits tool-part and empty-message removal (REAL pruner)', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fn = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        questions?: Record<string, unknown>;
      };
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(body.questions ?? {})) {
        answers[name] = { noul: 0.1 }; // drop_call: both low
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
    });
    globalThis.fetch = fn as unknown as typeof globalThis.fetch;
    const output = 'x'.repeat(5000);
    const messages = bigSnap('s1', output);
    // Slice 1 gate: percent must clear compactAtPercent (default 60) for the
    // pruner to run — 65000/100000 = 65%.
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'identity-provider',
      modelID: 'identity-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const ref = messages;
    const lenBefore = messages.length;
    const partRef = messages[2]!.parts[0];
    const ctx = fakeCtx({
      client: {
        app: { log: vi.fn() },
        config: {
          providers: vi.fn(async () => ({
            data: {
              providers: [
                {
                  id: 'identity-provider',
                  models: {
                    'identity-model': {
                      id: 'identity-model',
                      limit: { context: 100000, output: 8192 },
                    },
                  },
                },
              ],
            },
          })),
        },
      },
    });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    // Real pruner ran (a Jev request went out) and drop_call removed the part…
    const fetchMock = fn;
    expect(fetchMock).toHaveBeenCalled();
    const flat = JSON.stringify(messages);
    expect(flat).not.toContain('c1');
    expect(flat).not.toContain('[opencode-condense truncated');
    // …without reassigning the outer array; surviving messages keep identity.
    expect(messages).toBe(ref);
    expect(messages.length).toBe(lenBefore - 1);
  });

  it('never calls client.session.messages', async () => {
    const sessionMessages = vi.fn();
    const ctx = fakeCtx({ session: { messages: sessionMessages } });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    const messages = snap('s1', [toolPart('c1', 'Read', 'hello')]);
    await hook({}, { messages } as unknown as never);
    expect(sessionMessages).toHaveBeenCalledTimes(0);
  });

  it('a failing pruner never propagates out of the hook', async () => {
    process.env[ENV_KEY] = 'test-key';
    globalThis.fetch = (async () => {
      throw new Error('boom');
    }) as unknown as typeof globalThis.fetch;
    const ctx = fakeCtx();
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    const messages = snap('s1', [toolPart('c1', 'Read', 'hello')]);
    await expect(
      hook({}, { messages } as unknown as never),
    ).resolves.toBeUndefined();
  });

  it('ctx without client falls back to console.error without throwing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ctx = fakeCtx({ client: undefined });
      const hooks = await CondensePlugin(ctx);
      const hook = hooks['experimental.chat.messages.transform']!;
      const messages = snap('s1', [toolPart('c1', 'Read', 'hello')]);
      await expect(
        hook({}, { messages } as unknown as never),
      ).resolves.toBeUndefined();
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe('context gate (slice 1: compactAtPercent)', () => {
  const LIMIT = 100000;

  function providersCtx(providerID: string, modelID: string, limit: number) {
    return fakeCtx({
      client: {
        app: { log: vi.fn() },
        config: {
          providers: vi.fn(async () => ({
            data: {
              providers: [
                {
                  id: providerID,
                  models: { [modelID]: { id: modelID, limit: { context: limit, output: 8192 } } },
                },
              ],
              default: {},
            },
          })),
        },
      },
    });
  }

  function tagUsage(
    messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>,
    providerID: string,
    modelID: string,
    tokens: Record<string, unknown>,
  ) {
    const last = messages[messages.length - 1]!;
    Object.assign(last.info, { providerID, modelID, tokens });
    return messages;
  }

  it('below threshold: pruner never runs (0 JEV requests, history untouched)', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const output = 'x'.repeat(5000);
    const messages = tagUsage(bigSnap('s1-gate-low', output), 'gate-low-provider', 'gate-low-model', {
      input: 10000,
      output: 2000,
      reasoning: 3000,
      cache: { read: 0, write: 0 },
    });
    // (10000 + 0 + 0) / 100000 * 100 = 10% < default 60 → skip
    const ctx = providersCtx('gate-low-provider', 'gate-low-model', LIMIT);
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect((messages[2]!.parts[0] as { state: { output: string } }).state.output).toBe(output);
    // Pin the KNOWN-percent path (not a vacuous skip): the noop log must
    // carry the computed percent, and no resolver error may be logged.
    const lowLog = (
      ctx as unknown as { client: { app: { log: ReturnType<typeof vi.fn> } } }
    ).client.app.log;
    const lowCalls = lowLog.mock.calls.map((c) => c[0] as { level: string; message: string });
    expect(
      lowCalls.some((c) => c.level === 'info' && c.message.includes('context 10% < 60%')),
    ).toBe(true);
    expect(lowCalls.some((c) => c.level === 'error')).toBe(false);
  });

  it('above threshold: normal transform behavior (JEV requested, output truncated)', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const messages = tagUsage(
      bigSnap('s1-gate-high', 'x'.repeat(5000)),
      'gate-high-provider',
      'gate-high-model',
      { input: 60000, output: 99999, reasoning: 88888, cache: { read: 4000, write: 1000 } },
    );
    // (60000 + 4000 + 1000) / 100000 * 100 = 65% >= default 60 → proceed
    const ctx = providersCtx('gate-high-provider', 'gate-high-model', LIMIT);
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    expect(fetchMock).toHaveBeenCalled();
    expect((messages[2]!.parts[0] as { state: { output: string } }).state.output).toContain(
      '[opencode-condense truncated',
    );
  });

  it('caches provider limit lookups by providerID+modelID', async () => {
    process.env[ENV_KEY] = 'test-key';
    stubFetch();
    const messages = tagUsage(
      bigSnap('s1-gate-cache', 'x'.repeat(5000)),
      'gate-cache-provider',
      'gate-cache-model',
      { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    );
    const ctx = providersCtx('gate-cache-provider', 'gate-cache-model', LIMIT);
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    await hook({}, { messages } as unknown as never);
    const providersMock = (
      ctx as unknown as { client: { config: { providers: ReturnType<typeof vi.fn> } } }
    ).client.config.providers;
    expect(providersMock).toHaveBeenCalledTimes(1);
  });
});

describe('context gate (RED: live runtime shape, run 01d53de4)', () => {
  it('resolves the limit through a this-bound SDK providers method and drives a real transform', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const messages = bigSnap('s1-bind', 'x'.repeat(5000));
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'bind-provider',
      modelID: 'bind-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    // Mirrors live opencode 1.18.31: providers() is a method that throws when
    // invoked detached (loses this._client). A detached call must not be used.
    const config = {
      providers: async function (this: unknown) {
        if (this !== config) {
          throw new TypeError("undefined is not an object (evaluating 'this._client')");
        }
        return {
          providers: [
            {
              id: 'bind-provider',
              models: {
                'bind-model': { id: 'bind-model', limit: { context: 100000, output: 8192 } },
              },
            },
          ],
          default: {},
        };
      },
    };
    const ctx = fakeCtx({ client: { app: { log: vi.fn() }, config } });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    // (65000 + 0 + 0) / 100000 * 100 = 65% >= default 60 → pruner must run.
    expect(fetchMock).toHaveBeenCalled();
    expect((messages[2]!.parts[0] as { state: { output: string } }).state.output).toContain(
      '[opencode-condense truncated',
    );
  });

  it('logs a resolver failure at error level with its reason (never silently swallowed)', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const messages = bigSnap('s1-err', 'x'.repeat(5000));
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'err-provider',
      modelID: 'err-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const log = vi.fn();
    const ctx = fakeCtx({
      client: {
        app: { log },
        config: {
          providers: async () => {
            throw new Error('limit-lookup-boom');
          },
        },
      },
    });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const calls = log.mock.calls.map((c) => c[0] as { level: string; message: string });
    expect(calls.find((c) => c.level === 'error' && c.message.includes('limit-lookup-boom'))).toBeDefined();
  });

  it('logs "no providers API" at info level (never error) when the client has no lookup', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const messages = bigSnap('s1-noapi', 'x'.repeat(5000));
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'noapi-provider',
      modelID: 'noapi-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const log = vi.fn();
    const ctx = fakeCtx({ client: { app: { log } } });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const calls = log.mock.calls.map((c) => c[0] as { level: string; message: string });
    expect(
      calls.find((c) => c.level === 'info' && c.message.includes('no providers API')),
    ).toBeDefined();
    expect(calls.some((c) => c.level === 'error')).toBe(false);
  });

  it('logs "limit absent" at info level (never error) when the payload lacks the model limit', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const messages = bigSnap('s1-absent', 'x'.repeat(5000));
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'absent-provider',
      modelID: 'absent-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const log = vi.fn();
    const ctx = fakeCtx({
      client: {
        app: { log },
        config: {
          providers: async () => ({
            providers: [{ id: 'absent-provider', models: {} }],
            default: {},
          }),
        },
      },
    });
    const hooks = await CondensePlugin(ctx);
    const hook = hooks['experimental.chat.messages.transform']!;
    await hook({}, { messages } as unknown as never);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const calls = log.mock.calls.map((c) => c[0] as { level: string; message: string });
    expect(
      calls.find((c) => c.level === 'info' && c.message.includes('limit absent')),
    ).toBeDefined();
    expect(calls.some((c) => c.level === 'error')).toBe(false);
  });
});

describe('long-history JEV invocation (preserveRecentMessages default 6, library fidelity)', () => {
  function providersCtx(log: ReturnType<typeof vi.fn>, providerID: string, modelID: string) {
    return fakeCtx({
      client: {
        app: { log },
        config: {
          providers: async () => ({
            providers: [
              {
                id: providerID,
                models: {
                  [modelID]: { id: modelID, limit: { context: 100000, output: 8192 } },
                },
              },
            ],
            default: {},
          }),
        },
      },
    });
  }

  it('a logging fetch wrapper observes the real pruner call under vitest (fetch read lazily)', async () => {
    process.env[ENV_KEY] = 'test-key';
    const seen: string[] = [];
    const inner = stubFetch();
    const wrapper = vi.fn(async (url: unknown, init?: { body?: string }) => {
      seen.push(String(url));
      return inner(url, init);
    });
    globalThis.fetch = wrapper as unknown as typeof globalThis.fetch;
    const messages = bigSnap('s1-wrap', 'x'.repeat(5000));
    Object.assign(messages[messages.length - 1]!.info, {
      providerID: 'wrap-provider',
      modelID: 'wrap-model',
      tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    const hooks = await CondensePlugin(providersCtx(vi.fn(), 'wrap-provider', 'wrap-model'));
    await hooks['experimental.chat.messages.transform']!({}, { messages } as unknown as never);
    expect(wrapper).toHaveBeenCalled();
    expect(seen.length).toBeGreaterThan(0);
  });

  it('live-shaped history (user text + reasoning/tool/step-finish, string output) drives a real JEV request', async () => {
    process.env[ENV_KEY] = 'test-key';
    const fetchMock = stubFetch();
    const sid = 's-live';
    const toolState = {
      status: 'completed',
      input: { path: 'a.txt' },
      metadata: { mode: 'read' },
      output: 'x'.repeat(5000),
      time: { start: 1, end: 2 },
      title: 'read',
    };
    // Fidelity: with the library default preserveRecentMessages=6 the pruner
    // pins the head plus the last 6, so the history must hold >6 messages
    // after the head for the tool call to be a candidate.
    const messages = [
      {
        info: { id: 'm0', role: 'user', sessionID: sid },
        parts: [{ type: 'text', id: 'p0', messageID: 'm0', sessionID: sid, text: 'lee a.txt' }],
      },
      {
        info: { id: 'm1', role: 'assistant', sessionID: sid },
        parts: [
          { type: 'reasoning', id: 'p1', messageID: 'm1', sessionID: sid, text: 'r', time: {} },
          {
            type: 'tool',
            tool: 'read',
            callID: 'c1',
            id: 'p2',
            messageID: 'm1',
            sessionID: sid,
            state: toolState,
          },
          {
            type: 'step-finish',
            id: 'p3',
            messageID: 'm1',
            sessionID: sid,
            reason: 'stop',
            cost: {},
            tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
      },
      { info: { id: 'm2', role: 'assistant', sessionID: sid }, parts: [] },
      { info: { id: 'm3', role: 'assistant', sessionID: sid }, parts: [] },
      { info: { id: 'm4', role: 'assistant', sessionID: sid }, parts: [] },
      { info: { id: 'm5', role: 'assistant', sessionID: sid }, parts: [] },
      { info: { id: 'm6', role: 'assistant', sessionID: sid }, parts: [] },
      { info: { id: 'm7', role: 'assistant', sessionID: sid }, parts: [] },
      {
        info: {
          id: 'm8',
          role: 'assistant',
          sessionID: sid,
          providerID: 'live-provider',
          modelID: 'live-model',
          tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [],
      },
    ];
    const hooks = await CondensePlugin(providersCtx(vi.fn(), 'live-provider', 'live-model'));
    await hooks['experimental.chat.messages.transform']!({}, { messages } as unknown as never);
    // 65000/100000 = 65% >= default 60 → gate passes; a live-shaped tool call
    // outside the pinned window with a 5000-char completed string output must
    // produce a JEV request.
    expect(fetchMock).toHaveBeenCalled();
  });

  it('an explicit preserve window is still honored', async () => {
    // CONDENSE_PRESERVE_RECENT_MESSAGES overrides the library default 6: on
    // the same 10-message history where the default leaves the tool at idx2
    // unpinned (JEV consulted), a window of 8 pins it (JEV not consulted).
    // Percent is 65000/100000 = 65% >= 60, so the skip pins the KNOWN-percent
    // path: no `context unknown` noop and no resolver error may appear.
    process.env[ENV_KEY] = 'test-key';
    process.env.CONDENSE_PRESERVE_RECENT_MESSAGES = '8';
    try {
      const fetchMock = stubFetch();
      const output = 'x'.repeat(5000);
      const messages = bigSnap('s-override', output);
      Object.assign(messages[messages.length - 1]!.info, {
        providerID: 'override-provider',
        modelID: 'override-model',
        tokens: { input: 65000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      const log = vi.fn();
      const hooks = await CondensePlugin(providersCtx(log, 'override-provider', 'override-model'));
      await hooks['experimental.chat.messages.transform']!({}, { messages } as unknown as never);
      expect(fetchMock).not.toHaveBeenCalled();
      expect((messages[2]!.parts[0] as { state: { output: string } }).state.output).toBe(output);
      const calls = log.mock.calls.map((c) => c[0] as { level: string; message: string });
      expect(calls.some((c) => c.message.includes('context unknown'))).toBe(false);
      expect(
        calls.some((c) => c.message.includes('limit lookup failed') || c.message.includes('no providers API') || c.message.includes('limit absent')),
      ).toBe(false);
    } finally {
      delete process.env.CONDENSE_PRESERVE_RECENT_MESSAGES;
    }
  });
});

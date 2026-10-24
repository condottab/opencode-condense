import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeConfig } from './config.js';
import { createOpenCodePruner, type AnyMessage } from './pruner.js';

// Config env reachability (every surviving option is reachable through a
// CONDENSE_* env var; precedence: explicit option > env > default; malformed
// env values fall back and never produce NaN) plus the 1.x adapter contract:
// a scorer failure propagates as a throw and leaves the history untouched
// (the historical `failed` + `cachedApplied` result contract was removed in
// favour of fail-open propagation).

const ALL_ENV = [
  'CONDENSE_MODEL',
  'CONDENSE_BASE_URL',
  'CONDENSE_MIN_REDUCTION_RATIO',
  'CONDENSE_COMPACT_AT_PERCENT',
  'CONDENSE_GOAL',
  'CONDENSE_KEEP_THRESHOLD',
  'CONDENSE_PRESERVE_RECENT_MESSAGES',
  'CONDENSE_MAX_STATE_TOKENS',
  'CONDENSE_MAX_REQUEST_TOKENS',
  'CONDENSE_TRUNCATE_HEAD_CHARS',
  'TYPESAFE_API_KEY',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

function cfg(over: Record<string, unknown> = {}) {
  return resolveOpenCodeConfig({
    apiKey: 'test-key',
    preserveRecentMessages: 0,
    truncateHeadChars: 300,
    ...over,
  });
}

function toolPart(callID: string, tool: string, output: string): Record<string, unknown> {
  return {
    type: 'tool',
    tool,
    callID,
    state: { status: 'completed', output, time: { start: 1, end: 2 } },
  };
}

function snap(sessionID: string, parts: Record<string, unknown>[]): AnyMessage[] {
  const info = (id: string): AnyMessage['info'] => ({ id, role: 'assistant', sessionID });
  return [
    { info: info('m1'), parts: [] },
    { info: info('m2'), parts: parts as AnyMessage['parts'] },
    { info: info('m3'), parts: [] },
  ] as AnyMessage[];
}

function big(n: number, ch = 'x'): string {
  return ch.repeat(n);
}

function mockFetch(mode: 'drop_result' = 'drop_result') {
  void mode;
  const fn = vi.fn(async (_url: unknown, init: Record<string, unknown>) => {
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

describe('F11 env reachability (RED first)', () => {
  it('env var honored: CONDENSE_MODEL', () => {
    for (const k of ALL_ENV) vi.stubEnv(k, '');
    vi.stubEnv('CONDENSE_MODEL', 'env-model-xyz');
    expect(resolveOpenCodeConfig({}).model).toBe('env-model-xyz');
  });

  it('malformed env falls back to default', () => {
    for (const k of ALL_ENV) vi.stubEnv(k, '');
    vi.stubEnv('CONDENSE_COMPACT_AT_PERCENT', 'not-a-number');
    vi.stubEnv('CONDENSE_MIN_REDUCTION_RATIO', 'NaN');
    const c = resolveOpenCodeConfig({});
    expect(c.compactAtPercent).toBe(60);
    expect(c.minReductionRatio).toBe(0.25);
  });

  it('explicit option overrides env', () => {
    for (const k of ALL_ENV) vi.stubEnv(k, '');
    vi.stubEnv('CONDENSE_MODEL', 'env-model');
    expect(resolveOpenCodeConfig({ model: 'explicit-model' }).model).toBe('explicit-model');
  });

  it('unset env yields documented default', () => {
    for (const k of ALL_ENV) vi.stubEnv(k, '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    const c = resolveOpenCodeConfig({});
    expect(c.model).toBe('jev-latest');
    expect(c.compactAtPercent).toBe(60);
    expect(c.minReductionRatio).toBe(0.25);
  });

  it('removed port-only env vars are ignored (no longer resolved)', () => {
    for (const k of ALL_ENV) vi.stubEnv(k, '');
    const c = resolveOpenCodeConfig({});
    expect(c).not.toHaveProperty('enabled');
    expect(c).not.toHaveProperty('timeoutMs');
    expect(c).not.toHaveProperty('protectedTools');
    expect(c).not.toHaveProperty('maxSessions');
    expect(c).not.toHaveProperty('sessionTTLMs');
    expect(c).not.toHaveProperty('maxJevCallsPerMessage');
    expect(c).not.toHaveProperty('minNewEligibleChars');
  });
});

describe('F12 status-only error marker (RED first)', () => {
  it('status-only error part gets the (error) marker on FIRST application', async () => {
    const fetch = mockFetch();
    const pruner = createOpenCodePruner({ config: cfg(), fetch, now: () => 0 });
    const errPart = {
      type: 'tool',
      tool: 'bash',
      callID: 'e-status-only',
      // NO `error` field — status-only error
      state: { status: 'error', output: big(2000, 'e'), time: { start: 1, end: 2 } },
    };
    const msgs = snap('s-f12', [errPart]);
    const r = await pruner.transform(msgs);
    expect(r.status).toBe('scored');
    const out = (msgs[1]?.parts?.[0] as { state: { output: string } }).state.output;
    expect(out).toContain('(error)');
  });
});

describe('F13 failure propagation (throw leaves history untouched)', () => {
  it('throwing asker rejects transform() and leaves the input messages untouched', async () => {
    const asker = {
      async ask() {
        throw new Error('jev boom');
      },
    };
    const pruner = createOpenCodePruner({ config: cfg(), asker, now: () => 0 });
    const msgs = snap('s-f13', [toolPart('c1', 'bash', big(2000, 'a'))]);
    const before = JSON.stringify(msgs);
    await expect(pruner.transform(msgs)).rejects.toThrow('jev boom');
    // Failure propagates from compact() (src/compact.ts via opencode/pruner.ts);
    // application happens only after a successful ask, so history is untouched.
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

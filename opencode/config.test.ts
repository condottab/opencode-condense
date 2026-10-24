import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { resolveOpenCodeConfig } from './config.js';

const ENV_KEY = 'TYPESAFE_API_KEY';
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.unstubAllEnvs();
});

describe('resolveOpenCodeConfig', () => {
  it('defaults every listed field', () => {
    const c = resolveOpenCodeConfig({});
    expect(c.minReductionRatio).toBe(0.25);
    expect(c.compactAtPercent).toBe(60);
    expect(c.model).toBe('jev-latest');
    expect(c.apiKey).toBeUndefined();
    expect(c.baseUrl).toBeUndefined();
    expect(c.goal).toBeUndefined();
  });

  it('falls back to TYPESAFE_API_KEY env', () => {
    process.env[ENV_KEY] = 'env-key-123';
    const c = resolveOpenCodeConfig({});
    expect(c.apiKey).toBe('env-key-123');
  });

  it('prefers explicit apiKey over env', () => {
    process.env[ENV_KEY] = 'env-key-123';
    const c = resolveOpenCodeConfig({ apiKey: 'explicit-key' });
    expect(c.apiKey).toBe('explicit-key');
  });

  it('ignores empty apiKey strings and empty env', () => {
    process.env[ENV_KEY] = '';
    const c = resolveOpenCodeConfig({ apiKey: '' });
    expect(c.apiKey).toBeUndefined();
  });

  it('rejects non-finite numbers back to defaults', () => {
    const c = resolveOpenCodeConfig({
      minReductionRatio: NaN,
      keepThreshold: NaN,
    });
    expect(c.minReductionRatio).toBe(0.25);
    expect(c.compactOptions.keepThreshold).toBe(0.5);
  });

  it('rejects negative minReductionRatio back to default', () => {
    const c = resolveOpenCodeConfig({ minReductionRatio: -1 });
    expect(c.minReductionRatio).toBe(0.25);
  });

  it('passes numeric CompactOptions into compactOptions (clamped value honored)', () => {
    const c = resolveOpenCodeConfig({ truncateHeadChars: 123 });
    expect(c.compactOptions.truncateHeadChars).toBe(123);
    const d = resolveOpenCodeConfig({ truncateHeadChars: -10 });
    // core clamps truncateHeadChars >= 0
    expect(d.compactOptions.truncateHeadChars).toBe(0);
    const e = resolveOpenCodeConfig({ preserveRecentMessages: 0, keepThreshold: 0.9 });
    expect(e.compactOptions.preserveRecentMessages).toBe(0);
    expect(e.compactOptions.keepThreshold).toBe(0.9);
  });

  it('mirrors goal top-level and into compactOptions', () => {
    const c = resolveOpenCodeConfig({ goal: 'ship it' });
    expect(c.goal).toBe('ship it');
    expect(c.compactOptions.goal).toBe('ship it');
    const d = resolveOpenCodeConfig({});
    expect(d.goal).toBeUndefined();
  });

  it('resolves model/baseUrl passthroughs', () => {
    expect(resolveOpenCodeConfig({ model: 'jev-x' }).model).toBe('jev-x');
    expect(resolveOpenCodeConfig({ baseUrl: 'https://example.test' }).baseUrl).toBe(
      'https://example.test',
    );
    expect(resolveOpenCodeConfig({ baseUrl: '' }).baseUrl).toBeUndefined();
  });

  it('resolves minReductionRatio: default 0.25, env, explicit override', () => {
    expect(resolveOpenCodeConfig({}).minReductionRatio).toBe(0.25);
    vi.stubEnv('CONDENSE_MIN_REDUCTION_RATIO', '0.5');
    expect(resolveOpenCodeConfig({}).minReductionRatio).toBe(0.5);
    expect(resolveOpenCodeConfig({ minReductionRatio: 0.1 }).minReductionRatio).toBe(0.1);
    vi.stubEnv('CONDENSE_MIN_REDUCTION_RATIO', 'not-a-number');
    expect(resolveOpenCodeConfig({}).minReductionRatio).toBe(0.25);
  });

  it('resolves compactAtPercent: default 60 (mirrors hooks/condense.ts HOOK_DEFAULTS)', () => {
    expect(resolveOpenCodeConfig({}).compactAtPercent).toBe(60);
  });

  it('prefers explicit compactAtPercent option over env', () => {
    vi.stubEnv('CONDENSE_COMPACT_AT_PERCENT', '75');
    expect(resolveOpenCodeConfig({ compactAtPercent: 80 }).compactAtPercent).toBe(80);
  });

  it('reads CONDENSE_COMPACT_AT_PERCENT env', () => {
    vi.stubEnv('CONDENSE_COMPACT_AT_PERCENT', '75');
    expect(resolveOpenCodeConfig({}).compactAtPercent).toBe(75);
  });

  it('falls back to 60 on malformed env and non-numeric option', () => {
    vi.stubEnv('CONDENSE_COMPACT_AT_PERCENT', 'not-a-number');
    expect(resolveOpenCodeConfig({}).compactAtPercent).toBe(60);
    vi.stubEnv('CONDENSE_COMPACT_AT_PERCENT', '');
    expect(resolveOpenCodeConfig({}).compactAtPercent).toBe(60);
    expect(
      resolveOpenCodeConfig({ compactAtPercent: 'high' as unknown as number }).compactAtPercent,
    ).toBe(60);
    expect(resolveOpenCodeConfig({ compactAtPercent: NaN }).compactAtPercent).toBe(60);
  });

  it('drops removed port-only keys (slice 3 cleanup)', () => {
    const c = resolveOpenCodeConfig({
      enabled: false,
      minNewEligibleChars: 10,
      timeoutMs: 1,
      protectedTools: ['skill'],
      maxSessions: 2,
      sessionTTLMs: 100,
      maxJevCallsPerMessage: 5,
    });
    expect(c).not.toHaveProperty('enabled');
    expect(c).not.toHaveProperty('minNewEligibleChars');
    expect(c).not.toHaveProperty('timeoutMs');
    expect(c).not.toHaveProperty('protectedTools');
    expect(c).not.toHaveProperty('maxSessions');
    expect(c).not.toHaveProperty('sessionTTLMs');
    expect(c).not.toHaveProperty('maxJevCallsPerMessage');
  });

  it('inherits the library default preserveRecentMessages (6) when unset', () => {
    vi.stubEnv('CONDENSE_PRESERVE_RECENT_MESSAGES', '');
    const c = resolveOpenCodeConfig({}, { TYPESAFE_API_KEY: 'k' });
    expect(c.compactOptions.preserveRecentMessages).toBe(6);
  });

  it('exposes only the surviving top-level keys', () => {
    expect(Object.keys(resolveOpenCodeConfig({})).sort()).toEqual(
      [
        'backgroundPass',
        'compactAtPercent',
        'compactOptions',
        'fetchTimeoutMs',
        'incrementalScoring',
        'minReductionRatio',
        'minRegrowth',
        'model',
        'passBudgetMs',
        'passCooldownMs',
        'reaskEvery',
        'scoreMargin',
      ].sort(),
    );
  });

  it('defaults decision timeouts to 60 s and incremental scoring ON', () => {
    const c = resolveOpenCodeConfig({});
    expect(c.fetchTimeoutMs).toBe(60_000);
    expect(c.passBudgetMs).toBe(60_000);
    expect(c.incrementalScoring).toBe(true);
    expect(c.scoreMargin).toBe(0.15);
    expect(c.reaskEvery).toBe(4);
  });

  it('honors explicit options for the timeout and incremental-scoring keys', () => {
    const c = resolveOpenCodeConfig({
      fetchTimeoutMs: 180_000,
      passBudgetMs: 240_000,
      incrementalScoring: false,
      scoreMargin: 0.1,
      reaskEvery: 8,
    });
    expect(c.fetchTimeoutMs).toBe(180_000);
    expect(c.passBudgetMs).toBe(240_000);
    expect(c.incrementalScoring).toBe(false);
    expect(c.scoreMargin).toBe(0.1);
    expect(c.reaskEvery).toBe(8);
  });

  it('reads the new keys from env vars (options still win)', () => {
    vi.stubEnv('CONDENSE_FETCH_TIMEOUT_MS', '123456');
    vi.stubEnv('CONDENSE_PASS_BUDGET_MS', '200000');
    vi.stubEnv('CONDENSE_INCREMENTAL_SCORING', '0');
    vi.stubEnv('CONDENSE_SCORE_MARGIN', '0.2');
    vi.stubEnv('CONDENSE_REASK_EVERY', '6');
    const c = resolveOpenCodeConfig({});
    expect(c.fetchTimeoutMs).toBe(123_456);
    expect(c.passBudgetMs).toBe(200_000);
    expect(c.incrementalScoring).toBe(false);
    expect(c.scoreMargin).toBe(0.2);
    expect(c.reaskEvery).toBe(6);
    // Explicit options beat the env values.
    const d = resolveOpenCodeConfig({ fetchTimeoutMs: 99, incrementalScoring: true });
    expect(d.fetchTimeoutMs).toBe(99);
    expect(d.incrementalScoring).toBe(true);
  });

  it('falls back to defaults on malformed timeout / margin / reask values', () => {
    const c = resolveOpenCodeConfig({
      fetchTimeoutMs: -5,
      passBudgetMs: Number.NaN,
      scoreMargin: 4,
      reaskEvery: 0,
    });
    expect(c.fetchTimeoutMs).toBe(60_000);
    expect(c.passBudgetMs).toBe(60_000);
    expect(c.scoreMargin).toBe(0.15);
    expect(c.reaskEvery).toBe(4);
  });

  it('defaults the pass re-arm knobs (3 min / 10%) and the background pass ON', () => {
    const c = resolveOpenCodeConfig({});
    expect(c.passCooldownMs).toBe(180_000);
    expect(c.minRegrowth).toBe(0.1);
    expect(c.backgroundPass).toBe(true);
  });

  it('resolves the pass re-arm knobs and background pass: options > env > default', () => {
    vi.stubEnv('CONDENSE_PASS_COOLDOWN_MS', '300000');
    vi.stubEnv('CONDENSE_MIN_REGROWTH', '0.2');
    vi.stubEnv('CONDENSE_BACKGROUND_PASS', 'off');
    const fromEnv = resolveOpenCodeConfig({});
    expect(fromEnv.passCooldownMs).toBe(300_000);
    expect(fromEnv.minRegrowth).toBe(0.2);
    expect(fromEnv.backgroundPass).toBe(false);
    // Explicit options beat the env values.
    const fromOptions = resolveOpenCodeConfig({
      passCooldownMs: 600_000,
      minRegrowth: 0.5,
      backgroundPass: true,
    });
    expect(fromOptions.passCooldownMs).toBe(600_000);
    expect(fromOptions.minRegrowth).toBe(0.5);
    expect(fromOptions.backgroundPass).toBe(true);
  });

  it('falls back on malformed pass re-arm knob values', () => {
    const c = resolveOpenCodeConfig(
      { passCooldownMs: -5, minRegrowth: 1.5, backgroundPass: undefined },
      {},
    );
    expect(c.passCooldownMs).toBe(180_000);
    expect(c.minRegrowth).toBe(0.1);
    expect(c.backgroundPass).toBe(true);
  });
});

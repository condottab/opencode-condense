import { describe, expect, it } from 'vitest';
import { computeContextPercent } from './contextUsage.js';

type Tok = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
};

function assistant(tokens: Tok, extra: Record<string, unknown> = {}) {
  return {
    info: {
      id: 'm1',
      role: 'assistant',
      sessionID: 's1',
      providerID: 'p',
      modelID: 'm',
      tokens,
      ...extra,
    },
    parts: [],
  };
}

function user() {
  return { info: { id: 'u1', role: 'user', sessionID: 's1' }, parts: [] };
}

describe('computeContextPercent', () => {
  it('returns Math.round((input + cache.read + cache.write) / limit * 100)', () => {
    const messages = [
      assistant({ input: 60000, output: 99999, reasoning: 88888, cache: { read: 4000, write: 1000 } }),
    ];
    // (60000 + 4000 + 1000) / 100000 * 100 = 65
    expect(computeContextPercent(messages, 100000)).toBe(65);
  });

  it('uses ONLY input+cache.read+cache.write (excludes output/reasoning)', () => {
    const messages = [
      assistant({ input: 100, output: 50000, reasoning: 50000, cache: { read: 0, write: 0 } }),
    ];
    // output/reasoning must not leak into the numerator: 100 / 1000 * 100 = 10
    expect(computeContextPercent(messages, 1000)).toBe(10);
  });

  it('uses the LAST assistant message', () => {
    const messages = [
      assistant({ input: 90000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      user(),
      assistant({ input: 10000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    ];
    expect(computeContextPercent(messages, 100000)).toBe(10);
  });

  it('tolerates partial/missing token fields with ?? 0', () => {
    const messages = [assistant({ input: 50000 })];
    expect(computeContextPercent(messages, 100000)).toBe(50);
  });

  it('returns null when no assistant message exists', () => {
    expect(computeContextPercent([user()], 100000)).toBeNull();
    expect(computeContextPercent([], 100000)).toBeNull();
  });

  it('returns null when limit is 0/missing/invalid', () => {
    const messages = [
      assistant({ input: 60000, output: 0, reasoning: 0, cache: { read: 4000, write: 1000 } }),
    ];
    expect(computeContextPercent(messages, 0)).toBeNull();
    expect(computeContextPercent(messages, undefined as unknown as number)).toBeNull();
    expect(computeContextPercent(messages, NaN)).toBeNull();
    expect(computeContextPercent(messages, -1000)).toBeNull();
    expect(computeContextPercent(messages, '100000' as unknown as number)).toBeNull();
  });

  it('handles the verbatim live tokens shape (extra total field ignored)', () => {
    // Observed live (run 01d53de4): tokens carry an extra `total` field.
    // (1673 + 55296 + 0) / 1000000 * 100 = 5.6969 -> 6
    const tokens = {
      total: 57569,
      input: 1673,
      output: 85,
      reasoning: 515,
      cache: { write: 0, read: 55296 },
    };
    const messages = [assistant(tokens as unknown as Tok)];
    expect(computeContextPercent(messages, 1000000)).toBe(6);
  });
});

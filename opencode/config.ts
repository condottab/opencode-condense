import { resolveOptions } from '../src/compact.js';
import type { CompactOptions } from '../src/types.js';

export interface OpenCodeConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  minReductionRatio: number;
  compactAtPercent?: number;
  goal?: string;
  keepThreshold?: number;
  preserveRecentMessages?: number;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  truncateHeadChars?: number;
  /** Hard cap for one decision round-trip, ms. Default 60000. */
  fetchTimeoutMs?: number;
  /** Total budget for all decision round-trips of one pass, ms. Default 60000. */
  passBudgetMs?: number;
  /**
   * Pass re-arm cooldown: minimum ms between two pass attempts of one session.
   * Default 180000 (3 min). Raise to trigger less often.
   */
  passCooldownMs?: number;
  /**
   * Pass re-arm growth: after a SUCCESSFUL pass the context must regrow by at
   * least this fraction of its post-pass size before the next pass re-arms.
   * Default 0.1 (10%). Raise to trigger less often.
   */
  minRegrowth?: number;
  /**
   * Off-critical-path pass: when true (default) the slow decision round-trips
   * run in the BACKGROUND on a deep copy and the scored decisions are applied
   * on the NEXT dispatch, so the current dispatch is never frozen by a pass.
   * When false the original blocking behaviour is used (the pass runs inline,
   * held on the dispatch path).
   */
  backgroundPass?: boolean;
  /**
   * Incremental scoring: reuse the previous pass's scores for calls whose
   * decision is stable, ask only new / borderline / anchor calls. Default true.
   */
  incrementalScoring?: boolean;
  /** A saved score that cannot flip its decision within this margin is stable. Default 0.15. */
  scoreMargin?: number;
  /** A stable call is re-asked at least once every N passes (drift anchor). Default 4. */
  reaskEvery?: number;
}

export interface ResolvedOpenCodeConfig
  extends Required<Pick<OpenCodeConfig, 'minReductionRatio' | 'compactAtPercent'>> {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  goal?: string;
  compactOptions: CompactOptions;
  /** Absent: the pruner default (60 s per round-trip, 60 s per pass). */
  fetchTimeoutMs?: number;
  passBudgetMs?: number;
  /** Absent: the plugin default (3 min re-arm cooldown). */
  passCooldownMs?: number;
  /** Absent: the plugin default (10% re-arm growth). */
  minRegrowth?: number;
  /** Absent: background (off-critical-path) pass ON. */
  backgroundPass?: boolean;
  /** Absent: incremental scoring ON with the pruner defaults. */
  incrementalScoring?: boolean;
  scoreMargin?: number;
  reaskEvery?: number;
}

function optionString(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nonNegative(value: number, fallback: number): number {
  return value < 0 ? fallback : value;
}

// F11: every config key is reachable via env var. Precedence:
// explicit options > env var > default. Malformed / empty / non-finite
// env values fall back to the next source (never NaN, never throw).
function envString(env: Record<string, unknown>, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function envNumber(env: Record<string, unknown>, key: string): number | undefined {
  const raw = env[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveOpenCodeConfig(
  options: Record<string, unknown> = {},
  env: Record<string, unknown> = process.env as Record<string, unknown>,
): ResolvedOpenCodeConfig {
  const apiKey =
    optionString(options, 'apiKey') ??
    envString(env, 'CONDENSE_API_KEY') ??
    envString(env, 'TYPESAFE_API_KEY');
  const model = optionString(options, 'model') ?? envString(env, 'CONDENSE_MODEL') ?? 'jev-latest';
  const baseUrl = optionString(options, 'baseUrl') ?? envString(env, 'CONDENSE_BASE_URL');
  const goal = optionString(options, 'goal') ?? envString(env, 'CONDENSE_GOAL');
  const pickNumber = (key: string, envKey: string, fallback: number): number => {
    const direct = options[key];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    return envNumber(env, envKey) ?? fallback;
  };
  const minReductionRatio = nonNegative(
    pickNumber('minReductionRatio', 'CONDENSE_MIN_REDUCTION_RATIO', 0.25),
    0.25,
  );
  // Slice 1 gate: mirrors hooks/condense.ts HOOK_DEFAULTS.compactAtPercent (60).
  // Explicit option > CONDENSE_COMPACT_AT_PERCENT > 60; malformed falls back to 60.
  const compactAtPercent = pickNumber('compactAtPercent', 'CONDENSE_COMPACT_AT_PERCENT', 60);

  // Decision timeouts (option 1): options > env > default, positive only. A
  // pass that outgrows its budget used to be cut mid-pass; a healthy local
  // backend needs headroom, so the defaults stay 60 s but the caller may raise.
  const pickPositive = (key: string, envKey: string, fallback: number): number => {
    const value = pickNumber(key, envKey, fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const fetchTimeoutMs = pickPositive('fetchTimeoutMs', 'CONDENSE_FETCH_TIMEOUT_MS', 60_000);
  const passBudgetMs = pickPositive('passBudgetMs', 'CONDENSE_PASS_BUDGET_MS', 60_000);

  // Pass re-arm knobs (less-often triggers): options > env > default. The
  // defaults mirror the historical hard-coded constants (3 min, 10%).
  const passCooldownMs = pickPositive('passCooldownMs', 'CONDENSE_PASS_COOLDOWN_MS', 180_000);
  const minRegrowth = (() => {
    const value = pickNumber('minRegrowth', 'CONDENSE_MIN_REGROWTH', 0.1);
    return Number.isFinite(value) && value >= 0 && value < 1 ? value : 0.1;
  })();

  // Incremental scoring (option 2): a kill switch plus two tuning knobs.
  const pickBool = (key: string, envKey: string, fallback: boolean): boolean => {
    const direct = options[key];
    if (typeof direct === 'boolean') return direct;
    const fromEnv = envString(env, envKey);
    if (fromEnv === undefined) return fallback;
    if (/^(1|true|yes|on)$/i.test(fromEnv)) return true;
    if (/^(0|false|no|off)$/i.test(fromEnv)) return false;
    return fallback;
  };
  const incrementalScoring = pickBool('incrementalScoring', 'CONDENSE_INCREMENTAL_SCORING', true);
  // Off-critical-path pass (option B): options > env > default (ON). Only an
  // explicit false restores the original blocking behaviour.
  const backgroundPass = pickBool('backgroundPass', 'CONDENSE_BACKGROUND_PASS', true);
  const scoreMargin = (() => {
    const value = pickNumber('scoreMargin', 'CONDENSE_SCORE_MARGIN', 0.15);
    return value >= 0 && value <= 1 ? value : 0.15;
  })();
  const reaskEvery = (() => {
    const value = pickNumber('reaskEvery', 'CONDENSE_REASK_EVERY', 4);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 4;
  })();

  const compactEnvKeys = {
    keepThreshold: 'CONDENSE_KEEP_THRESHOLD',
    preserveRecentMessages: 'CONDENSE_PRESERVE_RECENT_MESSAGES',
    maxStateTokens: 'CONDENSE_MAX_STATE_TOKENS',
    maxRequestTokens: 'CONDENSE_MAX_REQUEST_TOKENS',
    truncateHeadChars: 'CONDENSE_TRUNCATE_HEAD_CHARS',
  } as const;
  const compactNumbers: Partial<CompactOptions> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number') {
      (compactNumbers as Record<string, number>)[key] = value;
    } else {
      const fromEnv = envNumber(env, compactEnvKeys[key]);
      if (fromEnv !== undefined) {
        (compactNumbers as Record<string, number>)[key] = fromEnv;
      }
    }
  }
  // Fidelity: no port-level default for preserveRecentMessages. When neither
  // the option nor CONDENSE_PRESERVE_RECENT_MESSAGES is set, the key stays
  // absent so resolveOptions falls back to the library default (6, see
  // src/compact.ts DEFAULT_OPTIONS and hooks/condense.ts resolveHookConfig).
  const compactOptions = resolveOptions({ ...compactNumbers, ...(goal ? { goal } : {}) });

  const resolved: ResolvedOpenCodeConfig = {
    minReductionRatio,
    compactAtPercent,
    model,
    compactOptions,
    fetchTimeoutMs,
    passBudgetMs,
    passCooldownMs,
    minRegrowth,
    backgroundPass,
    incrementalScoring,
    scoreMargin,
    reaskEvery,
  };
  if (apiKey !== undefined) resolved.apiKey = apiKey;
  if (baseUrl !== undefined) resolved.baseUrl = baseUrl;
  if (goal !== undefined) resolved.goal = goal;
  return resolved;
}

import type { Plugin } from '@opencode-ai/plugin';
import { resolveOpenCodeConfig } from './config.js';
import {
  computeContextPercent,
  lastAssistantInfo,
  type AnyMessageLike,
} from './contextUsage.js';
import { createOpenCodePruner, type AnyMessage, type TransformOutcome } from './pruner.js';

const SERVICE = 'opencode-condense';

// Resolved model context limits, keyed `${providerID}\0${modelID}` so the
// provider listing is fetched once per model instead of once per turn.
const contextLimitCache = new Map<string, number>();
const CONTEXT_LIMIT_CACHE_MAX = 500;

function contextCacheKey(providerID: string, modelID: string): string {
  return `${providerID}\0${modelID}`;
}

type ProviderEntry = {
  id?: unknown;
  models?: Record<string, { id?: unknown; limit?: { context?: unknown } } | undefined> | undefined;
};

// Accepted providers shapes: `{ providers: Array<Provider> }` (from
// `client.config.providers()`, i.e. GET /config/providers which the SDK types
// as `{ providers: Array<Provider> }`) or `{ all: Array<...> }` (from
// `client.provider.list()`), optionally wrapped in `{ data: ... }`. The
// `models` field itself IS an id-keyed map (`Record<modelID, { limit }>`) and
// is matched both by key and by inner `id`. A providers-level id-keyed map is
// NOT accepted: no SDK shape types it that way, so only arrays are read here.
function limitFromProvidersPayload(
  payload: unknown,
  providerID: string,
  modelID: string,
): number | undefined {
  const root =
    (payload as { data?: unknown } | null)?.data !== undefined
      ? (payload as { data: unknown }).data
      : payload;
  const lists: unknown[] = [];
  const byKey = (root as { providers?: unknown } | null)?.providers;
  const byAll = (root as { all?: unknown } | null)?.all;
  if (Array.isArray(byKey)) lists.push(...byKey);
  if (Array.isArray(byAll)) lists.push(...byAll);
  const valid = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  for (const entry of lists) {
    const provider = entry as ProviderEntry | null;
    if (!provider || typeof provider !== 'object' || provider.id !== providerID) continue;
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    const direct = valid(models[modelID]?.limit?.context);
    if (direct !== undefined) return direct;
    for (const model of Object.values(models)) {
      if (model?.id === modelID) {
        const viaId = valid(model?.limit?.context);
        if (viaId !== undefined) return viaId;
      }
    }
  }
  return undefined;
}

// Resolve Model.limit.context for the active model via the plugin ctx client:
// client.config.providers() (preferred) else client.provider.list().
// Missing client / API / model -> undefined (caller treats percent as null -> SKIP).
async function resolveContextLimit(
  ctx: Ctx | undefined,
  providerID: string,
  modelID: string,
): Promise<number | undefined> {
  const key = contextCacheKey(providerID, modelID);
  const hit = contextLimitCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const client = (ctx as { client?: unknown } | undefined)?.client as
      | {
          config?: { providers?: () => Promise<unknown> };
          provider?: { list?: () => Promise<unknown> };
        }
      | undefined;
    // Call the SDK lookup as a METHOD (never detached): the opencode client
    // implementations read instance state via `this`, so a detached call
    // throws (live: `TypeError: undefined is not an object (this._client)`).
    let payload: unknown;
    if (client?.config !== undefined && typeof client.config.providers === 'function') {
      payload = await client.config.providers();
    } else if (client?.provider !== undefined && typeof client.provider.list === 'function') {
      payload = await client.provider.list();
    } else {
      safeLog(
        ctx,
        'info',
        `${SERVICE}: context limit unavailable (no providers API on plugin client) for ${providerID}/${modelID}; percent unknown`,
      );
      return undefined;
    }
    const limit = limitFromProvidersPayload(payload, providerID, modelID);
    if (limit !== undefined) {
      contextLimitCache.set(key, limit);
      while (contextLimitCache.size > CONTEXT_LIMIT_CACHE_MAX) {
        const oldest = contextLimitCache.keys().next();
        if (oldest.done) break;
        contextLimitCache.delete(oldest.value);
      }
    } else {
      safeLog(
        ctx,
        'info',
        `${SERVICE}: context limit absent from providers payload for ${providerID}/${modelID}; percent unknown`,
      );
    }
    return limit;
  } catch (err) {
    // Resolver failure is OBSERVABLE (error level, with reason) — never
    // silently swallowed. Distinct from "limit absent" above.
    safeLog(
      ctx,
      'error',
      `${SERVICE}: context limit lookup failed for ${providerID}/${modelID} (${err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)}); percent unknown`,
    );
    return undefined;
  }
}

// Plugin-level user config injection is a follow-up: config comes from
// env/defaults only (apiKey via process.env.TYPESAFE_API_KEY).

type Ctx = Parameters<Plugin>[0];

function safeLog(ctx: Ctx | undefined, level: 'info' | 'error', message: string): void {
  try {
    const log = (ctx as { client?: { app?: { log?: unknown } } } | undefined)?.client?.app?.log;
    if (typeof log === 'function') {
      const payload = { service: SERVICE, level, message };
      // SDK (hey-api Options) nests under `body`; a flat wrapper reads
      // top-level keys. Send both shapes so either consumer works.
      (log as (args: unknown) => unknown).call(
        (ctx as { client?: { app?: unknown } } | undefined)?.client?.app,
        { ...payload, body: { ...payload } },
      );
      return;
    }
  } catch {
    // fall through to console below; logging must never throw
  }
  try {
    console.error(`[${SERVICE}] ${message}`);
  } catch {
    // last resort: stay silent, never throw out of the hook
  }
}

/** `${d.id}:${d.tool}:${d.action}/call=…/result=…` — mirrors hooks/condense.ts decisionLog. */
function decisionLine(d: {
  id: string;
  tool: string;
  action: string;
  keepCall: number;
  keepResult: number;
}): string {
  return `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`;
}

function outcomeLines(outcome: TransformOutcome): { level: 'info' | 'error'; text: string }[] {
  const { report } = outcome;
  const pct = Math.round(report.ratio * 100);
  const summary =
    `${SERVICE}: scored ${report.scored}, applied ${report.applied}, ` +
    `removed ${report.removedChars}/${report.scoredChars} chars (${pct}% reduction)`;
  const decisions = report.decisions.map(decisionLine).join(' ');
  return [
    { level: 'info', text: summary },
    { level: 'info', text: decisions ? `decisions: ${decisions}` : 'decisions: (none)' },
  ];
}

export const CondensePlugin: Plugin = async (ctx) => {
  const config = resolveOpenCodeConfig();
  const pruner = createOpenCodePruner({ config });
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      try {
        const messages = (output as { messages?: unknown } | undefined)?.messages;
        if (!Array.isArray(messages)) return;
        // Slice 1 gate (mirrors hooks/condense.ts turn.complete percent gate):
        // below config.compactAtPercent (or unknown percent) -> return without
        // invoking the pruner. Percent comes from SDK usage tokens only.
        const lastInfo = lastAssistantInfo(messages as AnyMessageLike[]);
        let percent: number | null = null;
        const providerID =
          typeof lastInfo?.providerID === 'string' ? lastInfo.providerID : undefined;
        const modelID = typeof lastInfo?.modelID === 'string' ? lastInfo.modelID : undefined;
        if (providerID !== undefined && modelID !== undefined) {
          const limit = await resolveContextLimit(ctx, providerID, modelID);
          percent = computeContextPercent(messages as AnyMessageLike[], limit);
        }
        if (percent === null || percent < config.compactAtPercent) {
          const detail =
            percent === null
              ? 'context unknown'
              : `context ${percent}% < ${config.compactAtPercent}%`;
          safeLog(ctx, 'info', `${SERVICE}: noop (${detail})`);
          return;
        }
        // NEVER reassign output.messages: pruner.transform mutates it in place
        // (truncating drop_result parts, splicing out drop_call parts and
        // emptied messages), so the outer array identity is preserved.
        const outcome = await pruner.transform(messages as AnyMessage[]);
        for (const line of outcomeLines(outcome)) safeLog(ctx, line.level, line.text);
      } catch (error) {
        safeLog(
          ctx,
          'error',
          `${SERVICE}: hook error (${error instanceof Error ? error.message : String(error)}); history left untouched`,
        );
      }
    },
  };
};

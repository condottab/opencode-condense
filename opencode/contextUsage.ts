// Slice 1: `compactAtPercent` context gate helpers.
//
// SDK facts (no character counts anywhere here):
// - AssistantMessage.tokens = { input, output, reasoning, cache: { read, write } }
//   (node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:117-125).
// - opencode's own contextTokens numerator is input + cache.read + cache.write.
// - Model.limit.context is the denominator
//   (node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1323-1326;
//   Provider models map at :1344-1346, provider list payloads at :2584-2640).
// - Token fields may be partial on the wire, so missing fields read as 0.

export interface TokensLike {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown } | null | undefined;
}

export interface MessageInfoLike {
  id?: unknown;
  role?: unknown;
  sessionID?: unknown;
  providerID?: unknown;
  modelID?: unknown;
  tokens?: TokensLike | null | undefined;
}

export interface AnyMessageLike {
  info?: MessageInfoLike | null | undefined;
  parts?: unknown;
}

function infoOf(message: AnyMessageLike | undefined): MessageInfoLike | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const info = (message as { info?: unknown }).info as MessageInfoLike | undefined;
  return info && typeof info === 'object' ? info : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The last assistant message's info, or undefined when there is none. */
export function lastAssistantInfo(
  messages: readonly AnyMessageLike[],
): MessageInfoLike | undefined {
  let last: MessageInfoLike | undefined;
  for (const message of messages) {
    const info = infoOf(message);
    if (info?.role === 'assistant') last = info;
  }
  return last;
}

/**
 * Context usage percent for the last assistant message:
 * `Math.round((tokens.input + tokens.cache.read + tokens.cache.write) / limit * 100)`.
 * Output/reasoning tokens are excluded (they are not context occupancy).
 * Returns null when there is no assistant message, no tokens, or the resolved
 * model limit is 0/missing/invalid. The limit is a caller-provided parameter
 * so provider resolution + caching live with the caller (plugin.ts).
 */
export function computeContextPercent(
  messages: readonly AnyMessageLike[],
  limit: unknown,
): number | null {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return null;
  const info = lastAssistantInfo(messages);
  if (!info) return null;
  const tokens = info.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const used = num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write);
  return Math.round((used / limit) * 100);
}

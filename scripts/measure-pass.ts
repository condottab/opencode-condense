/**
 * Measure the real per-batch cost of one condense pass against a decision
 * endpoint (e.g. a local llama.cpp scorer, or scripts/fake-decision-server.mjs),
 * using the core's own pipeline (fitState -> batchCalls -> buildDecisionRequest)
 * with options and a synthetic transcript shaped like a heavy session
 * (webfetch-heavy, ~1M chars, 55 calls).
 *
 * Run: CONDENSE_SCORER_BASE_URL=http://127.0.0.1:8971 npx tsx scripts/measure-pass.ts
 *       (or set CONDENSE_SCORER_BASE_URL / CONDENSE_API_KEY / CONDENSE_SCORER_MODEL)
 */
import {
  batchCalls,
  buildDecisionRequest,
  collectToolCalls,
  fitState,
  questionsFor,
  resolveOptions,
  type Message,
  type ToolCall,
} from '../src/index.js';

const BASE_URL = process.env.CONDENSE_SCORER_BASE_URL ?? '';
const API_KEY = process.env.CONDENSE_API_KEY ?? '';
const MODEL = process.env.CONDENSE_SCORER_MODEL ?? '';
if (!BASE_URL) {
  throw new Error(
    'CONDENSE_SCORER_BASE_URL is required (e.g. http://127.0.0.1:8971 for scripts/fake-decision-server.mjs)',
  );
}

// --- synthetic transcript, shaped like the heavy session -------------------
function callMsg(id: string, tool: string, resultChars: number): [Message, Message] {
  const input = JSON.stringify({ url: `https://example.com/doc/${id}?page=7`, depth: 2 });
  const filler = `{"key":0,"value":"some payload text for the compaction state builder to consider"}\n`;
  let body = '';
  while (body.length < resultChars) body += filler;
  body = body.slice(0, resultChars);
  const assistant: Message = {
    role: 'assistant',
    text: `Looking at ${id}, fetching the next page now.`,
    toolUses: [{ tool_use_id: id, tool, input, text: input }],
  };
  const user: Message = {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: id, text: body, isError: false }],
  };
  return [assistant, user];
}

const tools = ['webfetch', 'shell', 'execute'];
const messages: Message[] = [{ role: 'user', text: 'Investigate the 1C compaction project and produce a status report.', toolUses: [] }];
let i = 0;
while (messages.length < 140) {
  const tool = tools[i % 3];
  const size = tool === 'webfetch' ? 20_000 + ((i * 37) % 25_000) : 2_000 + ((i * 91) % 8_000);
  const [a, u] = callMsg(`t${i}`, tool, size);
  messages.push(a, u);
  if (i % 5 === 4) messages.push({ role: 'assistant', text: `Progress note ${i}: summarizing findings so far, moving to the next file.`, toolUses: [] });
  i += 1;
}
messages.push({ role: 'assistant', text: 'Done investigating; writing the final report.', toolUses: [] });

const chars = messages.reduce((s, m) => s + m.text.length + (m.toolUses?.reduce((x, t) => x + t.text.length, 0) ?? 0) + (m.toolResults?.reduce((x, t) => x + t.text.length, 0) ?? 0), 0);
console.log(`transcript: ${messages.length} messages, ~${chars} chars`);

// --- production-like options ------------------------------------------------
const resolved = resolveOptions({
  maxStateTokens: 7500,
  maxRequestTokens: 9000,
  preserveRecentMessages: 6,
});

const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
const candidates = calls.filter((c) => !c.pinned);
console.log(`calls: ${calls.length} total, ${candidates.length} candidates`);

const fitted = fitState(messages, calls, resolved);
console.log(`state: ~${fitted.tokens} est tokens (stage: ${fitted.stage || 'none'}), ${fitted.state.length} chars`);

const batches = batchCalls(candidates, fitted.tokens, resolved);
const est = (s: string) => Math.ceil(s.length / 4);
console.log(`batches: ${batches.length}`);
batches.forEach((b, idx) => {
  const q = Object.fromEntries(b.flatMap((c) => Object.entries(questionsFor(c))));
  console.log(`  batch ${idx + 1}: ${b.length} calls, ~${est(JSON.stringify(q))} est question tokens`);
});

// --- warm up (wake from sleep) ----------------------------------------------
const warm = buildDecisionRequest({ apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL }, 'warmup', {
  probe: { type: 'noul', instructions: 'warmup' },
});
const t0 = Date.now();
const wr = await fetch(warm.url, { method: 'POST', headers: warm.headers, body: warm.body });
const wt = Date.now() - t0;
const wtext = await wr.text();
console.log(`warmup: ${wr.status} in ${wt} ms (sleep-wake not counted)${wtext.length < 200 ? ' -> ' + wtext : ''}`);

// --- time every batch exactly like the plugin asks them (sequentially) ------
const results: Array<{ batch: number; calls: number; ms: number; inputTokens: number | null; outputTokens: number | null }> = [];
let totalMs = 0;
for (let idx = 0; idx < batches.length; idx += 1) {
  const batch = batches[idx]!;
  const questions = Object.fromEntries(batch.flatMap((c) => Object.entries(questionsFor(c))));
  const req = buildDecisionRequest({ apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL }, fitted.state, questions);
  const bodyChars = req.body.length;
  const start = Date.now();
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const ms = Date.now() - start;
  const text = await res.text();
  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  try {
    const parsed = JSON.parse(text) as { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
    usage = parsed.usage ?? null;
  } catch { /* ignore */ }
  totalMs += ms;
  results.push({ batch: idx + 1, calls: batch.length, ms, inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null });
  console.log(
    `batch ${idx + 1}: ${batch.length} calls, body ~${est(req.body)} est tokens, ` +
      `usage=in:${usage?.input_tokens ?? '?'} out:${usage?.output_tokens ?? '?'} -> ${ms} ms ` +
      `(${res.ok ? 'ok' : 'HTTP ' + res.status})`,
  );
}

console.log('--- summary ---');
console.log(`total: ${results.length} requests, ${candidates.length} calls, ${Math.round(totalMs / 1000)} s (${(totalMs / 1000).toFixed(1)} s per request on average)`);
const withUsage = results.filter((r) => r.inputTokens !== null);
if (withUsage.length > 0) {
  const avgIn = Math.round(withUsage.reduce((s, r) => s + (r.inputTokens ?? 0), 0) / withUsage.length);
  const avgOut = Math.round(withUsage.reduce((s, r) => s + (r.outputTokens ?? 0), 0) / withUsage.length);
  const avgMs = Math.round(withUsage.reduce((s, r) => s + r.ms, 0) / withUsage.length);
  console.log(`avg per request: ${avgMs} ms, ${avgIn} input tokens, ${avgOut} output tokens`);
  console.log(`implied prefill: ${avgIn} tok in ~${Math.round((avgIn / 3183) * 1000)} ms at 3183 tok/s; implied decode: ${avgOut} tok in ~${Math.round(avgMs - (avgIn / 3183) * 1000)} ms`);
}
console.log(`extrapolation: a pass asking ${candidates.length} calls would take ~${Math.round(totalMs / 1000)} s of HTTP alone (observed production passes: 67-170 s for 20-48 asked calls)`);

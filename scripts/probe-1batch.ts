/**
 * Time a SINGLE large prefill (one 12-question batch, ~13k tokens) against a
 * decision endpoint. Useful as a VRAM-spill check for local llama.cpp scorers:
 * if the prefill throughput is ~4-6x lower than a small prefill on the same
 * model, the ubatch compute buffer is being spilled to system RAM.
 *
 * Run: CONDENSE_SCORER_BASE_URL=http://127.0.0.1:8971 npx tsx scripts/probe-1batch.ts
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
} from '../src/index.js';

const BASE_URL = process.env.CONDENSE_SCORER_BASE_URL ?? '';
const API_KEY = process.env.CONDENSE_API_KEY ?? '';
const MODEL = process.env.CONDENSE_SCORER_MODEL ?? '';
if (!BASE_URL) {
  throw new Error(
    'CONDENSE_SCORER_BASE_URL is required (e.g. http://127.0.0.1:8971 for scripts/fake-decision-server.mjs)',
  );
}

function callMsg(id: string, tool: string, resultChars: number): [Message, Message] {
  const input = JSON.stringify({ url: `https://example.com/doc/${id}?page=7`, depth: 2 });
  const filler = `{"key":0,"value":"some payload text for the compaction state builder to consider"}\n`;
  let body = '';
  while (body.length < resultChars) body += filler;
  body = body.slice(0, resultChars);
  const assistant: Message = { role: 'assistant', text: `Looking at ${id}, fetching the next page now.`, toolUses: [{ tool_use_id: id, tool, input, text: input }] };
  const user: Message = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: body, isError: false }] };
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

const resolved = resolveOptions({ maxStateTokens: 7500, maxRequestTokens: 9000, preserveRecentMessages: 6 });
const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
const candidates = calls.filter((c) => !c.pinned);
const fitted = fitState(messages, calls, resolved);
const batches = batchCalls(candidates, fitted.tokens, resolved);
const batch = batches[0]!;
const questions = Object.fromEntries(batch.flatMap((c) => Object.entries(questionsFor(c))));
const req = buildDecisionRequest({ apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL }, fitted.state, questions);
const est = (s: string) => Math.ceil(s.length / 4);

// warm (server may be asleep)
const warm = buildDecisionRequest({ apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL }, 'warmup', { probe: { type: 'noul', instructions: 'warmup' } });
const w0 = Date.now();
await (await fetch(warm.url, { method: 'POST', headers: warm.headers, body: warm.body })).text();
console.log(`warmup ${Date.now() - w0} ms (not counted)`);

// the single big prefill, timed 3x (median) to absorb jitter
const runs: number[] = [];
for (let r = 0; r < 3; r += 1) {
  const t0 = Date.now();
  const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const ms = Date.now() - t0;
  const text = await res.text();
  let inTok: number | null = null;
  try { inTok = (JSON.parse(text) as { usage?: { input_tokens?: number } })?.usage?.input_tokens ?? null; } catch { /* ignore */ }
  runs.push(ms);
  console.log(`run ${r + 1}: ${batch.length} calls, body ~${est(req.body)} est tok, usage=in:${inTok ?? '?'} -> ${ms} ms (${res.ok ? 'ok' : 'HTTP ' + res.status})`);
  if (inTok) console.log(`         implied prefill: ${inTok} tok in ${ms} ms = ${Math.round(inTok / (ms / 1000))} tok/s`);
}
runs.sort((a, b) => a - b);
const med = runs[Math.floor(runs.length / 2)]!;
console.log(`median single-batch: ${med} ms`);
console.log(med < 90_000 ? '=> NO SPILL (buffer resident in VRAM)' : '=> LIKELY WDDM SPILL (buffer paged to system RAM)');

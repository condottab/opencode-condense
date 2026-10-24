// Local stand-in for the Jev scoring endpoint (dev/testing only).
// Answer policy: keep the call (0.9), drop the result (0.1).
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PORT = Number(process.argv[2] ?? 8971);
// Overridable via argv[3]; defaults to the OS temp directory so the repo
// carries no machine-specific paths.
const DUMP = process.argv[3] ?? join(tmpdir(), "decision-seen.json");
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
    const answers = {};
    for (const name of Object.keys(body.questions ?? {})) {
      answers[name] = { noul: name.startsWith("call_") ? 0.9 : 0.1 };
    }
    try {
      writeFileSync(DUMP, JSON.stringify({
        url: req.url,
        authorization: req.headers.authorization ? "(present)" : "(absent)",
        model: body.model,
        questionCount: Object.keys(body.questions ?? {}).length,
        state: body.state,
      }, null, 2));
    } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "fake-decision", answers }));
  });
});
server.listen(PORT, "127.0.0.1", () => process.stdout.write(`fake decision listening on http://127.0.0.1:${PORT}\n`));

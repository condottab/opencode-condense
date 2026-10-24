import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnv(
  targetPath?: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  const resolved =
    targetPath ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    return;
  }
  const parsed = parseDotEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    env[key] ??= value;
  }
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function resolveDemoConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): { apiKey?: string; baseUrl?: string; model?: string } {
  return {
    apiKey: clean(env["CONDENSE_API_KEY"]) ?? clean(env["TYPESAFE_API_KEY"]),
    baseUrl: clean(env["CONDENSE_BASE_URL"]),
    model: clean(env["CONDENSE_MODEL"]),
  };
}

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv, parseDotEnv, resolveDemoConfig } from "./demoConfig.js";

describe("parseDotEnv", () => {
  it("skips comments and blank lines", () => {
    const parsed = parseDotEnv("# comment\n\nTYPESAFE_API_KEY=abc\n   # indented?\n");
    expect(parsed).toEqual({ TYPESAFE_API_KEY: "abc" });
  });

  it("skips lines with no = and empty keys", () => {
    const parsed = parseDotEnv("NOEQUALS\n=novalue\n   =   \nA=1");
    expect(parsed).toEqual({ A: "1" });
  });

  it("keeps further = inside the value", () => {
    const parsed = parseDotEnv("CONDENSE_MODEL=a=b=c");
    expect(parsed).toEqual({ CONDENSE_MODEL: "a=b=c" });
  });

  it("strips one matching pair of surrounding quotes", () => {
    const parsed = parseDotEnv('A="hello"\nB=\'world\'\nC="unmatched\'\nD=plain');
    expect(parsed).toEqual({ A: "hello", B: "world", C: '"unmatched\'', D: "plain" });
  });

  it("trims keys and values and keeps empty value as empty string", () => {
    const parsed = parseDotEnv("  TYPESAFE_API_KEY  =  abc  \nEMPTY=\n");
    expect(parsed).toEqual({ TYPESAFE_API_KEY: "abc", EMPTY: "" });
  });
});

describe("loadDotEnv", () => {
  it("is a silent no-op on a missing file", () => {
    const env: Record<string, string> = {};
    expect(() => loadDotEnv(join(tmpdir(), `no-such-env-${Date.now()}`), env)).not.toThrow();
    expect(env).toEqual({});
  });

  it("does not override an already-set env var (??= precedence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dotenv-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "TYPESAFE_API_KEY=from-file\nCONDENSE_MODEL=from-file\n");
      const env: Record<string, string> = { TYPESAFE_API_KEY: "from-env" };
      loadDotEnv(file, env);
      expect(env).toEqual({ TYPESAFE_API_KEY: "from-env", CONDENSE_MODEL: "from-file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveDemoConfig", () => {
  it("maps empty/whitespace-only values to undefined and trims the rest", () => {
    expect(resolveDemoConfig({})).toEqual({ apiKey: undefined, baseUrl: undefined, model: undefined });
    expect(resolveDemoConfig({ TYPESAFE_API_KEY: "", CONDENSE_BASE_URL: "   ", CONDENSE_MODEL: "" })).toEqual({
      apiKey: undefined,
      baseUrl: undefined,
      model: undefined,
    });
    expect(
      resolveDemoConfig({
        TYPESAFE_API_KEY: "  abc  ",
        CONDENSE_BASE_URL: " https://example.test ",
        CONDENSE_MODEL: " m ",
      }),
    ).toEqual({ apiKey: "abc", baseUrl: "https://example.test", model: "m" });
  });
});

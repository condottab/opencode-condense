import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  exports?: Record<string, unknown>;
  engines?: Record<string, unknown>;
  files?: unknown;
  scripts?: Record<string, unknown>;
};

// Local equivalent of opencode's extractExportValue (see task spec).
function extractExportValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  for (const key of ['import', 'default']) {
    const nested = (value as Record<string, unknown>)[key];
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

function parseVersion(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

// Minimal semver-range check supporting space-separated AND of
// comparators (>=, >, <=, <, =/bare) — enough for ">=1.18.31 <2.0.0"
// and the two pinned versions under test.
function satisfiesRange(range: string, version: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*(\d+\.\d+\.\d+(?:[-+].*)?)$/.exec(part);
    if (!m) return false;
    const op = m[1] ?? '';
    const target = parseVersion(m[2]!);
    if (!target) return false;
    const cmp = compare(v, target);
    switch (op) {
      case '>=':
        return cmp >= 0;
      case '>':
        return cmp > 0;
      case '<=':
        return cmp <= 0;
      case '<':
        return cmp < 0;
      case '=':
      case '':
        return cmp === 0;
      default:
        return false;
    }
  });
}

describe('npm plugin package surface', () => {
  it('exposes exports["./server"] resolving to dist/opencode-plugin.js', () => {
    const raw = (pkg.exports as Record<string, unknown>)?.['./server'];
    expect(raw, 'exports["./server"] must exist').toBeDefined();
    const resolved = extractExportValue(raw);
    expect(typeof resolved, 'exports["./server"] must resolve via import/default to a string').toBe('string');
    expect(dirname(resolved!)).toBe('./dist');
    expect(basename(resolved!)).toBe('opencode-plugin.js');
  });

  it('keeps exports["."] pointing at dist/index.js with index.d.ts types', () => {
    const entry = (pkg.exports as Record<string, unknown>)?.['.'] as Record<string, unknown>;
    expect(entry).toBeDefined();
    expect(extractExportValue(entry)).toBe('./dist/index.js');
    expect(entry['types']).toBe('./dist/index.d.ts');
  });

  it('declares engines.opencode covering both the 1.x bundle and the 2.x source route', () => {
    const range = (pkg.engines as Record<string, unknown>)?.['opencode'];
    expect(typeof range, 'engines.opencode must be a string range').toBe('string');
    expect(satisfiesRange(range as string, '1.18.31'), `engines.opencode ${range} must satisfy 1.18.31`).toBe(true);
    expect(satisfiesRange(range as string, '2.0.0'), `engines.opencode ${range} must satisfy 2.0.0`).toBe(true);
  });

  it('still ships dist via files', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
  });

  it('guards publishing with a prepublishOnly build of both bundles', () => {
    const script = (pkg.scripts as Record<string, unknown>)?.['prepublishOnly'];
    expect(typeof script, 'scripts.prepublishOnly must exist').toBe('string');
    expect(script as string).toContain('build');
    expect(script as string).toContain('build:plugin');
  });
});

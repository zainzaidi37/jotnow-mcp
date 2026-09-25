import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The package ships from src/ alone, to npm and to the public mirror, and the
// mirror has no packages/core or any other workspace path to resolve against.
// So no module or test may reach outside packages/mcp. The vendored copy in
// src/core is the only sanctioned route to core. #741's tests once imported
// core's fixtures directly: CI stayed green, and the mirror's typecheck would
// have failed.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Static and dynamic imports, re-exports, vi.mock targets, and
// `new URL(…, import.meta.url)` file reads, each with a relative specifier.
const RELATIVE_REFERENCE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\bnew URL\(\s*)['"](\.{1,2}\/[^'"]*)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?ts|[cm]?js)$/.test(entry.name) ? [path] : [];
  });
}

export function escapingReferences(files: { path: string; source: string }[]): string[] {
  const escapes: string[] = [];
  for (const { path, source } of files) {
    for (const match of source.matchAll(RELATIVE_REFERENCE)) {
      const specifier = match[1] ?? '';
      const target = resolve(dirname(path), specifier);
      if (relative(packageRoot, target).startsWith('..')) {
        escapes.push(`${relative(packageRoot, path)}: ${specifier}`);
      }
    }
  }
  return escapes;
}

describe('package boundary', () => {
  it('no source or test file references a path outside packages/mcp', () => {
    // This file is skipped: its detector cases below are escaping specifiers
    // written as data.
    const self = fileURLToPath(import.meta.url);
    const files = sourceFiles(join(packageRoot, 'src'))
      .filter((path) => path !== self)
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(20);
    expect(escapingReferences(files)).toEqual([]);
  });

  // The detector itself, so a regex that silently matches nothing cannot pass.
  it.each([
    [`import { png } from '../../core/src/image-bytes-fixtures.js';`],
    [`export * from '../../core/src/index.js';`],
    [`const m = await import('../../../scripts/x.mjs');`],
    [`vi.mock('../../core/src/index.js', () => ({}));`],
    [`readFileSync(new URL('../../../docs/x.md', import.meta.url));`],
    [`import '../../core/src/side-effect.js';`],
  ])('flags %s', (source) => {
    expect(escapingReferences([{ path: join(packageRoot, 'src', 'x.ts'), source }])).toHaveLength(
      1,
    );
  });

  it.each([
    [`import { x } from './core/index.js';`],
    [`import { y } from '../local/pointer.js';`],
    [`readFileSync(new URL('../README.md', import.meta.url));`],
  ])('allows %s', (source) => {
    const path = join(packageRoot, 'src', 'local', 'x.ts');
    expect(escapingReferences([{ path, source }])).toEqual([]);
  });
});

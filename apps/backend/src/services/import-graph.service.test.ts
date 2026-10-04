import { describe, it, expect } from 'vitest';

import {
  extractImports,
  resolveImportSpecifier,
  buildFileIndex,
  parsePathAliases,
} from './import-graph.service';

const FILES = [
  'src/index.ts',
  'src/services/payment.service.ts',
  'src/services/subscription.service.ts',
  'src/repositories/subscription.repository.ts',
  'src/repositories/index.ts',
  'src/legacy/index.ts',
  'src/legacy/old.ts',
  'src/utils/format.ts',
  'src/components/Button.tsx',
  'shared/types.ts',
  'config/index.ts',
  'packages/app/src/index.ts',
  'tsconfig.json',
];

describe('extractImports()', () => {
  it('reads static imports', () => {
    const src = `
      import { createSubscription } from './services/subscription.service';
      import PaymentService from '@/services/payment.service';
    `;
    expect(extractImports(src)).toEqual([
      './services/subscription.service',
      '@/services/payment.service',
    ]);
  });

  it('reads type-only imports, which are still real dependencies', () => {
    const src = `import type { Repo } from '../types';
          import { type Foo, bar } from './bar';`;
    expect(extractImports(src)).toEqual(['../types', './bar']);
  });

  it('reads re-exports from barrels', () => {
    const src = `export { a } from './a';
          export * from './b';
          export * as ns from './c';`;
    expect(extractImports(src)).toEqual(['./a', './b', './c']);
  });

  it('reads bare side-effect imports', () => {
    expect(extractImports(`import './polyfill';`)).toEqual(['./polyfill']);
  });

  it('reads dynamic imports', () => {
    const src = `const m = await import('./heavy.service');
                  const n = await import( \`./tpl.service\` );`;
    expect(extractImports(src)).toEqual(['./heavy.service', './tpl.service']);
  });

  it('reads CommonJS requires', () => {
    expect(extractImports(`const x = require('./legacy/old');`)).toEqual(['./legacy/old']);
  });

  it('reads multi-line import statements', () => {
    const src = `import {
      a,
      b,
    } from './multi';`;
    expect(extractImports(src)).toEqual(['./multi']);
  });

  it('ignores paths inside line comments', () => {
    const src = `// import { x } from './commented';
                import { y } from './real';`;
    expect(extractImports(src)).toEqual(['./real']);
  });

  it('ignores paths inside block comments', () => {
    const src = `/*
       import { x } from './block-commented';
    */
    import { y } from './real';`;
    expect(extractImports(src)).toEqual(['./real']);
  });

  it('ignores paths inside string literals', () => {
    const src = `const msg = "import { x } from './stringy'";
                import { y } from './real';`;
    expect(extractImports(src)).toEqual(['./real']);
  });

  it('ignores a word that merely starts with import, like important', () => {
    const src = `const important = 'x';
                this.imported = 1;
                import { y } from './real';`;
    expect(extractImports(src)).toEqual(['./real']);
  });

  it('handles an import with no module (side-effect only, no semicolon)', () => {
    expect(extractImports(`import 'polyfill'`)).toEqual(['polyfill']);
  });

  it('handles an empty file without throwing', () => {
    expect(extractImports('')).toEqual([]);
  });

  it('does not hang on unterminated string or comment', () => {
    expect(() => extractImports('const s = "unterminated')).not.toThrow();
    expect(() => extractImports('/* unterminated')).not.toThrow();
  });
});

describe('resolveImportSpecifier()', () => {
  const index = buildFileIndex(FILES);

  it('resolves an explicit extension', () => {
    expect(resolveImportSpecifier('./format.ts', 'src/utils/index.ts', index)).toBe(
      'src/utils/format.ts',
    );
  });

  it('resolves an implicit extension', () => {
    expect(resolveImportSpecifier('./services/payment.service', 'src/index.ts', index)).toBe(
      'src/services/payment.service.ts',
    );
  });

  it('resolves a directory index', () => {
    expect(resolveImportSpecifier('./repositories', 'src/index.ts', index)).toBe(
      'src/repositories/index.ts',
    );
  });

  it('resolves a parent-relative path', () => {
    expect(resolveImportSpecifier('../utils/format', 'src/services/a.ts', index)).toBe(
      'src/utils/format.ts',
    );
  });

  it('resolves a path that climbs out of a nested directory', () => {
    expect(resolveImportSpecifier('../../services/subscription.service', 'src/deep/nest/x.ts', index)).toBe(
      'src/services/subscription.service.ts',
    );
  });

  it('resolves .js to its .ts source, as compiled output does', () => {
    expect(resolveImportSpecifier('./format.js', 'src/utils/index.ts', index)).toBe(
      'src/utils/format.ts',
    );
  });

  it('returns null for a bare npm package', () => {
    expect(resolveImportSpecifier('react', 'src/index.ts', index)).toBeNull();
    expect(resolveImportSpecifier('lodash/fp', 'src/index.ts', index)).toBeNull();
  });

  it('returns null for a scoped npm subpath', () => {
    expect(resolveImportSpecifier('@types/node', 'src/index.ts', index)).toBeNull();
  });

  it('returns null for an absolute URL', () => {
    expect(resolveImportSpecifier('https://cdn.example.com/x.js', 'src/index.ts', index)).toBeNull();
  });

  it('returns null when the file is not in the repo', () => {
    expect(resolveImportSpecifier('./does-not-exist', 'src/index.ts', index)).toBeNull();
  });

  it('does not treat a sibling directory prefix as a file match', () => {
    expect(resolveImportSpecifier('./index', 'src/index.ts', index)).toBe('src/index.ts');
    expect(resolveImportSpecifier('./index.ts', 'src/index.ts', index)).toBe('src/index.ts');
  });
});

describe('tsconfig path aliases', () => {
  it('parses baseUrl and paths', () => {
    const aliases = parsePathAliases({
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['src/*'], '@shared/*': ['shared/*'] },
      },
    });

    expect(aliases).not.toBeNull();
    expect(aliases?.baseUrl).toBe('');
    expect(aliases?.entries).toHaveLength(2);
  });

  it('returns null when no aliases are declared', () => {
    expect(parsePathAliases({ compilerOptions: { strict: true } })).toBeNull();
    expect(parsePathAliases({})).toBeNull();
    expect(parsePathAliases(null)).toBeNull();
  });

  it('ignores malformed path entries', () => {
    expect(
      parsePathAliases({ compilerOptions: { paths: { '@/*': 'not-an-array', 'bad': [] } } }),
    ).toBeNull();
  });

  it('resolves a single-star alias', () => {
    const aliases = parsePathAliases({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } });
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('@/services/payment.service', 'src/index.ts', index, aliases)).toBe(
      'src/services/payment.service.ts',
    );
  });

  it('resolves the exact-match form of an alias', () => {
    const aliases = parsePathAliases({
      compilerOptions: { baseUrl: '.', paths: { '@shared/types': ['shared/types.ts'] } },
    });
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('@shared/types', 'src/index.ts', index, aliases)).toBe(
      'shared/types.ts',
    );
  });

  it('prefers the longest matching prefix', () => {
    const aliases = parsePathAliases({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@shared/*': ['shared/*'] } },
    });
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('@shared/types', 'src/index.ts', index, aliases)).toBe(
      'shared/types.ts',
    );
  });

  it('resolves an alias to a directory index', () => {
    const aliases = parsePathAliases({ compilerOptions: { baseUrl: '.', paths: { '@config': ['config'] } } });
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('@config', 'src/index.ts', index, aliases)).toBe('config/index.ts');
  });

  it('resolves a root-relative alias without baseUrl', () => {
    const aliases = parsePathAliases({ compilerOptions: { paths: { 'shared/*': ['shared/*'] } } });
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('shared/types', 'src/index.ts', index, aliases)).toBe(
      'shared/types.ts',
    );
  });

  it('accounts for a nested tsconfig location when resolving baseUrl', () => {
    const aliases = parsePathAliases(
      { compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } },
      'packages/app/tsconfig.json',
    );
    const index = buildFileIndex(FILES);

    expect(resolveImportSpecifier('@/index', 'src/services/a.ts', index, aliases)).toBe(
      'packages/app/src/index.ts',
    );
  });
});
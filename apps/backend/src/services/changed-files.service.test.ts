import { describe, it, expect, vi } from 'vitest';
import { fetchChangedFileContents, isScannablePath, MAX_SCANNER_FILES } from './changed-files.service';

function makeGh(contents: Record<string, string | null>) {
  return {
    getFileContent: vi.fn(async (_owner: string, _repo: string, path: string) => {
      if (!(path in contents)) return null;
      return contents[path];
    }),
  } as any;
}

describe('isScannablePath', () => {
  it('accepts common source files', () => {
    expect(isScannablePath('src/app.ts')).toBe(true);
    expect(isScannablePath('pkg/main.py')).toBe(true);
    expect(isScannablePath('cmd/server.go')).toBe(true);
  });

  it('rejects assets, extensionless files and traversal', () => {
    expect(isScannablePath('assets/logo.png')).toBe(false);
    expect(isScannablePath('Makefile')).toBe(false);
    expect(isScannablePath('/etc/passwd')).toBe(false);
    expect(isScannablePath('../secrets.ts')).toBe(false);
  });

  it('rejects files inside excluded directories', () => {
    expect(isScannablePath('node_modules/pkg/index.js')).toBe(false);
    expect(isScannablePath('dist/bundle.js')).toBe(false);
  });
});

describe('fetchChangedFileContents', () => {
  it('fetches only scannable paths and returns their content', async () => {
    const gh = makeGh({
      'src/app.ts': 'const a = 1;',
      'assets/logo.png': 'binary',
      'README.md': '# hello',
    });

    const contents = await fetchChangedFileContents(gh, 'o', 'r', 'sha', [
      'src/app.ts',
      'assets/logo.png',
      'README.md',
    ]);

    expect([...contents.keys()]).toEqual(['src/app.ts']);
    expect(contents.get('src/app.ts')).toBe('const a = 1;');
    expect(gh.getFileContent).toHaveBeenCalledTimes(1);
  });

  it('skips files that cannot be read rather than throwing', async () => {
    const gh = {
      getFileContent: vi.fn(async (_o: string, _r: string, path: string) => {
        if (path === 'src/boom.ts') throw new Error('rate limited');
        return 'ok';
      }),
    } as any;

    const contents = await fetchChangedFileContents(gh, 'o', 'r', 'sha', ['src/boom.ts', 'src/ok.ts']);
    expect([...contents.keys()]).toEqual(['src/ok.ts']);
  });

  it('caps the number of files fetched', async () => {
    const gh = makeGh({});
    const paths = Array.from({ length: MAX_SCANNER_FILES + 25 }, (_, i) => `src/f${i}.ts`);

    await fetchChangedFileContents(gh, 'o', 'r', 'sha', paths);

    expect(gh.getFileContent).toHaveBeenCalledTimes(MAX_SCANNER_FILES);
  });
});
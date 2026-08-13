import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isMainModule } from './entry.js';

const directories: string[] = [];

// Node resolves the ESM entrypoint to its real path before forming
// import.meta.url, so expected URLs are built from realpathSync — this also
// neutralizes macOS's /var -> /private/var tmpdir symlink.
const entryUrl = (path: string): string => pathToFileURL(realpathSync(path)).href;

const makeTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'talos-entry-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('isMainModule', () => {
  it('matches a direct invocation path', () => {
    const directory = makeTempDirectory();
    const script = join(directory, 'main.js');
    writeFileSync(script, '');
    expect(isMainModule(entryUrl(script), script)).toBe(true);
  });

  it('matches an invocation through a symlink, as installed by install-worker.sh', () => {
    const directory = makeTempDirectory();
    const script = join(directory, 'talos-worker.js');
    writeFileSync(script, '');
    const link = join(directory, 'talos-worker');
    symlinkSync(script, link);
    expect(isMainModule(entryUrl(script), link)).toBe(true);
  });

  it('rejects a different module, a missing path, and a missing argv', () => {
    const directory = makeTempDirectory();
    const script = join(directory, 'main.js');
    writeFileSync(script, '');
    expect(isMainModule(pathToFileURL(join(directory, 'other.js')).href, script)).toBe(false);
    expect(isMainModule(entryUrl(script), join(directory, 'missing.js'))).toBe(false);
    expect(isMainModule(pathToFileURL(script).href, undefined)).toBe(false);
  });
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Executor } from './executor.js';
import {
  BrowserExecutorFactory,
  resolveTaskProfileDirectory
} from './browser-executor-factory.js';

const root = (): string => mkdtempSync(join(tmpdir(), 'talos-profile-root-'));

const task = (profileId?: string) => ({
  id: 'task_1',
  kind: 'browse' as const,
  goal: 'test',
  interaction: 'autonomous' as const,
  ...(profileId === undefined ? {} : { profileId })
});

const mode = (path: string): number => statSync(path).mode & 0o777;

describe('BrowserExecutorFactory', () => {
  it('maps named profiles beneath the private profile root', async () => {
    const profileRoot = root();
    const paths: string[] = [];
    const factory = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: (options) => {
        paths.push(options.profilePath);
        return { execute: async () => ({}), close: async () => undefined };
      }
    });

    await factory.create(task('profile_A-1.test'));

    const expected = join(profileRoot, 'profiles', 'profile_A-1.test');
    expect(paths).toEqual([expected]);
    expect(mode(expected)).toBe(0o700);
  });

  it.each(['../other', 'nested/profile', 'nested\\profile', '..', '.', 'profile..other', 'profile id'])(
    'rejects unsafe profile id %s',
    async (profileId) => {
      await expect(resolveTaskProfileDirectory(root(), task(profileId))).rejects.toThrow(
        'profile id is not safe for local storage'
      );
    }
  );

  it('creates and removes an ephemeral directory on close', async () => {
    const profileRoot = root();
    let selectedPath = '';
    const factory = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: (options) => {
        selectedPath = options.profilePath;
        return { execute: async () => ({}), close: async () => undefined };
      }
    });

    const executor = await factory.create(task());

    expect(selectedPath.startsWith(join(profileRoot, 'ephemeral'))).toBe(true);
    expect(existsSync(selectedPath)).toBe(true);
    expect(mode(selectedPath)).toBe(0o700);
    await executor.close();
    expect(existsSync(selectedPath)).toBe(false);
  });

  it('removes ephemeral state after executor and close errors', async () => {
    const profileRoot = root();
    let selectedPath = '';
    const delegate: Executor = {
      execute: async () => {
        throw new Error('browser failed');
      },
      close: async () => {
        throw new Error('context close failed');
      }
    };
    const factory = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: (options) => {
        selectedPath = options.profilePath;
        return delegate;
      }
    });
    const executor = await factory.create(task());

    await expect(executor.execute(
      { type: 'wait', milliseconds: 1 },
      { taskId: 'task_1', masking: false }
    )).rejects.toThrow('browser failed');
    await expect(executor.close()).rejects.toThrow('context close failed');
    expect(existsSync(selectedPath)).toBe(false);
  });

  it('removes ephemeral state when executor construction fails', async () => {
    const profileRoot = root();
    const factory = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: () => {
        throw new Error('executor construction failed');
      }
    });

    await expect(factory.create(task())).rejects.toThrow('executor construction failed');
    expect(existsSync(join(profileRoot, 'ephemeral'))).toBe(true);
    expect(readdirSync(join(profileRoot, 'ephemeral'))).toEqual([]);
  });

  it('reuses and preserves a named profile across sequential tasks', async () => {
    const profileRoot = root();
    const paths: string[] = [];
    const factory = new BrowserExecutorFactory({
      profileRoot,
      createBrowserExecutor: (options) => {
        paths.push(options.profilePath);
        return { execute: async () => ({}), close: async () => undefined };
      }
    });

    const first = await factory.create(task('profile_a'));
    const marker = join(paths[0] ?? '', 'cookie-state');
    writeFileSync(marker, 'persisted');
    await first.close();
    const second = await factory.create({ ...task('profile_a'), id: 'task_2' });
    await second.close();

    expect(paths[0]).toBe(paths[1]);
    expect(readFileSync(marker, 'utf8')).toBe('persisted');
  });

  it('rejects shared CDP state because it cannot honor directory isolation', () => {
    expect(() => new BrowserExecutorFactory({
      profileRoot: root(),
      cdpEndpoint: 'http://localhost:9222'
    })).toThrow('TALOS_CDP_ENDPOINT cannot provide per-task profile isolation');
  });
});

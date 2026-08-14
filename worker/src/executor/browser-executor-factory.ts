import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { TaskEnvelope } from '../runtime/client.js';
import { BrowserExecutor, type BrowserExecutorOptions } from './browser-executor.js';
import type { Executor } from './executor.js';

const profileIdSchema = z.string()
  .regex(/^[A-Za-z0-9._-]+$/, 'profile id is not safe for local storage')
  .refine((value) => value !== '.' && !value.includes('..'), {
    message: 'profile id is not safe for local storage'
  });

export interface BrowserExecutorFactoryOptions {
  profileRoot: string;
  cdpEndpoint?: string;
  createBrowserExecutor?: (options: BrowserExecutorOptions) => Executor;
}

interface TaskProfileDirectory {
  path: string;
  ephemeral: boolean;
}

export class BrowserExecutorFactory {
  public constructor(private readonly options: BrowserExecutorFactoryOptions) {
    if (options.cdpEndpoint !== undefined) {
      throw new Error(
        'TALOS_CDP_ENDPOINT cannot provide per-task profile isolation; use worker-managed Chromium'
      );
    }
  }

  public async create(task: TaskEnvelope): Promise<Executor> {
    const directory = await resolveTaskProfileDirectory(this.options.profileRoot, task);
    const create = this.options.createBrowserExecutor ?? ((options) => new BrowserExecutor(options));
    try {
      const executor = create({ profilePath: directory.path });
      return directory.ephemeral
        ? new EphemeralExecutor(executor, directory.path)
        : executor;
    } catch (error) {
      if (directory.ephemeral) {
        await rm(directory.path, { recursive: true, force: true });
      }
      throw error;
    }
  }
}

export const resolveTaskProfileDirectory = async (
  profileRoot: string,
  task: TaskEnvelope
): Promise<TaskProfileDirectory> => {
  await privateDirectory(profileRoot);
  if (task.profileId !== undefined) {
    const parsed = profileIdSchema.safeParse(task.profileId);
    if (!parsed.success) throw new Error('profile id is not safe for local storage');
    const profileId = parsed.data;
    const profilesRoot = join(profileRoot, 'profiles');
    await privateDirectory(profilesRoot);
    const path = join(profilesRoot, profileId);
    await privateDirectory(path);
    return { path, ephemeral: false };
  }
  const ephemeralRoot = join(profileRoot, 'ephemeral');
  await privateDirectory(ephemeralRoot);
  const path = await mkdtemp(join(ephemeralRoot, 'task-'));
  await chmod(path, 0o700);
  return { path, ephemeral: true };
};

const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
};

class EphemeralExecutor implements Executor {
  public constructor(
    private readonly executor: Executor,
    private readonly directory: string
  ) {}

  public execute(...parameters: Parameters<Executor['execute']>): ReturnType<Executor['execute']> {
    return this.executor.execute(...parameters);
  }

  public async close(): Promise<void> {
    try {
      await this.executor.close();
    } finally {
      await rm(this.directory, { recursive: true, force: true });
    }
  }
}

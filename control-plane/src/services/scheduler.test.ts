import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../storage/memory-repository.js';
import { Scheduler } from './scheduler.js';

const task = (
  requirements = {},
  kind: 'browse' | 'computer_use' = 'browse',
  profileId?: string,
  poolId?: string
) => ({
  id: 't',
  userId: 'u',
  kind,
  goal: 'x',
  constraints: { requirements },
  mode: 'read_only' as const,
  interaction: 'autonomous' as const,
  status: 'submitted' as const,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
  findings: [],
  artifacts: [],
  ...(profileId === undefined ? {} : { profileId }),
  ...(poolId === undefined ? {} : { poolId })
});

describe('Scheduler eligibility', () => {
  it('matches tags, capacity, visibility, enrollment, and pinning', async () => {
    const repository = new MemoryRepository();
    const scheduler = new Scheduler(repository);
    await repository.savePool({ id: 'private', visibility: 'private', ownerUserId: 'owner', tags: {} });
    await repository.savePool({ id: 'platform', visibility: 'platform', tags: {} });
    await repository.saveMachine({ id: 'a', poolId: 'private', tags: { os: 'macos' }, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    await repository.saveMachine({ id: 'b', poolId: 'platform', tags: { os: 'linux', computer_use: true }, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    await repository.saveProfile({ id: 'p', userId: 'u', machineId: 'b' });
    expect(await scheduler.isEligible(task({ os: 'linux' }), 'b', 'u')).toBeDefined();
    expect(await scheduler.isEligible(task({ os: 'macos' }), 'b', 'u')).toBeUndefined();
    expect(await scheduler.isEligible(task({ os: 'macos' }), 'a', 'u')).toBeUndefined();
    expect(await scheduler.isEligible(task({}, 'computer_use'), 'b', 'u')).toBeDefined();
    expect(await scheduler.isEligible(task({}, 'computer_use'), 'a', 'owner')).toBeUndefined();
    expect(await scheduler.isEligible(task({}, 'browse', 'p'), 'a', 'u')).toBeUndefined();
    expect(await scheduler.isEligible(task({}, 'browse', undefined, 'platform'), 'b', 'u')).toBeDefined();
    expect(await scheduler.isEligible(task({}, 'browse', undefined, 'private'), 'b', 'u')).toBeUndefined();
    await repository.saveMachine({ id: 'full', poolId: 'platform', tags: {}, capacity: 1, activeLeases: 1, online: true, workerTokenHash: 'x' });
    expect(await scheduler.isEligible(task(), 'full', 'u')).toBeUndefined();
    await repository.saveMachine({ id: 'offline', poolId: 'platform', tags: {}, capacity: 1, activeLeases: 0, online: false, workerTokenHash: 'x' });
    expect(await scheduler.isEligible(task(), 'offline', 'u')).toBeUndefined();
    await repository.saveMachine({
      id: 'testing-only',
      poolId: 'platform',
      tags: { testing_task_contract: 'talos.testing-task/v1' },
      capacity: 1,
      activeLeases: 0,
      online: true,
      workerTokenHash: 'x'
    });
    expect(await scheduler.isEligible(task(), 'testing-only', 'u')).toBeUndefined();
  });

  it('enforces org group sharing with closed-by-default semantics', async () => {
    const repository = new MemoryRepository();
    const scheduler = new Scheduler(repository);
    await repository.savePool({ id: 'org', visibility: 'org', ownerUserId: 'owner', sharedWithGroups: ['eng'], tags: {} });
    await repository.savePool({ id: 'closed', visibility: 'org', ownerUserId: 'owner', tags: {} });
    await repository.saveMachine({ id: 'org-machine', poolId: 'org', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    await repository.saveMachine({ id: 'closed-machine', poolId: 'closed', tags: {}, capacity: 1, activeLeases: 0, online: true, workerTokenHash: 'x' });
    const orgTask = task({}, 'browse', undefined, 'org');
    const closedTask = task({}, 'browse', undefined, 'closed');
    expect(await scheduler.isEligible(orgTask, 'org-machine', 'member', ['eng'])).toBeDefined();
    expect(await scheduler.isEligible(orgTask, 'org-machine', 'member', ['sales'])).toBeUndefined();
    expect(await scheduler.isEligible(orgTask, 'org-machine', 'owner')).toBeDefined();
    expect(await scheduler.isEligible(closedTask, 'closed-machine', 'member', ['eng'])).toBeUndefined();
    expect(await scheduler.isEligible(closedTask, 'closed-machine', 'owner')).toBeDefined();
  });

});

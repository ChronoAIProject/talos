import { describe, expect, it } from 'vitest';
import { MemoryRepository } from './memory-repository.js';

describe('MemoryRepository owner listings', () => {
  it('returns only pools and profiles owned by the requested user', async () => {
    const repository = new MemoryRepository();
    await repository.savePool({
      id: 'alice-pool',
      visibility: 'private',
      ownerUserId: 'alice',
      tags: {}
    });
    await repository.savePool({
      id: 'bob-pool',
      visibility: 'private',
      ownerUserId: 'bob',
      tags: {}
    });
    await repository.saveProfile({ id: 'alice-profile', userId: 'alice' });
    await repository.saveProfile({ id: 'bob-profile', userId: 'bob' });

    expect((await repository.listPoolsByOwner('alice')).map((pool) => pool.id)).toEqual([
      'alice-pool'
    ]);
    expect((await repository.listProfilesByUser('alice')).map((profile) => profile.id)).toEqual([
      'alice-profile'
    ]);
  });
});

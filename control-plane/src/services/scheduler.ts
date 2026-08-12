import { conflict } from '../domain/errors.js';
import type { Machine, Pool, Task } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';

export class Scheduler {
  public constructor(private readonly repository: Repository) {}

  public async selectMachine(task: Task, userId: string): Promise<{ pool: Pool; machine: Machine }> {
    const profile = task.profileId === undefined ? undefined : await this.repository.getProfile(task.profileId);
    const machines = [...(await this.repository.listMachines())].sort((a, b) => Number(profile?.machineId === b.id) - Number(profile?.machineId === a.id));
    for (const machine of machines) {
      if (!machine.online || machine.activeLeases >= machine.capacity) continue;
      const pool = await this.repository.getPool(machine.poolId);
      if (pool === undefined || !this.poolVisible(pool, userId) || !this.matches(task, machine)) continue;
      return { pool, machine };
    }
    throw conflict('no machine currently satisfies task requirements');
  }

  private poolVisible(pool: Pool, userId: string): boolean {
    return pool.visibility !== 'private' || pool.ownerUserId === userId;
  }

  private matches(task: Task, machine: Machine): boolean {
    const requirements = task.constraints.requirements ?? {};
    return Object.entries(requirements).every(([key, wanted]) => machine.tags[key] === wanted);
  }
}

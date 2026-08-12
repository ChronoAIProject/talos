import type { Machine, Pool, Task } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';

export class Scheduler {
  public constructor(private readonly repository: Repository) {}

  public async isEligible(task: Task, machineId: string, userId: string): Promise<{ pool: Pool; machine: Machine } | undefined> {
    const profile = task.profileId === undefined ? undefined : await this.repository.getProfile(task.profileId);
    const machine = await this.repository.getMachine(machineId);
    if (machine === undefined || !machine.online || machine.activeLeases >= machine.capacity) return undefined;
    if (profile?.machineId !== undefined && profile.machineId !== machine.id) return undefined;
    const pool = await this.repository.getPool(machine.poolId);
    if (pool === undefined || !this.poolVisible(pool, userId) || !this.matches(task, machine)) return undefined;
    return { pool, machine };
  }

  private poolVisible(pool: Pool, userId: string): boolean {
    return pool.visibility !== 'private' || pool.ownerUserId === userId;
  }

  private matches(task: Task, machine: Machine): boolean {
    if (task.kind === 'computer_use' && machine.tags.computer_use !== true) return false;
    const requirements = task.constraints.requirements ?? {};
    return Object.entries(requirements).every(([key, wanted]) => machine.tags[key] === wanted);
  }
}

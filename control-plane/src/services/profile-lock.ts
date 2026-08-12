import { conflict, forbidden, notFound } from '../domain/errors.js';
import type { Profile } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';

export class ProfileLockService {
  public constructor(private readonly repository: Repository, private readonly leaseSeconds = 300) {}

  public async assertOwner(profileId: string, userId: string): Promise<Profile> {
    const profile = await this.repository.getProfile(profileId);
    if (profile === undefined) throw notFound('profile not found');
    if (profile.userId !== userId) throw forbidden('profile belongs to another user');
    return profile;
  }

  public async acquire(profileId: string, userId: string, taskId: string, now = Date.now(), machineId?: string): Promise<Profile> {
    const profile = await this.assertOwner(profileId, userId);
    if (profile.lockedByTaskId !== undefined && profile.lockExpiresAt !== undefined && Date.parse(profile.lockExpiresAt) > now && profile.lockedByTaskId !== taskId) {
      throw conflict('profile already has an active session');
    }
    const next: Profile = { ...profile, ...(machineId === undefined ? {} : { machineId }), lockedByTaskId: taskId, lockExpiresAt: new Date(now + this.leaseSeconds * 1000).toISOString() };
    await this.repository.saveProfile(next);
    return next;
  }

  public async release(profileId: string, taskId: string): Promise<void> {
    const profile = await this.repository.getProfile(profileId);
    if (profile?.lockedByTaskId === taskId) await this.repository.saveProfile({ id: profile.id, userId: profile.userId, ...(profile.machineId === undefined ? {} : { machineId: profile.machineId }) });
  }
}

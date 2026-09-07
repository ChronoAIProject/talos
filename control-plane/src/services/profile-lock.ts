import { conflict, forbidden, notFound } from '../domain/errors.js';
import type { MachineLeaseReservation, Profile } from '../domain/types.js';
import type { Repository } from '../storage/repository.js';

export class ProfileLockService {
  public constructor(private readonly repository: Repository, _leaseSeconds = 300) {}

  public async assertOwner(profileId: string, userId: string): Promise<Profile> {
    const profile = await this.repository.getProfile(profileId);
    if (profile === undefined) throw notFound('profile not found');
    if (profile.userId !== userId) throw forbidden('profile belongs to another user');
    return profile;
  }

  public async acquire(
    profileId: string,
    userId: string,
    machineId: string,
    reservation: MachineLeaseReservation,
    now = Date.now()
  ): Promise<Profile> {
    const profile = await this.repository.acquireProfileLease(profileId, userId, machineId, reservation, now);
    if (profile === undefined) throw conflict('profile already has an active session');
    return profile;
  }

  public async release(profileId: string, reservation: Omit<MachineLeaseReservation, 'expiresAt'>): Promise<boolean> {
    return this.repository.releaseProfileLease(profileId, reservation);
  }
}

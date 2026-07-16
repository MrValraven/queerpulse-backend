import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { handleFormatError, normalizeHandle } from '../common/handles';
import { Handle, HandleOwnerKind } from './entities/handle.entity';

// Who a handle belongs to. A `profile` owner is keyed by `userId`; a
// `subprofile` owner by `subprofileId`. Exactly one identifier is meaningful per
// kind (mirrors the `handles` CHECK constraint).
export type HandleOwner =
  | { kind: 'profile'; userId: string }
  | { kind: 'subprofile'; subprofileId: string };

// Result of a namespace availability check (design plan PART C / UC3, UC4).
export interface HandleCheck {
  available: boolean;
  reason: 'invalid' | 'reserved' | 'taken' | null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

/**
 * Reads and writes the `handles` registry — the ONE global username namespace
 * shared by main-profile usernames and subprofile handles (design plan PART C /
 * UC3). Every write method takes an `EntityManager` so callers run the handle
 * mutation inside the SAME transaction as the row it names (profile slug change,
 * subprofile publish, etc.), keeping the namespace and the owning row atomic.
 *
 * Every name is normalized through `normalizeHandle` before it touches the DB so
 * the `name` PK is always compared in canonical (trimmed/lowercased) form.
 */
@Injectable()
export class HandlesService {
  constructor(
    @InjectRepository(Handle)
    private readonly handles: Repository<Handle>,
  ) {}

  // Read-only availability check for `GET /handles/check`. Format/reserved
  // problems short-circuit before any DB hit; otherwise the registry decides.
  async check(name: string): Promise<HandleCheck> {
    const formatError = handleFormatError(name);
    if (formatError) {
      return { available: false, reason: formatError };
    }
    const taken = await this.isTaken(this.handles.manager, name);
    return { available: !taken, reason: taken ? 'taken' : null };
  }

  // Inserts a registry row for `owner`. A PK collision (name already held by
  // anyone, in either namespace) surfaces as a 409 ConflictException.
  async claim(
    m: EntityManager,
    name: string,
    owner: HandleOwner,
  ): Promise<void> {
    const normalized = normalizeHandle(name);
    const row = m.create(Handle, {
      name: normalized,
      ownerKind:
        owner.kind === 'profile'
          ? HandleOwnerKind.Profile
          : HandleOwnerKind.Subprofile,
      userId: owner.kind === 'profile' ? owner.userId : null,
      subprofileId: owner.kind === 'subprofile' ? owner.subprofileId : null,
    });
    try {
      await m.insert(Handle, row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('That handle is already taken');
      }
      throw err;
    }
  }

  // Moves `owner` from `oldName` to `newName` within one transaction: release
  // the old row (if any and actually changing) then claim the new one. A no-op
  // when the normalized names are equal (the owner already holds it).
  async rename(
    m: EntityManager,
    oldName: string | null,
    newName: string,
    owner: HandleOwner,
  ): Promise<void> {
    const normalizedNew = normalizeHandle(newName);
    const normalizedOld = oldName ? normalizeHandle(oldName) : null;
    if (normalizedOld === normalizedNew) {
      return;
    }
    if (normalizedOld) {
      await this.release(m, normalizedOld);
    }
    await this.claim(m, normalizedNew, owner);
  }

  // Frees a handle by PK. Safe to call when the row does not exist.
  async release(m: EntityManager, name: string): Promise<void> {
    await m.delete(Handle, { name: normalizeHandle(name) });
  }

  // True when `name` is held by someone other than `exceptOwner`. Passing the
  // caller's own owner lets an owner "keep" its current handle without it
  // reading as taken.
  async isTaken(
    m: EntityManager,
    name: string,
    exceptOwner?: HandleOwner,
  ): Promise<boolean> {
    const normalized = normalizeHandle(name);
    const row = await m.findOne(Handle, { where: { name: normalized } });
    if (!row) {
      return false;
    }
    if (exceptOwner) {
      if (
        exceptOwner.kind === 'profile' &&
        row.ownerKind === HandleOwnerKind.Profile &&
        row.userId === exceptOwner.userId
      ) {
        return false;
      }
      if (
        exceptOwner.kind === 'subprofile' &&
        row.ownerKind === HandleOwnerKind.Subprofile &&
        row.subprofileId === exceptOwner.subprofileId
      ) {
        return false;
      }
    }
    return true;
  }
}

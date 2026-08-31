import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { EntityManager, Repository } from 'typeorm';
import {
  HANDLE_RECLAIM_COOLDOWN_MS,
  handleFormatError,
  normalizeHandle,
} from '../common/handles';
import { Handle, HandleOwnerKind } from './entities/handle.entity';
import { HandleHistory } from './entities/handle-history.entity';

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

/**
 * Options for a namespace WRITE (`claim` / `rename`).
 *
 * `isSystemOwnedClaim` is the single, deliberate way past the reserved-name
 * rule, and it exists because the platform's own house account legitimately
 * holds a reserved name: the genesis bootstrap creates it as "QueerPulse",
 * whose slug is `queerpulse`, which the impersonation group in
 * `common/handles.ts` now withholds from everyone else. Removing that name from
 * the list to accommodate one account would hand it to the first member who
 * asked for it, so the exception is named at the call site instead. It waives
 * ONLY the reserved rule: a system-owned name still has to be a well-formed
 * handle, because the registry PK and every URL that reads from it depend on
 * the format holding for every row.
 *
 * Pass it only for a write on behalf of a `users.is_system` account. Every
 * member-initiated claim and rename must leave it unset.
 */
export interface HandleWriteOptions {
  isSystemOwnedClaim?: boolean;
}

/**
 * The reserved/format verdict for a namespace WRITE, returned as a value
 * rather than thrown.
 *
 * `handleFormatError` in `common/handles.ts` answers for the namespace's rules
 * in the abstract. This wraps it with the one exception a write may carry, so
 * what `isSystemOwnedClaim` actually waives is written down in exactly one
 * place. `assertWritable` below turns the verdict into the 422 that a
 * member-facing request needs, and `UsersService.nextAvailableSlug` reads the
 * same verdict to route a Google sign-up AROUND a withheld name rather than
 * failing on it. Sign-up cannot afford a throw here: the person arriving with a
 * Google display name has no opportunity to pick a different one, so that
 * caller needs the answer as a value. Exporting it is what keeps the two
 * readings of "may this name be written?" from drifting apart.
 *
 * The waiver covers the reserved rule alone. An `invalid` name stays invalid
 * for a system account too, because the registry PK and every URL built from it
 * depend on the format holding for every row.
 */
export function handleWriteError(
  name: string,
  options?: HandleWriteOptions,
): 'invalid' | 'reserved' | null {
  const formatError = handleFormatError(name);
  if (formatError === 'reserved' && options?.isSystemOwnedClaim) {
    return null;
  }
  return formatError;
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
  //
  // `exceptOwner` (the caller's own identity, when known) lets a name that is
  // still inside its reclaim cooldown read as AVAILABLE to the previous owner
  // reclaiming it, while remaining `taken` for everyone else.
  async check(name: string, exceptOwner?: HandleOwner): Promise<HandleCheck> {
    const formatError = handleFormatError(name);
    if (formatError) {
      return { available: false, reason: formatError };
    }
    const taken = await this.isTaken(this.handles.manager, name, exceptOwner);
    return { available: !taken, reason: taken ? 'taken' : null };
  }

  // Inserts a registry row for `owner`. A PK collision (name already held by
  // anyone, in either namespace) surfaces as a 409 ConflictException.
  //
  // Reclaim cooldown: if a `handle_history` reservation for `name` is still
  // active (`reclaimableAt` in the future) and belongs to SOMEONE ELSE, the
  // claim is refused so a stranger cannot hijack a just-freed handle (and the
  // old `@mentions` that still point at it). The previous owner reclaiming
  // within the window — and anyone at all once it has lapsed — is allowed, and
  // the stale reservation row is cleared as part of the same transaction.
  async claim(
    m: EntityManager,
    name: string,
    owner: HandleOwner,
    options?: HandleWriteOptions,
  ): Promise<void> {
    this.assertWritable(name, options);
    const normalized = normalizeHandle(name);
    const reservation = await m.findOne(HandleHistory, {
      where: { name: normalized },
    });
    if (reservation) {
      const withinCooldown = reservation.reclaimableAt > new Date();
      if (withinCooldown && !this.reservationHeldBy(reservation, owner)) {
        throw new ConflictException(
          'That handle was recently released and is reserved for a short while',
        );
      }
      // Previous owner reclaiming, or the cooldown has lapsed: drop the
      // reservation so the fresh claim below owns the name outright.
      await m.delete(HandleHistory, { name: normalized });
    }
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
    options?: HandleWriteOptions,
  ): Promise<void> {
    const normalizedNew = normalizeHandle(newName);
    const normalizedOld = oldName ? normalizeHandle(oldName) : null;
    if (normalizedOld === normalizedNew) {
      return;
    }
    // Checked here as well as inside `claim`, and deliberately AFTER the no-op
    // short-circuit above. A rename that keeps the same name is an owner
    // re-asserting a row they already hold, which stays legal even for a name
    // the reserved list has since grown to cover, so a legacy holder can still
    // re-publish without being forced through a rename. A rename that does move
    // the name has to fail before the `release` below runs: callers wrap this in
    // a transaction, so a late failure would roll back correctly, but refusing
    // an unusable name before writing anything keeps that correctness from
    // depending on the caller's transaction.
    this.assertWritable(normalizedNew, options);
    if (normalizedOld) {
      // Owner-scoped: `oldName` is the caller's own slug, but it may normalize
      // onto a row someone else owns (see below).
      await this.release(m, normalizedOld, owner);
    }
    await this.claim(m, normalizedNew, owner, options);
  }

  /**
   * Frees a handle AND records a reclaim reservation. Safe to call when the row
   * does not exist (a true no-op then — no reservation is written).
   *
   * `owner` scopes the delete, and passing it is strongly preferred. Names are
   * normalized (lowercased) but `profiles.slug` is stored raw and is only
   * case-SENSITIVELY unique, so two profiles can hold `John` and `john` while
   * the registry has a single `john` row. Deleting by name alone let the profile
   * that did NOT own that row release it out from under the one that did —
   * freeing a name whose `/members/<slug>` was still live, for anyone to reclaim.
   *
   * Omitting `owner` deletes by name regardless of ownership; only do so where
   * the row is already known to belong to the caller.
   *
   * Instead of hard-deleting and forgetting the name, this upserts a
   * `handle_history` row for whoever actually held it, with `reclaimableAt` set
   * one cooldown window out. Until then the name reads as TAKEN to everyone but
   * that previous owner (see `isTaken`/`claim`), which prevents a stranger from
   * instantly reclaiming a freed handle and silently inheriting its old
   * `@mentions`. All writes use the passed `EntityManager`, so they commit (or
   * roll back) with the rename/unpublish that called in.
   */
  async release(
    m: EntityManager,
    name: string,
    owner?: HandleOwner,
  ): Promise<void> {
    const normalized = normalizeHandle(name);
    const where = {
      name: normalized,
      ...(owner
        ? owner.kind === 'profile'
          ? { ownerKind: HandleOwnerKind.Profile, userId: owner.userId }
          : {
              ownerKind: HandleOwnerKind.Subprofile,
              subprofileId: owner.subprofileId,
            }
        : {}),
    };
    // Read the exact row being freed so the reservation records its TRUE owner
    // (never the passed `owner`, which may differ under the case-fold caveat
    // above). No matching row → nothing was held → nothing to reserve.
    const freed = await m.findOne(Handle, { where });
    if (!freed) {
      return;
    }
    await m.delete(Handle, where);
    const releasedAt = new Date();
    const reclaimableAt = new Date(
      releasedAt.getTime() + HANDLE_RECLAIM_COOLDOWN_MS,
    );
    await m.upsert(
      HandleHistory,
      {
        name: normalized,
        previousOwnerKind: freed.ownerKind,
        previousOwnerUserId: freed.userId,
        previousOwnerSubprofileId: freed.subprofileId,
        releasedAt,
        reclaimableAt,
      },
      ['name'],
    );
  }

  // True when `name` is held by someone other than `exceptOwner`. Passing the
  // caller's own owner lets an owner "keep" its current handle without it
  // reading as taken.
  //
  // A name with no live registry row can still be TAKEN: a `handle_history`
  // reservation whose cooldown has not lapsed reserves the name for its previous
  // owner. It reads as available only to that previous owner (`exceptOwner`
  // matches the reservation) or once the window has passed.
  async isTaken(
    m: EntityManager,
    name: string,
    exceptOwner?: HandleOwner,
  ): Promise<boolean> {
    const normalized = normalizeHandle(name);
    const row = await m.findOne(Handle, { where: { name: normalized } });
    if (row) {
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
    // No live claim — is it still cooling down under a reservation?
    const reservation = await m.findOne(HandleHistory, {
      where: { name: normalized },
    });
    if (!reservation || reservation.reclaimableAt <= new Date()) {
      return false;
    }
    // Reserved and still cooling: taken for all but the previous owner.
    return !(exceptOwner && this.reservationHeldBy(reservation, exceptOwner));
  }

  /**
   * The namespace's own format/reserved gate, applied at the WRITE boundary.
   *
   * `check` has always run `handleFormatError`, so the read side answered
   * honestly while the write side trusted whichever caller happened to be
   * asking. That put the strength of a global rule in the hands of every future
   * caller remembering to apply it, and a caller that forgot would land a
   * malformed or reserved name in the registry with nothing to catch it.
   * Enforcing it here makes the registry refuse a name it would never have
   * offered, whoever is writing.
   *
   * Callers keep their own validation where it produces a better member-facing
   * message (`ProfilesService.updateUsername` names the username field;
   * `validatePublish` returns the persona checklist codes). This is the
   * backstop underneath them, and it uses the same 422 body those callers
   * already return so a caller that skipped its own check still produces an
   * error shape the frontend recognises.
   */
  private assertWritable(name: string, options?: HandleWriteOptions): void {
    const writeError = handleWriteError(name, options);
    if (writeError === 'invalid') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_INVALID',
        message: 'That name contains characters that are not allowed.',
        reason: 'invalid',
      });
    }
    if (writeError === 'reserved') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_RESERVED',
        message: 'That name is reserved.',
        reason: 'reserved',
      });
    }
  }

  // Whether a reclaim reservation belongs to `owner` — the previous owner
  // allowed to reclaim the name during its cooldown window.
  private reservationHeldBy(
    reservation: HandleHistory,
    owner: HandleOwner,
  ): boolean {
    if (owner.kind === 'profile') {
      return (
        reservation.previousOwnerKind === HandleOwnerKind.Profile &&
        reservation.previousOwnerUserId === owner.userId
      );
    }
    return (
      reservation.previousOwnerKind === HandleOwnerKind.Subprofile &&
      reservation.previousOwnerSubprofileId === owner.subprofileId
    );
  }
}

import { ConflictException, Logger } from '@nestjs/common';
import { EntityManager, In, Not } from 'typeorm';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from '../identities/identity-mailbox-sync.service';
import { HandleOwnerKind } from '../handles/entities/handle.entity';
import { HandleHistory } from '../handles/entities/handle-history.entity';
import {
  claimHandleWithin,
  HandleOwner,
  isHandleTakenWithin,
  releaseHandleWithin,
} from '../handles/handles.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
} from './entities/subprofile.entity';
import {
  deriveLinkedPersonaHandle,
  handleNamesOwner,
  linkedPersonaHandleCandidate,
  MAX_DERIVATION_SUFFIX,
} from './persona-handle';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileCreatorChangedEvent } from './subprofile.events';

const transferLogger = new Logger('SubprofileCreatorTransfer');

/** How many re-issued names a creator transfer tries to claim for a
 * creator-named handle (PRD-431) before it keeps the old one. Each lost race
 * skips the name it lost. */
const MAX_REISSUE_CLAIM_ATTEMPTS = 3;

/** The persona mailbox a transfer reconciles, resolved by the caller before
 * its transaction opens (the way `leave` resolves it). */
export interface CreatorTransferMailbox {
  identityId: string;
  identityMailboxSync: IdentityMailboxSyncService;
}

/** Everything a committed transfer must announce. The caller sends
 * `seatChanges` through `emitSeatChanges` and `creatorChangedEvent` through
 * `SUBPROFILE_CREATOR_CHANGED`, both only after its transaction commits. */
export interface CreatorTransferResult {
  newCreatorUserId: string;
  previousSlug: string;
  slug: string;
  seatChanges: MailboxSeatChanges;
  creatorChangedEvent: SubprofileCreatorChangedEvent;
}

/**
 * The first free slug among the new creator's personas, starting from the
 * persona's current slug and suffixing `-2`, `-3`, ... on a collision: the
 * same loop `SubprofilesService.generateSlug` runs for a new persona, so a
 * transferred persona can never break `UQ_subprofiles_user_slug`.
 */
export function resolveTransferredSlug(
  currentSlug: string,
  takenSlugs: ReadonlySet<string>,
): string {
  if (!takenSlugs.has(currentSlug)) {
    return currentSlug;
  }
  let suffix = 2;
  while (takenSlugs.has(`${currentSlug}-${suffix}`)) {
    suffix += 1;
  }
  return `${currentSlug}-${suffix}`;
}

/**
 * Hand the creator role of `subprofile` to its longest-standing remaining
 * co-owner, inside the caller's transaction.
 *
 * The caller must already hold the persona row lock (`pessimistic_write`, the
 * lock every roster writer takes first) and must pass the row it read under
 * that lock, with the departing user's own member row already deleted. A
 * no-op returning null unless `departingUserId` is the creator and somebody
 * else is still on the roster.
 *
 * Successor: see `pickSuccessorWithin`.
 *
 * Writes, all through `manager` so they commit or roll back with the caller:
 * 1. `pg_advisory_xact_lock` on `subprofile_create:<successor>`, the lock
 *    `SubprofilesService.create()` takes, so a concurrent create by the
 *    successor cannot claim the slug picked here. The persona cap
 *    (`MAX_SUBPROFILES`) limits creates alone, so a transfer may take the
 *    successor over it.
 * 2. For a Linked persona, the old address `(departingUserId, oldSlug)` is
 *    upserted into `subprofile_address_history`, so the public read forwards
 *    it. Only a Linked persona ever had the public nested address
 *    `/members/<creator>/<slug>`. An Unlinked persona is served at
 *    `/p/<handle>` alone, and a history row for it would let the old nested
 *    address answer once the persona is linked later, proving who created it
 *    while it was unattributed. So an Unlinked transfer records no history.
 * 3. `user_id` moves to the successor, with a suffixed `slug` when the
 *    successor already has a persona at the current one.
 * 4. Nothing moderation-side moves: a moderator takedown is keyed on the
 *    persona's uuid, which the transfer keeps, so a transfer can never lift it.
 * 5. The mailbox is reconciled against the new staff set with emission
 *    deferred, plus a staffing change for the successor so their identity
 *    switcher refetches `isOwner` (the listing-transfer precedent,
 *    `ListingOwnershipService.transferOwnership`).
 * 6. PRD-431: a Linked persona whose `/p/<handle>` carries the departing
 *    creator's profile slug gets a new default handle built from the
 *    successor's slug (`reissueDepartedCreatorHandle`). A custom linked
 *    handle and every Unlinked handle stay as they are.
 *
 * `subprofile` is updated in place so the caller's copy reads the new creator
 * (and its re-issued handle, when there is one).
 */
export async function transferCreatorWithin(
  manager: EntityManager,
  subprofile: Subprofile,
  departingUserId: string,
  mailbox: CreatorTransferMailbox,
): Promise<CreatorTransferResult | null> {
  if (subprofile.userId !== departingUserId) {
    return null;
  }
  const remainingMembers = await manager.find(SubprofileMember, {
    where: { subprofileId: subprofile.id, userId: Not(departingUserId) },
    order: { joinedAt: 'ASC', id: 'ASC' },
  });
  const successor = await pickSuccessorWithin(manager, remainingMembers);
  if (!successor) {
    return null;
  }
  const newCreatorUserId = successor.userId;

  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `subprofile_create:${newCreatorUserId}`,
  ]);
  const successorPersonas = await manager.find(Subprofile, {
    where: { userId: newCreatorUserId },
    select: { slug: true },
  });
  const previousSlug = subprofile.slug;
  const slug = resolveTransferredSlug(
    previousSlug,
    new Set(successorPersonas.map((persona) => persona.slug)),
  );

  if (subprofile.linkVisibility === SubprofileLinkVisibility.Linked) {
    await manager.query(
      `INSERT INTO "subprofile_address_history" ("previous_user_id", "slug", "subprofile_id")
       VALUES ($1, $2, $3)
       ON CONFLICT ("previous_user_id", "slug")
       DO UPDATE SET "subprofile_id" = EXCLUDED."subprofile_id", "moved_at" = now()`,
      [departingUserId, previousSlug, subprofile.id],
    );
  }

  const hasSlugChanged = slug !== previousSlug;
  await manager.update(
    Subprofile,
    { id: subprofile.id },
    hasSlugChanged
      ? { userId: newCreatorUserId, slug }
      : { userId: newCreatorUserId },
  );
  // A moderator takedown is keyed on the persona's uuid (see
  // `subprofile-takedown.ts`), which a creator transfer never changes, so a
  // new slug needs nothing carried over.
  subprofile.userId = newCreatorUserId;
  subprofile.slug = slug;
  await reissueDepartedCreatorHandle(
    manager,
    subprofile,
    departingUserId,
    previousSlug,
  );

  const seatChanges = await mailbox.identityMailboxSync.resyncMailbox(
    mailbox.identityId,
    manager,
    { shouldDeferEmission: true },
  );
  const hasSuccessorStaffingChange = seatChanges.staffingChanges.some(
    (staffingChange) =>
      staffingChange.userId === newCreatorUserId && staffingChange.isStaff,
  );
  if (!hasSuccessorStaffingChange) {
    seatChanges.staffingChanges.push({
      identityId: mailbox.identityId,
      userId: newCreatorUserId,
      isStaff: true,
    });
  }

  return {
    newCreatorUserId,
    previousSlug,
    slug,
    seatChanges,
    creatorChangedEvent: {
      subprofileId: subprofile.id,
      displayName: subprofile.displayName,
      newCreatorUserId,
      memberUserIds: remainingMembers.map((member) => member.userId),
    },
  };
}

/**
 * PRD-431: a LINKED persona's handle that carries the departing creator's
 * profile slug is re-issued from the successor's slug, so a member who left
 * stops appearing in the public address and future QR codes of a persona
 * they no longer run.
 *
 * Runs after `subprofile` already carries the successor and its new slug.
 * The new name is the shared default `<newCreatorSlug>-<personaSlug>`
 * (`deriveLinkedPersonaHandle`, suffixes included), skipping any name the
 * registry holds or cools for someone else, and any name another persona row
 * already stores. A published persona releases the old name WITHOUT
 * forwarding (it belongs to a member who left, so it must lead nowhere) and
 * claims the new one inside a SAVEPOINT; a claim lost to a concurrent writer
 * rolls back to it and the next free name is tried, up to
 * `MAX_REISSUE_CLAIM_ATTEMPTS`. A draft only stores the new one, since a
 * draft holds no registry row. All through `manager`, inside the caller's
 * transaction.
 *
 * "The departing creator's slug" covers their current profile slug and every
 * former username of theirs still in `handle_history`. Older reservations
 * this persona left that carry one stop forwarding too.
 *
 * Left alone: an Unlinked persona, a persona with no handle, a custom handle
 * that does not carry a departing slug, and the rare case with no name to
 * claim (the successor has no profile, every suffix is taken, or every
 * attempt lost its race), which is logged: the handoff itself matters more
 * than the address, so a leave or an erasure never fails over it.
 */
async function reissueDepartedCreatorHandle(
  manager: EntityManager,
  subprofile: Subprofile,
  departingUserId: string,
  previousSlug: string,
): Promise<void> {
  const currentHandle = subprofile.handle;
  if (
    subprofile.linkVisibility !== SubprofileLinkVisibility.Linked ||
    !currentHandle
  ) {
    return;
  }
  const departingSlugs = await departingCreatorSlugs(manager, departingUserId);
  if (!departingSlugs.length) {
    return;
  }
  const personaSlugs = [previousSlug, subprofile.slug];
  const carriesDepartingSlug = (name: string): boolean =>
    departingSlugs.some((creatorSlug) =>
      handleCarriesCreatorSlug(name, creatorSlug, personaSlugs),
    );
  await stopForwardingCreatorNamedReservations(
    manager,
    subprofile.id,
    carriesDepartingSlug,
  );
  if (!carriesDepartingSlug(currentHandle)) {
    return;
  }
  const successorProfile = await manager.findOne(Profile, {
    where: { userId: subprofile.userId },
  });
  if (!successorProfile) {
    return;
  }
  const owner: HandleOwner = {
    kind: 'subprofile',
    subprofileId: subprofile.id,
  };
  // Names a savepoint lost to a concurrent writer, skipped on the next try.
  const lostNames = new Set<string>();
  for (let attempt = 1; attempt <= MAX_REISSUE_CLAIM_ATTEMPTS; attempt += 1) {
    let reissuedHandle: string;
    try {
      reissuedHandle = await deriveLinkedPersonaHandle(
        successorProfile.slug,
        subprofile.slug,
        async (candidate) => {
          if (
            lostNames.has(candidate) ||
            (await isHandleTakenWithin(manager, candidate, owner))
          ) {
            return false;
          }
          const isStoredByAnotherSubprofile = await manager.exists(Subprofile, {
            where: { handle: candidate, id: Not(subprofile.id) },
          });
          return !isStoredByAnotherSubprofile;
        },
      );
    } catch (err) {
      // `handle_derivation_failed`: every suffix is taken. Keep the handle.
      if (err instanceof ConflictException) {
        break;
      }
      throw err;
    }
    if (reissuedHandle === currentHandle) {
      return;
    }
    if (subprofile.status === SubprofileStatus.Published) {
      try {
        // A nested transaction on the caller's manager is a SAVEPOINT, so a
        // claim that loses its race rolls back this release and claim alone
        // and leaves the caller's transaction usable.
        await manager.transaction(async (savepointManager) => {
          await releaseHandleWithin(savepointManager, currentHandle, owner, {
            isForwarding: false,
          });
          await claimHandleWithin(savepointManager, reissuedHandle, owner);
        });
      } catch (err) {
        if (!(err instanceof ConflictException)) {
          throw err;
        }
        lostNames.add(reissuedHandle);
        continue;
      }
    }
    await manager.update(
      Subprofile,
      { id: subprofile.id },
      { handle: reissuedHandle },
    );
    subprofile.handle = reissuedHandle;
    return;
  }
  // The handoff matters more than the address: a leave or an erasure never
  // fails over it. The persona keeps its handle until the owner renames it.
  transferLogger.warn(
    `Kept the creator-named handle of persona ${subprofile.id} after a creator transfer: no re-issued name could be claimed`,
  );
}

/**
 * Every profile slug the departing creator is known by: their current
 * `profiles.slug`, plus former usernames still recorded as profile
 * reservations in `handle_history` (a creator who renamed keeps the old slug
 * in a persona handle, since a profile rename leaves persona handles alone).
 */
async function departingCreatorSlugs(
  manager: EntityManager,
  departingUserId: string,
): Promise<string[]> {
  const departingProfile = await manager.findOne(Profile, {
    where: { userId: departingUserId },
  });
  const formerUsernames = await manager.find(HandleHistory, {
    where: {
      previousOwnerKind: HandleOwnerKind.Profile,
      previousOwnerUserId: departingUserId,
    },
    select: { name: true },
  });
  const slugs = formerUsernames.map((reservation) => reservation.name);
  if (departingProfile) {
    slugs.unshift(departingProfile.slug);
  }
  return [...new Set(slugs)];
}

/**
 * Stops every still-forwarding reservation this persona left (from an earlier
 * rename) whose name carries the departing creator's slug, so an old address
 * naming a member who left leads nowhere. Cooldowns are untouched, so each
 * name stays reserved for its full window.
 */
async function stopForwardingCreatorNamedReservations(
  manager: EntityManager,
  subprofileId: string,
  carriesDepartingSlug: (name: string) => boolean,
): Promise<void> {
  const forwardingReservations = await manager.find(HandleHistory, {
    where: {
      previousOwnerKind: HandleOwnerKind.Subprofile,
      previousOwnerSubprofileId: subprofileId,
      isForwarding: true,
    },
    select: { name: true },
  });
  const creatorNamedNames = forwardingReservations
    .map((reservation) => reservation.name)
    .filter(carriesDepartingSlug);
  if (!creatorNamedNames.length) {
    return;
  }
  await manager.update(
    HandleHistory,
    { name: In(creatorNamedNames) },
    { isForwarding: false },
  );
}

/**
 * True when `handle` carries `creatorSlug`: as a whole hyphen-delimited run
 * (`handleNamesOwner`, the rule unlinked handles are refused by), or as the
 * default `<creatorSlug>-<personaSlug>` for any of `personaSlugs`, with any
 * suffix. The second form catches a long creator slug the 30-char cut
 * shortened, which no longer appears whole.
 */
function handleCarriesCreatorSlug(
  handle: string,
  creatorSlug: string,
  personaSlugs: readonly string[],
): boolean {
  if (handleNamesOwner(handle, creatorSlug)) {
    return true;
  }
  for (const personaSlug of personaSlugs) {
    for (let suffix = 1; suffix <= MAX_DERIVATION_SUFFIX; suffix += 1) {
      if (
        linkedPersonaHandleCandidate(creatorSlug, personaSlug, suffix) ===
        handle
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The member who becomes creator, from `orderedMembers` (the remaining roster
 * in `joined_at, id` order, exactly as Postgres returned it; no re-sort in
 * JavaScript, which would drop the microseconds of `joined_at` and could
 * disagree with the repair migration's pick).
 *
 * Preference: the first member whose account is active (`users.status =
 * 'active'`, the predicate the rest of the codebase uses for "a member who is
 * here": a suspended member, or a deactivated one, which includes an account
 * in its erasure grace period, is skipped). When nobody remaining is active,
 * the longest-standing member takes it anyway, so the persona still has a
 * creator. The repair migration `1821500400000-RepairOrphanedPersonaCreators`
 * applies the same rule. Null for an empty roster.
 */
async function pickSuccessorWithin(
  manager: EntityManager,
  orderedMembers: readonly SubprofileMember[],
): Promise<SubprofileMember | null> {
  const longestStanding = orderedMembers[0];
  if (!longestStanding) {
    return null;
  }
  const activeUsers = await manager.find(User, {
    where: {
      id: In(orderedMembers.map((member) => member.userId)),
      status: UserStatus.Active,
    },
    select: { id: true },
  });
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  return (
    orderedMembers.find((member) => activeUserIds.has(member.userId)) ??
    longestStanding
  );
}

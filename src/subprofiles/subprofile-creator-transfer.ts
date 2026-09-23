import { EntityManager, In, Not } from 'typeorm';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from '../identities/identity-mailbox-sync.service';
import { User, UserStatus } from '../users/entities/user.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import { SubprofileCreatorChangedEvent } from './subprofile.events';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from './subprofile-takedown';

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
 * 4. When the slug changed, a moderator takedown recorded against the old slug
 *    is copied onto the new one (takedowns are keyed by slug), so a transfer
 *    can never lift it.
 * 5. The mailbox is reconciled against the new staff set with emission
 *    deferred, plus a staffing change for the successor so their identity
 *    switcher refetches `isOwner` (the listing-transfer precedent,
 *    `ListingOwnershipService.transferOwnership`).
 *
 * `subprofile` is updated in place so the caller's copy reads the new creator.
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
  if (hasSlugChanged) {
    await copyTakedownToSlug(manager, previousSlug, slug);
  }
  subprofile.userId = newCreatorUserId;
  subprofile.slug = slug;

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

/**
 * Copy a moderator takedown recorded against `previousSlug` onto `slug`.
 * Only a row that still withholds the persona (hidden or removed) is copied;
 * a lifted row carries nothing to preserve. On a collision with an existing
 * row for `slug`, each timestamp already set there is kept and each unset one
 * takes the copied value, so the merge can only keep content withheld.
 */
async function copyTakedownToSlug(
  manager: EntityManager,
  previousSlug: string,
  slug: string,
): Promise<void> {
  await manager.query(
    `INSERT INTO "content_moderation"
       ("subject_type", "subject_id", "hidden_at", "removed_at", "moderated_by", "report_id", "reason_code", "note")
     SELECT "subject_type", $2, "hidden_at", "removed_at", "moderated_by", "report_id", "reason_code", "note"
     FROM "content_moderation"
     WHERE "subject_type" = $3
       AND "subject_id" = $1
       AND ("hidden_at" IS NOT NULL OR "removed_at" IS NOT NULL)
     ON CONFLICT ("subject_type", "subject_id")
     DO UPDATE SET
       "hidden_at" = COALESCE("content_moderation"."hidden_at", EXCLUDED."hidden_at"),
       "removed_at" = COALESCE("content_moderation"."removed_at", EXCLUDED."removed_at"),
       "updated_at" = now()`,
    [previousSlug, slug, SUBPROFILE_MODERATION_SUBJECT_TYPE],
  );
}

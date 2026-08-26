import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { Community } from './entities/community.entity';

/**
 * What `resolveOrphanedOwnership`'s transaction hands back when it actually
 * promoted somebody. `promotedFromRole` is the tier the new owner was standing
 * on a moment earlier (`co_owner` or `mod`), captured inside the transaction
 * because the very next statement rewrites that row's role to `owner`, and
 * carried out so the governance-log entry can record which tier answered.
 * `null` instead of this object means nothing was promoted.
 */
interface OwnerPromotionOutcome {
  promotedUserId: string;
  promotedFromRole: RosterRole;
}

/**
 * Handles what happens to a community when its OWNER's account is erased.
 *
 * Self-contained on purpose (new file, not folded into `CommunitiesService`)
 * so it can't conflict with other concurrent work on this feature.
 *
 * ## Why this exists
 *
 * `communities.owner_id` used to be `ON DELETE CASCADE` — erasing an owner's
 * account deleted their entire community. The paired migration
 * (`FixCommunityOwnerAuthorErasureCascades1789900000000`) changes that FK to
 * `SET NULL`, which stops the deletion but leaves every ownerless community
 * with no one holding owner-only powers (archive, ownership transfer, danger
 * zone). This service is what fills that gap: promote someone off the roster
 * to `owner`, or, if there is nobody to promote, flag the community for admin
 * review instead of leaving it silently ownerless.
 *
 * ## Who gets promoted, in order
 *
 * 1. The longest-tenured `co_owner`.
 * 2. Failing that, the longest-tenured `mod`.
 * 3. Failing that, nobody: `owner_id` stays NULL and `needsOwnerReviewAt` is
 *    stamped for the admin surface.
 *
 * The co-owner tier is first because `co_owner` is the role an owner
 * explicitly hands owner-level powers to (settings, roster, moderation). This
 * used to skip that role entirely and promote a moderator over the head of
 * the one person the departed owner had actually named as their equal, which
 * is the worst available answer to "who did they trust with this room?".
 *
 * Tenure (`joined_at ASC`) breaks the tie inside each tier, unchanged: it is
 * the only durable, non-arbitrary ordering the roster carries.
 *
 * ## Wiring — READ BEFORE CALLING
 *
 * There is no event bus hook for account erasure. `AccountDeletionProcessorService
 * .eraseAccount` (`src/account/account-deletion-processor.service.ts`) is a
 * single synchronous, transactional method: it loads the `User` row, nulls a
 * couple of unrelated FKs, then hard-deletes the user (`manager.delete(User,
 * { id: userId })`), letting every `ON DELETE CASCADE`/`SET NULL` FK across
 * the schema do its thing. `AccountModule` does not currently import
 * `CommunitiesModule`, so nothing calls `handleOwnerErasure` yet.
 *
 * `handleOwnerErasure` MUST be called BEFORE that `manager.delete(User, ...)`
 * statement runs — this method reads `communities.owner_id = :userId` to find
 * the communities that need handling, and once the user row is deleted the
 * `SET NULL` FK will have already blanked `owner_id` (and cascaded away the
 * erased owner's own `community_members` roster row), leaving no trace of
 * who used to own what. The intended call site is inside
 * `AccountDeletionProcessorService.eraseAccount`, immediately before step 3
 * ("Hard-delete the user"). Ideally that call happens inside the SAME
 * transaction as the user deletion for atomicity (this service does not
 * currently accept an external `EntityManager`, so as written it commits its
 * own transaction per community first) — whoever wires the call site should
 * weigh that gap. Wiring the actual call (and therefore importing
 * `CommunitiesModule` into `AccountModule`, watching for a circular
 * dependency) is left to a different task in this effort.
 */
@Injectable()
export class CommunityOwnerOrphanService {
  private readonly logger = new Logger(CommunityOwnerOrphanService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly dataSource: DataSource,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * For every community the given user currently owns, promote the roster's
   * longest-tenured `co_owner` (failing that, its longest-tenured `mod`) to
   * `owner`, or, if neither exists, leave `owner_id` NULL and stamp
   * `needsOwnerReviewAt` so an admin surface can find it.
   *
   * Isolates each community: one failing must not strand the rest (mirrors
   * `AccountDeletionProcessorService.eraseDueAccounts`'s per-row isolation).
   */
  async handleOwnerErasure(userId: string): Promise<void> {
    const ownedCommunities = await this.communities.find({
      where: { ownerId: userId },
    });
    for (const community of ownedCommunities) {
      try {
        await this.resolveOrphanedOwnership(community.id, userId);
      } catch (error) {
        this.logger.error(
          `Failed to resolve orphaned ownership for community ${community.id} ` +
            `(erased owner ${userId}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  private async resolveOrphanedOwnership(
    communityId: string,
    erasedOwnerId: string,
  ): Promise<void> {
    const promotion = await this.dataSource.transaction(
      async (manager): Promise<OwnerPromotionOutcome | null> => {
        // Guard against a double call (two overlapping sweeps, or a retry)
        // racing to handle the same community: only proceed if this user is
        // still the owner of record.
        const community = await manager.findOne(Community, {
          where: { id: communityId, ownerId: erasedOwnerId },
        });
        if (!community) return null;

        // Vacate the erased owner's own roster slot as part of this same
        // transaction, rather than waiting for the `community_members.user_id`
        // `ON DELETE CASCADE` to remove it once the user row is actually
        // deleted. This is equivalent to the owner having left (the same
        // semantics that FK cascade already carries for any member) and,
        // critically, has to happen BEFORE promoting anyone: with both rows
        // present at once, two `role = 'owner'` rows for one community would
        // briefly exist, which `UQ_community_members_one_owner`
        // (`AddCommunityMembersOwnerUniqueIndex1790100000000`) forbids.
        await manager.delete(CommunityMember, {
          communityId,
          userId: erasedOwnerId,
        });

        const memberRepository = manager.getRepository(CommunityMember);
        // ONE ordered query rather than a co-owner lookup followed by a mod
        // lookup: the preference IS an ordering, so it is expressible as one,
        // and a single round trip is one less statement holding this
        // transaction open. The leading CASE sorts every `co_owner` ahead of
        // every `mod`, and `joined_at ASC` breaks the tie inside each tier, so
        // the first row is exactly "longest-tenured co-owner, else
        // longest-tenured mod". The role value is BOUND as a parameter
        // (`setParameter`) rather than interpolated into the ORDER BY.
        const promotionCandidate = await memberRepository
          .createQueryBuilder('member')
          .where('member.community_id = :communityId', { communityId })
          .andWhere('member.role IN (:...promotableRoles)', {
            promotableRoles: [RosterRole.CoOwner, RosterRole.Mod],
          })
          .orderBy(
            'CASE WHEN member.role = :coOwnerRole THEN 0 ELSE 1 END',
            'ASC',
          )
          .addOrderBy('member.joined_at', 'ASC')
          .setParameter('coOwnerRole', RosterRole.CoOwner)
          // `getOne()` on its own fetches every matching row and keeps the
          // first, so the LIMIT is explicit here. The `findOne` this replaced
          // got one for free.
          .limit(1)
          .getOne();

        if (!promotionCandidate) {
          await manager.update(Community, communityId, {
            ownerId: null,
            needsOwnerReviewAt: new Date(),
          });
          this.logger.warn(
            `Community ${communityId} lost its owner (account erased) with no ` +
              `co-owner or mod on the roster to promote; flagged for admin review`,
          );
          return null;
        }

        // Captured BEFORE the update below rewrites it to `owner`, so the
        // audit trail records the tier this promotion actually drew from.
        const promotedFromRole = promotionCandidate.role;
        await memberRepository.update(promotionCandidate.id, {
          role: RosterRole.Owner,
        });
        await manager.update(Community, communityId, {
          ownerId: promotionCandidate.userId,
          needsOwnerReviewAt: null,
        });
        return { promotedUserId: promotionCandidate.userId, promotedFromRole };
      },
    );

    if (!promotion) return;

    // Best-effort, outside the transaction: the promotion has already
    // committed, and an audit-log write failing must not roll it back or
    // strand the erasure sweep. Mirrors the storage-cleanup step in
    // `AccountDeletionProcessorService.eraseAccount`.
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId: null,
        action: GovernanceLogAction.OwnerAutoPromoted,
        targetUserId: promotion.promotedUserId,
        metadata: {
          reason: 'owner account erased',
          previousOwnerId: erasedOwnerId,
          // Which tier the automatic promotion drew from, so the audit trail
          // answers "was this the co-owner the departed owner named, or a
          // moderator the platform picked?" instead of only "someone was
          // elevated".
          promotedFromRole: promotion.promotedFromRole,
        },
      });
    } catch (error) {
      this.logger.error(
        `Owner-erasure promotion for community ${communityId} committed, but ` +
          `writing the governance log entry failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}

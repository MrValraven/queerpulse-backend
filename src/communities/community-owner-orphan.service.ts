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
 * zone). This service is what fills that gap: promote the roster's
 * longest-tenured `mod` to `owner`, or, if there is no mod, flag the
 * community for admin review instead of leaving it silently ownerless.
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
   * longest-tenured `mod` to `owner`, or — if none exists — leave `owner_id`
   * NULL and stamp `needsOwnerReviewAt` so an admin surface can find it.
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
    const promotedMemberUserId = await this.dataSource.transaction(
      async (manager) => {
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
        // critically, has to happen BEFORE promoting a mod: with both rows
        // present at once, two `role = 'owner'` rows for one community would
        // briefly exist, which `UQ_community_members_one_owner`
        // (`AddCommunityMembersOwnerUniqueIndex1790100000000`) forbids.
        await manager.delete(CommunityMember, {
          communityId,
          userId: erasedOwnerId,
        });

        const memberRepository = manager.getRepository(CommunityMember);
        const longestTenuredMod = await memberRepository.findOne({
          where: { communityId, role: RosterRole.Mod },
          order: { joinedAt: 'ASC' },
        });

        if (!longestTenuredMod) {
          await manager.update(Community, communityId, {
            ownerId: null,
            needsOwnerReviewAt: new Date(),
          });
          this.logger.warn(
            `Community ${communityId} lost its owner (account erased) with no ` +
              `mod on the roster to promote; flagged for admin review`,
          );
          return null;
        }

        await memberRepository.update(longestTenuredMod.id, {
          role: RosterRole.Owner,
        });
        await manager.update(Community, communityId, {
          ownerId: longestTenuredMod.userId,
          needsOwnerReviewAt: null,
        });
        return longestTenuredMod.userId;
      },
    );

    if (!promotedMemberUserId) return;

    // Best-effort, outside the transaction: the promotion has already
    // committed, and an audit-log write failing must not roll it back or
    // strand the erasure sweep — mirrors the storage-cleanup step in
    // `AccountDeletionProcessorService.eraseAccount`.
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId: null,
        action: GovernanceLogAction.OwnerAutoPromoted,
        targetUserId: promotedMemberUserId,
        metadata: {
          reason: 'owner account erased',
          previousOwnerId: erasedOwnerId,
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

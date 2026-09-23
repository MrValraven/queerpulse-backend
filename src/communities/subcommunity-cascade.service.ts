import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  AccessTier,
  Community,
  CommunityFrozenReason,
} from './entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { TIER_STRICTNESS } from './subcommunity-rules';

/**
 * Writes a parent's state change onto its spaces inside the caller's
 * transaction. Cascading the write keeps every existing inline `frozenAt`
 * and `archived_at IS NULL` check correct for spaces with no change.
 */
@Injectable()
export class SubcommunityCascadeService {
  /**
   * Deletes the user's roster rows in every space of `parentId` and returns
   * the ids of the spaces they were removed from, so the caller can emit one
   * `COMMUNITY_MEMBER_LEFT` per space after commit.
   */
  async removeFromSpaces(
    manager: EntityManager,
    parentId: string,
    userId: string,
  ): Promise<string[]> {
    const result = await manager
      .createQueryBuilder()
      .delete()
      .from(CommunityMember)
      .where('user_id = :userId', { userId })
      .andWhere(
        'community_id IN (SELECT id FROM communities WHERE parent_id = :parentId)',
        { parentId },
      )
      .returning('community_id')
      .execute();
    const rows = (result.raw as { community_id: string }[] | undefined) ?? [];
    return rows.map((row) => row.community_id);
  }

  /**
   * Makes `newOwnerId` the owner of record of one space, inside the caller's
   * transaction: points `owner_id` at them, clears the owner-review stamp and
   * upserts their roster row to `owner`. A new row carries the rules
   * acceptance stamp for the space's current `rulesVersion` when the space
   * has rules of its own, the same stamp `join` writes, so the new owner is
   * not greeted by a "rules changed" notice for rules they now own. An
   * existing row keeps the acceptance it already holds.
   *
   * The caller has already cleared any previous owner row, so the one-owner
   * partial unique index (`UQ_community_members_one_owner`) is free. Returns
   * the role the new owner held in the space before, or null when they held
   * no row there.
   */
  async assignSpaceOwner(
    manager: EntityManager,
    spaceId: string,
    newOwnerId: string,
  ): Promise<RosterRole | null> {
    const membersRepository = manager.getRepository(CommunityMember);
    const existingRow = await membersRepository.findOne({
      where: { communityId: spaceId, userId: newOwnerId },
    });
    if (existingRow) {
      await membersRepository.update(existingRow.id, {
        role: RosterRole.Owner,
      });
    } else {
      const space = await manager.findOne(Community, {
        where: { id: spaceId },
        select: { id: true, rules: true, rulesVersion: true },
      });
      const hasRules = (space?.rules.length ?? 0) > 0;
      await membersRepository.save(
        membersRepository.create({
          communityId: spaceId,
          userId: newOwnerId,
          role: RosterRole.Owner,
          ...(hasRules && space
            ? {
                rulesAcceptedAt: new Date(),
                rulesVersionAccepted: space.rulesVersion,
              }
            : {}),
        }),
      );
    }
    await manager.update(
      Community,
      { id: spaceId },
      { ownerId: newOwnerId, needsOwnerReviewAt: null },
    );
    return existingRow?.role ?? null;
  }

  /**
   * Hands every space of `parent` owned by `previousOwnerId` to the parent's
   * owner and returns those space ids. An ownerless parent leaves the space
   * ownerless too, flagged for admin review the way an erased owner's
   * community is. Governance logging stays with the callers.
   */
  async reassignSpacesOwnedBy(
    manager: EntityManager,
    parent: Pick<Community, 'id' | 'ownerId'>,
    previousOwnerId: string,
  ): Promise<string[]> {
    const ownedSpaces = await manager.find(Community, {
      where: { parentId: parent.id, ownerId: previousOwnerId },
      select: { id: true },
    });
    const newOwnerId = parent.ownerId;
    for (const space of ownedSpaces) {
      if (newOwnerId === null) {
        await manager.update(
          Community,
          { id: space.id },
          { ownerId: null, needsOwnerReviewAt: new Date() },
        );
        continue;
      }
      await this.assignSpaceOwner(manager, space.id, newOwnerId);
    }
    return ownedSpaces.map((space) => space.id);
  }

  /**
   * The parent leave, removal and ban cascade, shared by the member and admin
   * paths: deletes the user's rows in every space of `parent`, then passes
   * any space they owned to the parent's owner. Runs inside the caller's
   * transaction; the caller logs governance entries and emits one
   * `COMMUNITY_MEMBER_LEFT` per `removedSpaceIds` entry after commit.
   */
  async removeParentMemberFromSpaces(
    manager: EntityManager,
    parent: Pick<Community, 'id' | 'ownerId'>,
    userId: string,
  ): Promise<{ removedSpaceIds: string[]; reassignedSpaceIds: string[] }> {
    const removedSpaceIds = await this.removeFromSpaces(
      manager,
      parent.id,
      userId,
    );
    const reassignedSpaceIds = await this.reassignSpacesOwnedBy(
      manager,
      parent,
      userId,
    );
    return { removedSpaceIds, reassignedSpaceIds };
  }

  async freezeSpaces(
    manager: EntityManager,
    parentId: string,
    actorUserId: string | null,
  ): Promise<string[]> {
    const result = await manager
      .createQueryBuilder()
      .update(Community)
      .set({
        frozenAt: () => 'now()',
        frozenReason: CommunityFrozenReason.ParentFrozen,
        frozenByUserId: actorUserId,
        frozenNote: null,
      })
      .where('parent_id = :parentId AND frozen_at IS NULL', { parentId })
      .returning('id')
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }

  async unfreezeSpaces(
    manager: EntityManager,
    parentId: string,
  ): Promise<string[]> {
    const result = await manager
      .createQueryBuilder()
      .update(Community)
      .set({
        frozenAt: null,
        frozenReason: null,
        frozenByUserId: null,
        frozenNote: null,
      })
      .where('parent_id = :parentId AND frozen_reason = :reason', {
        parentId,
        reason: CommunityFrozenReason.ParentFrozen,
      })
      .returning('id')
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }

  async archiveSpaces(
    manager: EntityManager,
    parentId: string,
    archivedAt: Date,
  ): Promise<string[]> {
    const result = await manager
      .createQueryBuilder()
      .update(Community)
      .set({ archivedAt, archivedWithParent: true })
      .where('parent_id = :parentId AND archived_at IS NULL', { parentId })
      .returning('id')
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }

  async unarchiveSpaces(
    manager: EntityManager,
    parentId: string,
  ): Promise<string[]> {
    const result = await manager
      .createQueryBuilder()
      .update(Community)
      .set({ archivedAt: null, archivedWithParent: false })
      .where('parent_id = :parentId AND archived_with_parent = true', {
        parentId,
      })
      .returning('id')
      .execute();
    return (result.raw as { id: string }[]).map((row) => row.id);
  }

  async raiseSpaceTiers(
    manager: EntityManager,
    parentId: string,
    parentTier: AccessTier,
  ): Promise<{ id: string; from: AccessTier }[]> {
    const spaces = await manager.find(Community, {
      where: { parentId },
      select: { id: true, accessTier: true },
    });
    const tooOpenSpaces = spaces.filter(
      (space) =>
        TIER_STRICTNESS[space.accessTier] < TIER_STRICTNESS[parentTier],
    );
    for (const space of tooOpenSpaces) {
      await manager.update(
        Community,
        { id: space.id },
        { accessTier: parentTier },
      );
    }
    return tooOpenSpaces.map((space) => ({
      id: space.id,
      from: space.accessTier,
    }));
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  CommunityGivingDTO,
  toCommunityGivingDTO,
} from './community-giving-response';
import { diffGiving, normalizeGivingInput } from './community-giving-rules';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityMembershipService } from './community-membership.service';
import { assertCommunityBoardReadable } from './community-read-gate';
import { resolveOwnerLevelCommunity } from './community-staff-access';
import { UpdateCommunityGivingDto } from './dto/update-community-giving.dto';
import { CommunityGivingMethod } from './entities/community-giving-method.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

// The only writer of `communities.giving_intro` (see the column's
// `update: false` in community.entity.ts).
const UPDATE_GIVING_INTRO_SQL = `
  UPDATE "communities"
  SET "giving_intro" = $1, "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = $2
`;

/**
 * Backs `/communities/:slug/giving`: the read and write side of a community's
 * giving section ("Support" in the UI), its intro (`communities.giving_intro`)
 * plus up to 8 rows in `community_giving_methods`.
 *
 * Reads answer exactly like the post board (`assertCommunityBoardReadable`):
 * a public community is readable by any signed-in member, a gated one only
 * with an effective role, and an archived one stays readable to its roster.
 *
 * Writes are owner and co-owner only (`resolveOwnerLevelCommunity`).
 * Copyable payment details are a takeover target: a moderator who could swap
 * an IBAN would redirect the community's money, so the governance tier
 * applies here, the same tier that edits the community's settings.
 *
 * Every effective save writes its `settings_changed` governance entry inside
 * the same transaction as the change, so a change can never land without its
 * log entry. This differs on purpose from the best-effort notifications
 * elsewhere in this module: the design's safeguard is that every change to
 * where the money goes is visible to staff.
 *
 * No `Logger` call in this file may include a giving value, an intro, a label
 * or a note, and nothing here records who viewed, opened or copied the
 * section.
 */
@Injectable()
export class CommunityGivingService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityGivingMethod)
    private readonly givingMethods: Repository<CommunityGivingMethod>,
    private readonly dataSource: DataSource,
    private readonly membership: CommunityMembershipService,
    private readonly contentModeration: ContentModerationService,
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  /**
   * The giving section for a viewer who passes the post board's read gate.
   * The community loads with no archive filter: the gate itself admits an
   * archived community's roster and 404s everyone else. The viewer role is
   * the effective one, so parent staff read a space's section.
   */
  async getBySlug(slug: string, viewerId: string): Promise<CommunityGivingDTO> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const viewerRole = await this.membership.effectiveRole(community, viewerId);
    await assertCommunityBoardReadable({
      community,
      viewerRole,
      communities: this.communities,
      contentModeration: this.contentModeration,
    });
    const rows = await this.givingMethods.find({
      where: { communityId: community.id },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    return toCommunityGivingDTO(community.givingIntro, rows);
  }

  /**
   * Replace the whole section. Authorization and value normalisation run
   * before any transaction opens, so a refused caller or a bad value costs no
   * lock. A save that changes nothing writes nothing, logs nothing and
   * returns the current state with its old `updatedAt`.
   */
  async replaceBySlug(
    slug: string,
    actorId: string,
    dto: UpdateCommunityGivingDto,
  ): Promise<CommunityGivingDTO> {
    const { community } = await resolveOwnerLevelCommunity(
      this.communities,
      this.members,
      slug,
      actorId,
    );
    const nextGiving = normalizeGivingInput(dto);

    return this.dataSource.transaction(async (manager) => {
      const communityRepository = manager.getRepository(Community);
      const methodRepository = manager.getRepository(CommunityGivingMethod);

      // Serialises concurrent saves by two co-owners, so each governance
      // entry diffs against the state it actually replaced. `FOR NO KEY
      // UPDATE` is enough for that and, unlike `FOR UPDATE`, does not block
      // inserts into tables whose foreign key points at this row.
      const lockedCommunity = await communityRepository.findOne({
        where: { id: community.id },
        lock: { mode: 'for_no_key_update' },
      });
      // Archived between the owner check and the lock: same 404 as a
      // community that is gone.
      if (!lockedCommunity || lockedCommunity.archivedAt != null) {
        throw new NotFoundException('Community not found');
      }

      const currentRows = await methodRepository.find({
        where: { communityId: community.id },
        order: { position: 'ASC', createdAt: 'ASC' },
      });
      const changes = diffGiving(
        { intro: lockedCommunity.givingIntro, methods: currentRows },
        nextGiving,
      );
      if (!Object.keys(changes).length) {
        return toCommunityGivingDTO(lockedCommunity.givingIntro, currentRows);
      }

      if (lockedCommunity.givingIntro !== nextGiving.intro) {
        // Raw on purpose: `givingIntro` is `update: false` so no other
        // `save()` of a Community can write back a stale intro, and TypeORM's
        // UpdateQueryBuilder drops non-updatable columns, so
        // `repository.update()` could not write it either. `updated_at` is
        // bumped here as the ORM would for any other column.
        await manager.query(UPDATE_GIVING_INTRO_SQL, [
          nextGiving.intro,
          community.id,
        ]);
      }
      // Every effective save rewrites the whole set, which is what lets the
      // rows' timestamps answer "updated when" with no extra column.
      await methodRepository.delete({ communityId: community.id });
      const savedRows = await methodRepository.save(
        nextGiving.methods.map((method, position) =>
          methodRepository.create({
            communityId: community.id,
            ...method,
            position,
          }),
        ),
      );
      await this.governanceLog.log(
        {
          communityId: community.id,
          actorUserId: actorId,
          action: GovernanceLogAction.SettingsChanged,
          metadata: { changes },
        },
        manager,
      );
      return toCommunityGivingDTO(nextGiving.intro, savedRows);
    });
  }
}

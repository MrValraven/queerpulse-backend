import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import {
  Changemaker,
  ChangemakerStatus,
} from '../changemakers/entities/changemaker.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { CreateLandingFeatureDto } from './dto/create-landing-feature.dto';
import { ReorderLandingFeaturesDto } from './dto/reorder-landing-features.dto';
import { UpdateLandingFeatureDto } from './dto/update-landing-feature.dto';
import {
  LandingFeature,
  LandingSection,
} from './entities/landing-feature.entity';
import { validateLandingCopy } from './landing-copy.validator';
import {
  AdminEligibleEntityDTO,
  AdminLandingFeatureDTO,
  AdminTargetSummary,
  LandingFeaturesResponseDTO,
  LandingHiddenReason,
  toAdminEligibleEntityDTO,
  toAdminLandingFeatureDTO,
  toLandingChangemakerFeatureDTO,
  toLandingCommunityFeatureDTO,
  toLandingMemberFeatureDTO,
} from './landing-response';

/** Cap on `listEligible` results. This backs an admin type-ahead picker (the
 *  admin types a search term to narrow down), not a paginated list, so a
 *  silent cap is acceptable here the way it would not be for a primary listing
 *  page — but it is still a REAL cap, not unlimited: callers relying on this
 *  method to enumerate every eligible entity will not see more than this many
 *  without narrowing `search` first. Mirrors the logger-only truncation
 *  precedent in `AdminCommunitiesService` (`MAX_LISTED_COMMUNITIES`). */
const MAX_ELIGIBLE_RESULTS = 30;

/** Result of resolving a single `(section, targetId)` pair against its source
 *  entity: whether it currently exists, whether it is eligible to be
 *  featured, why it is hidden if not, and the summary the admin UI renders it
 *  with. */
interface TargetState {
  eligible: boolean;
  hiddenReason: LandingHiddenReason;
  summary: AdminTargetSummary | null;
}

// ---- Canonical eligibility (Global Constraints) — the ONLY place these
// rules are expressed. `getPublicFeatures`, `listEligible`, `createFeature`,
// and `listAdminFeatures` all route through these, so eligibility can never
// drift between the read-time honesty filter and the admin picker/CRUD.

// Each predicate below has a SQL twin — `LandingService#memberEligibilityQuery`
// / `#communityEligibilityQuery` / `#changemakerEligibilityQuery` — used by
// `listEligible`'s anti-join query, where the same rule has to be expressed as
// a WHERE clause instead of an in-memory check. Both forms of a rule MUST stay
// in sync; a change here needs the matching change there, and vice versa.

/** JS form of the member eligibility rule. Keep in sync with
 *  `memberEligibilityQuery`'s SQL. */
function isMemberEligible(profile: Profile): boolean {
  return (
    profile.visibility === ProfileVisibility.Open &&
    profile.featuredConsent === true
  );
}

/** JS form of the community eligibility rule. Keep in sync with
 *  `communityEligibilityQuery`'s SQL. */
function isCommunityEligible(community: Community): boolean {
  return (
    community.accessTier === AccessTier.Public && community.archivedAt === null
  );
}

/** JS form of the changemaker eligibility rule. Keep in sync with
 *  `changemakerEligibilityQuery`'s SQL. */
function isChangemakerEligible(changemaker: Changemaker): boolean {
  return changemaker.status === ChangemakerStatus.Published;
}

/** Consent is the member's own explicit action, distinct from visibility
 *  (which can change for unrelated reasons) — checked first so a
 *  consent-revoked member always reads as "consent_revoked" even if they also
 *  happen to have gone private. */
function memberHiddenReason(profile: Profile): LandingHiddenReason {
  if (!profile.featuredConsent) return 'consent_revoked';
  if (profile.visibility !== ProfileVisibility.Open) return 'went_private';
  return null;
}

/** `AdminLandingFeatureDTO.hiddenReason` has no dedicated "archived" value —
 *  an archived community is, like a non-public one, simply no longer visible
 *  to the public, so both map to `not_public`. */
function communityHiddenReason(community: Community): LandingHiddenReason {
  if (community.accessTier !== AccessTier.Public) return 'not_public';
  if (community.archivedAt !== null) return 'not_public';
  return null;
}

function changemakerHiddenReason(
  changemaker: Changemaker,
): LandingHiddenReason {
  return changemaker.status !== ChangemakerStatus.Published
    ? 'unpublished'
    : null;
}

function memberSummary(profile: Profile): AdminTargetSummary {
  return {
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`,
    avatarUrl: profile.avatarUrl,
  };
}

function communitySummary(community: Community): AdminTargetSummary {
  // Community has no avatar/image column (verified on the entity) — the
  // admin UI falls back to its own placeholder, same as everywhere else a
  // community is rendered without a member's profile photo.
  return { slug: community.slug, name: community.name, avatarUrl: null };
}

function changemakerSummary(changemaker: Changemaker): AdminTargetSummary {
  return {
    slug: changemaker.slug,
    name: changemaker.name,
    avatarUrl: changemaker.imageUrl,
  };
}

/**
 * Service behind the admin-curated live landing page: eligibility rules,
 * admin CRUD + reorder over `landing_feature`, and the public read-time
 * honesty filter (`getPublicFeatures`) that re-checks eligibility on every
 * read rather than trusting it was true when a feature was created — a
 * member revoking `featuredConsent` or a community going private must stop
 * appearing immediately, with no separate cleanup job.
 */
@Injectable()
export class LandingService {
  private readonly logger = new Logger(LandingService.name);

  constructor(
    @InjectRepository(LandingFeature)
    private readonly landingFeatures: Repository<LandingFeature>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Changemaker)
    private readonly changemakers: Repository<Changemaker>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The public landing page payload. Loads active features per section
   * ordered by position, batch-loads their target entities (one query per
   * entity type — never per feature), drops anything that fails the
   * canonical eligibility check at read time, and maps survivors to the
   * public DTOs.
   */
  async getPublicFeatures(): Promise<LandingFeaturesResponseDTO> {
    const [memberFeatures, communityFeatures, changemakerFeatures] =
      await Promise.all([
        this.landingFeatures.find({
          where: { section: LandingSection.Member, active: true },
          order: { position: 'ASC' },
        }),
        this.landingFeatures.find({
          where: { section: LandingSection.Community, active: true },
          order: { position: 'ASC' },
        }),
        this.landingFeatures.find({
          where: { section: LandingSection.Changemaker, active: true },
          order: { position: 'ASC' },
        }),
      ]);

    // The community target ids are known immediately from `communityFeatures`
    // — no need to wait for `communitiesById` to resolve before starting the
    // member-count query, so it joins the same `Promise.all` as the three
    // batch entity loads instead of paying its own serial round trip after.
    const communityTargetIds = communityFeatures.map(
      (feature) => feature.targetId,
    );
    const [
      profilesById,
      communitiesById,
      changemakersById,
      memberCountsByCommunityId,
    ] = await Promise.all([
      this.getProfilesByIds(memberFeatures.map((feature) => feature.targetId)),
      this.getCommunitiesByIds(communityTargetIds),
      this.getChangemakersByIds(
        changemakerFeatures.map((feature) => feature.targetId),
      ),
      this.getCommunityMemberCounts(communityTargetIds),
    ]);

    const members = memberFeatures.flatMap((feature) => {
      const profile = profilesById.get(feature.targetId);
      if (!profile || !isMemberEligible(profile)) return [];
      return [toLandingMemberFeatureDTO(feature, profile)];
    });

    const communities = communityFeatures.flatMap((feature) => {
      const community = communitiesById.get(feature.targetId);
      if (!community || !isCommunityEligible(community)) return [];
      return [
        toLandingCommunityFeatureDTO(
          feature,
          community,
          memberCountsByCommunityId.get(community.id) ?? 0,
        ),
      ];
    });

    const changemakers = changemakerFeatures.flatMap((feature) => {
      const changemaker = changemakersById.get(feature.targetId);
      if (!changemaker || !isChangemakerEligible(changemaker)) return [];
      return [toLandingChangemakerFeatureDTO(feature, changemaker)];
    });

    return { members, communities, changemakers };
  }

  /**
   * Every feature in `section` (active AND inactive), with a target summary,
   * a live `eligible` flag, and a `hiddenReason` so the admin UI can show
   * e.g. "Hidden — consent revoked" even while the row itself stays active.
   */
  async listAdminFeatures(
    section: LandingSection,
  ): Promise<AdminLandingFeatureDTO[]> {
    const features = await this.landingFeatures.find({
      where: { section },
      order: { position: 'ASC' },
    });
    if (!features.length) return [];

    const targetIds = features.map((feature) => feature.targetId);

    if (section === LandingSection.Member) {
      const profilesById = await this.getProfilesByIds(targetIds);
      return features.map((feature) => {
        const profile = profilesById.get(feature.targetId);
        if (!profile)
          return toAdminLandingFeatureDTO(feature, null, false, 'deleted');
        return toAdminLandingFeatureDTO(
          feature,
          memberSummary(profile),
          isMemberEligible(profile),
          memberHiddenReason(profile),
        );
      });
    }

    if (section === LandingSection.Community) {
      const communitiesById = await this.getCommunitiesByIds(targetIds);
      return features.map((feature) => {
        const community = communitiesById.get(feature.targetId);
        if (!community)
          return toAdminLandingFeatureDTO(feature, null, false, 'deleted');
        return toAdminLandingFeatureDTO(
          feature,
          communitySummary(community),
          isCommunityEligible(community),
          communityHiddenReason(community),
        );
      });
    }

    const changemakersById = await this.getChangemakersByIds(targetIds);
    return features.map((feature) => {
      const changemaker = changemakersById.get(feature.targetId);
      if (!changemaker)
        return toAdminLandingFeatureDTO(feature, null, false, 'deleted');
      return toAdminLandingFeatureDTO(
        feature,
        changemakerSummary(changemaker),
        isChangemakerEligible(changemaker),
        changemakerHiddenReason(changemaker),
      );
    });
  }

  /**
   * Entities eligible to be featured in `section` that are NOT already
   * featured there (anti-join on `landing_feature`), optionally narrowed by
   * an ILIKE `search` over name/slug. Capped at `MAX_ELIGIBLE_RESULTS` — see
   * the constant's comment.
   */
  async listEligible(
    section: LandingSection,
    search?: string,
  ): Promise<AdminEligibleEntityDTO[]> {
    const alreadyFeaturedTargetIds = (
      await this.landingFeatures.find({
        where: { section },
        select: { targetId: true },
      })
    ).map((feature) => feature.targetId);
    const trimmedSearch = search?.trim();
    const searchPattern = trimmedSearch
      ? `%${escapeLikeTerm(trimmedSearch)}%`
      : null;

    if (section === LandingSection.Member) {
      const query = this.memberEligibilityQuery();
      if (alreadyFeaturedTargetIds.length) {
        query.andWhere('profile.userId NOT IN (:...alreadyFeaturedTargetIds)', {
          alreadyFeaturedTargetIds,
        });
      }
      if (searchPattern) {
        query.andWhere(
          '(profile.firstName ILIKE :searchPattern OR profile.lastName ILIKE :searchPattern OR profile.slug ILIKE :searchPattern)',
          { searchPattern },
        );
      }
      const profiles = await query
        .orderBy('profile.firstName', 'ASC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (profiles.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(member) truncated at ${MAX_ELIGIBLE_RESULTS} results — narrow the search term to see more.`,
        );
      }
      return profiles.map((profile) =>
        toAdminEligibleEntityDTO(
          profile.userId,
          profile.slug,
          `${profile.firstName} ${profile.lastName}`,
          profile.avatarUrl,
        ),
      );
    }

    if (section === LandingSection.Community) {
      const query = this.communityEligibilityQuery();
      if (alreadyFeaturedTargetIds.length) {
        query.andWhere('community.id NOT IN (:...alreadyFeaturedTargetIds)', {
          alreadyFeaturedTargetIds,
        });
      }
      if (searchPattern) {
        query.andWhere(
          '(community.name ILIKE :searchPattern OR community.slug ILIKE :searchPattern)',
          { searchPattern },
        );
      }
      const communities = await query
        .orderBy('community.name', 'ASC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (communities.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(community) truncated at ${MAX_ELIGIBLE_RESULTS} results — narrow the search term to see more.`,
        );
      }
      return communities.map((community) =>
        toAdminEligibleEntityDTO(
          community.id,
          community.slug,
          community.name,
          null,
        ),
      );
    }

    const query = this.changemakerEligibilityQuery();
    if (alreadyFeaturedTargetIds.length) {
      query.andWhere('changemaker.id NOT IN (:...alreadyFeaturedTargetIds)', {
        alreadyFeaturedTargetIds,
      });
    }
    if (searchPattern) {
      query.andWhere(
        '(changemaker.name ILIKE :searchPattern OR changemaker.slug ILIKE :searchPattern)',
        { searchPattern },
      );
    }
    const changemakers = await query
      .orderBy('changemaker.name', 'ASC')
      .take(MAX_ELIGIBLE_RESULTS)
      .getMany();
    if (changemakers.length === MAX_ELIGIBLE_RESULTS) {
      this.logger.warn(
        `listEligible(changemaker) truncated at ${MAX_ELIGIBLE_RESULTS} results — narrow the search term to see more.`,
      );
    }
    return changemakers.map((changemaker) =>
      toAdminEligibleEntityDTO(
        changemaker.id,
        changemaker.slug,
        changemaker.name,
        changemaker.imageUrl,
      ),
    );
  }

  /** SQL form of `isMemberEligible` (Open visibility + featuredConsent),
   *  used by `listEligible`'s anti-join query where filtering must happen in
   *  Postgres, not in memory. Keep in sync with `isMemberEligible`. */
  private memberEligibilityQuery(): SelectQueryBuilder<Profile> {
    return this.profiles
      .createQueryBuilder('profile')
      .where('profile.visibility = :visibility', {
        visibility: ProfileVisibility.Open,
      })
      .andWhere('profile.featuredConsent = true');
  }

  /** SQL form of `isCommunityEligible` (Public accessTier + not archived).
   *  Keep in sync with `isCommunityEligible`. */
  private communityEligibilityQuery(): SelectQueryBuilder<Community> {
    return this.communities
      .createQueryBuilder('community')
      .where('community.accessTier = :accessTier', {
        accessTier: AccessTier.Public,
      })
      .andWhere('community.archivedAt IS NULL');
  }

  /** SQL form of `isChangemakerEligible` (Published status). Keep in sync
   *  with `isChangemakerEligible`. */
  private changemakerEligibilityQuery(): SelectQueryBuilder<Changemaker> {
    return this.changemakers
      .createQueryBuilder('changemaker')
      .where('changemaker.status = :status', {
        status: ChangemakerStatus.Published,
      });
  }

  /**
   * Creates a feature. Rejects a copy payload that doesn't match the
   * section's required shape, a target that doesn't exist or isn't
   * currently eligible, and — via the unique index on
   * `(section, targetId)` — a duplicate feature for the same target.
   */
  async createFeature(
    adminUserId: string,
    dto: CreateLandingFeatureDto,
  ): Promise<AdminLandingFeatureDTO> {
    const copy = validateLandingCopy(dto.section, dto.copy);
    const targetState = await this.loadTargetState(dto.section, dto.targetId);
    if (!targetState.eligible) {
      throw new BadRequestException(
        `This target cannot be featured right now (${
          targetState.hiddenReason ?? 'ineligible'
        }).`,
      );
    }

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        // Lock this section's existing rows before reading MAX(position), so
        // a concurrent create in the same section can't read the same max and
        // collide on position — it blocks here until this transaction commits
        // (or rolls back) and then re-reads the fresh max. A section with NO
        // existing rows has nothing to lock, so two concurrent FIRST creates
        // in a brand-new section can still both compute position 0 — a
        // narrower residual race than the one this closes, and one the
        // (section, targetId) unique index doesn't catch either since the two
        // creates are for different targets.
        await manager
          .createQueryBuilder(LandingFeature, 'feature')
          .where('feature.section = :section', { section: dto.section })
          .setLock('pessimistic_write')
          .getMany();

        const maxPositionRow = await manager
          .createQueryBuilder(LandingFeature, 'feature')
          .select('MAX(feature.position)', 'maxPosition')
          .where('feature.section = :section', { section: dto.section })
          .getRawOne<{ maxPosition: string | null }>();
        const nextPosition =
          maxPositionRow?.maxPosition != null
            ? Number(maxPositionRow.maxPosition) + 1
            : 0;

        return manager.save(
          this.landingFeatures.create({
            section: dto.section,
            targetId: dto.targetId,
            position: nextPosition,
            copy,
            active: true,
            createdBy: adminUserId,
          }),
        );
      });
      return toAdminLandingFeatureDTO(saved, targetState.summary, true, null);
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_landing_feature_section_target')) {
        throw new ConflictException(
          'This target is already featured in this section.',
        );
      }
      throw error;
    }
  }

  /** Re-validates `copy` against the feature's own (immutable) section when
   *  present, and patches `active`. Neither `section` nor `targetId` can be
   *  changed via update — delete and recreate instead. */
  async updateFeature(
    id: string,
    dto: UpdateLandingFeatureDto,
  ): Promise<AdminLandingFeatureDTO> {
    const feature = await this.landingFeatures.findOne({ where: { id } });
    if (!feature) {
      throw new NotFoundException('Landing feature not found.');
    }

    if (dto.copy !== undefined) {
      feature.copy = validateLandingCopy(feature.section, dto.copy);
    }
    if (dto.active !== undefined) {
      feature.active = dto.active;
    }
    const saved = await this.landingFeatures.save(feature);

    const targetState = await this.loadTargetState(
      saved.section,
      saved.targetId,
    );
    return toAdminLandingFeatureDTO(
      saved,
      targetState.summary,
      targetState.eligible,
      targetState.hiddenReason,
    );
  }

  /**
   * Rewrites every feature's `position` in `dto.section` to the index of its
   * id within `dto.orderedIds`, inside one transaction. `orderedIds` must be
   * exactly the current set of feature ids for that section — anything
   * missing or extra is rejected up front rather than silently dropping or
   * ignoring a row.
   */
  async reorderFeatures(
    dto: ReorderLandingFeaturesDto,
  ): Promise<AdminLandingFeatureDTO[]> {
    await this.dataSource.transaction(async (manager) => {
      // The id-set read and its validation happen INSIDE the transaction,
      // under a row lock on this section — so the set this validates against
      // can't change (another create/delete/reorder in the same section)
      // between the read and the position rewrite below. Locking + validating
      // outside the transaction (the previous shape) left a TOCTOU window: a
      // concurrent create/delete could land in between, and the rewrite below
      // would then run against a stale id-set.
      const existingFeatures = await manager
        .createQueryBuilder(LandingFeature, 'feature')
        .where('feature.section = :section', { section: dto.section })
        .setLock('pessimistic_write')
        .getMany();
      const existingIds = new Set(
        existingFeatures.map((feature) => feature.id),
      );
      const orderedIdsSet = new Set(dto.orderedIds);
      const isExactSameSet =
        dto.orderedIds.length === existingFeatures.length &&
        dto.orderedIds.every((id) => existingIds.has(id)) &&
        existingFeatures.every((feature) => orderedIdsSet.has(feature.id));
      if (!isExactSameSet) {
        throw new BadRequestException(
          'orderedIds must be exactly the current feature ids for this section.',
        );
      }

      // Sequential, not Promise.all — these updates share one transactional
      // connection, and TypeORM does not support concurrent queries on a
      // single QueryRunner.
      for (const [index, featureId] of dto.orderedIds.entries()) {
        await manager.update(
          LandingFeature,
          { id: featureId },
          { position: index },
        );
      }
    });

    return this.listAdminFeatures(dto.section);
  }

  async deleteFeature(id: string): Promise<void> {
    const result = await this.landingFeatures.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Landing feature not found.');
    }
  }

  // ---- batch loaders (one query per entity type, never per feature) -------

  private async getProfilesByIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    return new Map(profiles.map((profile) => [profile.userId, profile]));
  }

  private async getCommunitiesByIds(
    communityIds: string[],
  ): Promise<Map<string, Community>> {
    if (!communityIds.length) return new Map();
    const communities = await this.communities.find({
      where: { id: In(communityIds) },
    });
    return new Map(communities.map((community) => [community.id, community]));
  }

  private async getChangemakersByIds(
    changemakerIds: string[],
  ): Promise<Map<string, Changemaker>> {
    if (!changemakerIds.length) return new Map();
    const changemakers = await this.changemakers.find({
      where: { id: In(changemakerIds) },
    });
    return new Map(
      changemakers.map((changemaker) => [changemaker.id, changemaker]),
    );
  }

  private async getCommunityMemberCounts(
    communityIds: string[],
  ): Promise<Map<string, number>> {
    if (!communityIds.length) return new Map();
    const rows = await this.communityMembers
      .createQueryBuilder('member')
      .select('member.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('member.community_id IN (:...communityIds)', { communityIds })
      .groupBy('member.community_id')
      .getRawMany<{ communityId: string; count: string }>();
    return new Map(rows.map((row) => [row.communityId, Number(row.count)]));
  }

  /** Single-target resolution used by `createFeature`/`updateFeature`, where
   *  only one target is ever looked up per call — batching would add
   *  complexity for no benefit here (contrast the batch loaders above, used
   *  by the list endpoints where N features would otherwise mean N queries). */
  private async loadTargetState(
    section: LandingSection,
    targetId: string,
  ): Promise<TargetState> {
    if (section === LandingSection.Member) {
      const profile = await this.profiles.findOne({
        where: { userId: targetId },
      });
      if (!profile)
        return { eligible: false, hiddenReason: 'deleted', summary: null };
      return {
        eligible: isMemberEligible(profile),
        hiddenReason: memberHiddenReason(profile),
        summary: memberSummary(profile),
      };
    }

    if (section === LandingSection.Community) {
      const community = await this.communities.findOne({
        where: { id: targetId },
      });
      if (!community)
        return { eligible: false, hiddenReason: 'deleted', summary: null };
      return {
        eligible: isCommunityEligible(community),
        hiddenReason: communityHiddenReason(community),
        summary: communitySummary(community),
      };
    }

    const changemaker = await this.changemakers.findOne({
      where: { id: targetId },
    });
    if (!changemaker)
      return { eligible: false, hiddenReason: 'deleted', summary: null };
    return {
      eligible: isChangemakerEligible(changemaker),
      hiddenReason: changemakerHiddenReason(changemaker),
      summary: changemakerSummary(changemaker),
    };
  }
}

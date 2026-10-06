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
import { toImageUrl } from '../common/image-url';
import { escapeLikeTerm } from '../common/like-escape';
import {
  foldedHaystack,
  foldedSearchTerm,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { toVisibleAvatarUrl } from '../common/member-ref';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { topLevelOnly } from '../communities/subcommunity-rules';
import {
  Changemaker,
  ChangemakerStatus,
} from '../changemakers/entities/changemaker.entity';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { hasEnded } from '../events/event-timing';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
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
  LandingCommunityFaceDTO,
  LandingFeaturesResponseDTO,
  LandingHiddenReason,
  toAdminEligibleEntityDTO,
  toAdminLandingFeatureDTO,
  toLandingChangemakerFeatureDTO,
  toLandingCommunityFeatureDTO,
  toLandingGatheringFeatureDTO,
  toLandingMemberFeatureDTO,
  toLandingStoryFeatureDTO,
} from './landing-response';

/** How many roster avatars a featured-community card shows before collapsing
 *  the rest into a "+N" count. Matches the demo card's face strip. */
const LANDING_COMMUNITY_FACE_LIMIT = 5;

/** Cap on `listEligible` results. This backs an admin type-ahead picker,
 *  where the admin types a search term to narrow down: a silent cap is
 *  acceptable here in a way a primary listing page would not tolerate. It is
 *  still a REAL cap: callers relying on this method to enumerate every
 *  eligible entity will not see more than this many without narrowing
 *  `search` first. Mirrors the logger-only truncation precedent in
 *  `AdminCommunitiesService` (`MAX_LISTED_COMMUNITIES`). */
const MAX_ELIGIBLE_RESULTS = 30;

/** The `content_moderation.subject_type` a gathering is reported and taken
 *  down under: the same value `EventsService.SUBJECT_TYPE` (private there) and
 *  `EVENT_MODERATION_SUBJECT_TYPE` in `event-reminders.service.ts` use. */
const GATHERING_MODERATION_SUBJECT_TYPE = 'event';

/** Result of resolving a single `(section, targetId)` pair against its source
 *  entity: whether it currently exists, whether it is eligible to be
 *  featured, why it is hidden if not, and the summary the admin UI renders it
 *  with. */
interface TargetState {
  eligible: boolean;
  hiddenReason: LandingHiddenReason;
  summary: AdminTargetSummary | null;
}

// ---- Canonical eligibility (Global Constraints): the ONLY place these
// rules are expressed. `getPublicFeatures`, `listEligible`, `createFeature`,
// and `listAdminFeatures` all route through these, so eligibility can never
// drift between the read-time honesty filter and the admin picker/CRUD.

// Each predicate below has a SQL twin (`LandingService#memberEligibilityQuery`
// / `#communityEligibilityQuery` / `#changemakerEligibilityQuery` /
// `#gatheringEligibilityQuery` / `#storyEligibilityQuery`), used by
// `listEligible`'s anti-join query, where the same rule has to be expressed
// as a WHERE clause, since that query filters in Postgres. Both forms of a
// rule MUST stay in sync; a change here needs the matching change there, and
// vice versa.

/** Mirrors the "is hidden now" test used throughout the codebase (see
 *  `ProfilesService`, `feed.service.ts`, `member-suggestions.service.ts`):
 *  a profile is hidden only while `hiddenUntil` is set AND still in the
 *  future. */
function isProfileHiddenNow(profile: Profile): boolean {
  return profile.hiddenUntil !== null && profile.hiddenUntil > new Date();
}

/** JS form of the member eligibility rule. Keep in sync with
 *  `memberEligibilityQuery`'s SQL. */
function isMemberEligible(profile: Profile): boolean {
  return (
    profile.visibility === ProfileVisibility.Open &&
    profile.featuredConsent === true &&
    !isProfileHiddenNow(profile) &&
    profile.user?.status === UserStatus.Active
  );
}

/** JS form of the community eligibility rule. Keep in sync with
 *  `communityEligibilityQuery`'s SQL. */
function isCommunityEligible(community: Community): boolean {
  return (
    community.accessTier === AccessTier.Public &&
    community.archivedAt === null &&
    community.parentId === null
  );
}

/** JS form of the changemaker eligibility rule. Keep in sync with
 *  `changemakerEligibilityQuery`'s SQL. */
function isChangemakerEligible(changemaker: Changemaker): boolean {
  return changemaker.status === ChangemakerStatus.Published;
}

/** Whether a resolved profile may appear as a "face" riding along on someone
 *  else's card (a featured community's owner, or a roster-strip member):
 *  open visibility, currently active account, and not hidden. Distinct from
 *  `isMemberEligible`: a face is not itself the featured target, so it skips
 *  the `featuredConsent` check that gates being spotlighted in the Member
 *  section. Used for the owner face in `getPublicFeatures`; the roster-strip
 *  equivalent is enforced directly in `getCommunityRosterFaces`'s SQL, kept in
 *  sync with this predicate by hand. */
function isPublicFace(profile: Profile): boolean {
  return (
    profile.visibility === ProfileVisibility.Open &&
    !isProfileHiddenNow(profile) &&
    profile.user?.status === UserStatus.Active
  );
}

/** Consent is the member's own explicit action, distinct from visibility
 *  (which can change for unrelated reasons), checked first so a
 *  consent-revoked member always reads as "consent_revoked" even if they also
 *  happen to have gone private. */
function memberHiddenReason(profile: Profile): LandingHiddenReason {
  if (!profile.featuredConsent) return 'consent_revoked';
  if (profile.visibility !== ProfileVisibility.Open) return 'went_private';
  return null;
}

/** `AdminLandingFeatureDTO.hiddenReason` has no dedicated "archived" value:
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

/** JS form of the gathering eligibility rule: published, visible to everyone
 *  (`EventVisibility.Public` alone qualifies; members-only, invite-only,
 *  network and community-scoped gatherings stay off the homepage), still
 *  ahead by `hasEnded`'s reading, and clear of any moderator takedown. Keep in sync with
 *  `gatheringEligibilityQuery`'s SQL. A cancelled gathering fails the
 *  `Published` check, since cancelling moves `status` to `Cancelled`. */
function isGatheringEligible(
  event: Event,
  isTakenDown: boolean,
  now: Date,
): boolean {
  return gatheringHiddenReason(event, isTakenDown, now) === null;
}

/** Checked in the order an admin most needs to hear it: a cancelled or draft
 *  gathering reads as that before anything else. A moderator takedown reads
 *  as `not_public`, like an archived community: the public can no longer see
 *  it either way. */
function gatheringHiddenReason(
  event: Event,
  isTakenDown: boolean,
  now: Date,
): LandingHiddenReason {
  if (event.status === EventStatus.Cancelled) return 'cancelled';
  if (event.status !== EventStatus.Published) return 'unpublished';
  if (event.visibility !== EventVisibility.Public) return 'not_public';
  if (isTakenDown) return 'not_public';
  if (hasEnded(event, now)) return 'ended';
  return null;
}

/** JS form of the story eligibility rule: an original magazine article whose
 *  publish instant has arrived. `publishedAt` doubles as the schedule, so a
 *  future value is a scheduled piece and still unpublished. Only originals
 *  qualify, so the homepage shows each piece once: the reader's language
 *  choice on the magazine picks the translation. Keep in sync with
 *  `storyEligibilityQuery`'s SQL. */
function isStoryEligible(article: MagazineArticle, now: Date): boolean {
  return storyHiddenReason(article, now) === null;
}

/** A curated translation maps to `not_public`: like a non-public community,
 *  it is a row the public homepage never shows. */
function storyHiddenReason(
  article: MagazineArticle,
  now: Date,
): LandingHiddenReason {
  if (article.publishedAt === null || article.publishedAt > now) {
    return 'unpublished';
  }
  if (article.translationOfArticleId !== null) return 'not_public';
  return null;
}

function memberSummary(profile: Profile): AdminTargetSummary {
  return {
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`,
    avatarUrl: toImageUrl(profile.avatarUrl),
  };
}

function communitySummary(community: Community): AdminTargetSummary {
  // Communities now carry an optional cover image; surface it (resolved) so the
  // admin picker shows the same thumbnail the public card will. Null cover →
  // the admin UI falls back to its own placeholder, as before.
  return {
    slug: community.slug,
    name: community.name,
    avatarUrl: toImageUrl(community.coverImageUrl),
  };
}

function changemakerSummary(changemaker: Changemaker): AdminTargetSummary {
  return {
    slug: changemaker.slug,
    name: changemaker.name,
    avatarUrl: toImageUrl(changemaker.imageUrl),
  };
}

function gatheringSummary(event: Event): AdminTargetSummary {
  return {
    slug: event.slug,
    name: event.title,
    avatarUrl: toImageUrl(event.coverImageUrl),
  };
}

function storySummary(article: MagazineArticle): AdminTargetSummary {
  return {
    slug: article.slug,
    name: article.title,
    avatarUrl: toImageUrl(article.heroImageKey),
  };
}

/**
 * Service behind the admin-curated live landing page: eligibility rules,
 * admin CRUD + reorder over `landing_feature`, and the public read-time
 * honesty filter (`getPublicFeatures`) that re-checks eligibility on every
 * read, so a member revoking `featuredConsent`, a community going private, a
 * gathering ending or being cancelled, or a story being unpublished stops
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
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(MagazineArticle)
    private readonly articles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly authors: Repository<MagazineAuthor>,
    @InjectRepository(ContentModeration)
    private readonly contentModeration: Repository<ContentModeration>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The public landing page payload. Loads active features per section
   * ordered by position, batch-loads their target entities (a fixed one
   * query per entity type, however many features are on the page), drops
   * anything that fails the canonical eligibility check at read time, and
   * maps survivors to the public DTOs.
   */
  async getPublicFeatures(): Promise<LandingFeaturesResponseDTO> {
    const [
      memberFeatures,
      communityFeatures,
      changemakerFeatures,
      gatheringFeatures,
      storyFeatures,
    ] = await Promise.all([
      this.activeFeatures(LandingSection.Member),
      this.activeFeatures(LandingSection.Community),
      this.activeFeatures(LandingSection.Changemaker),
      this.activeFeatures(LandingSection.Gathering),
      this.activeFeatures(LandingSection.Story),
    ]);

    // The community target ids are known immediately from `communityFeatures`,
    // with no need to wait for `communitiesById` to resolve before starting
    // the member-count query, so it joins the same `Promise.all` as the three
    // batch entity loads and avoids paying its own serial round trip after.
    const communityTargetIds = communityFeatures.map(
      (feature) => feature.targetId,
    );
    const gatheringTargetIds = gatheringFeatures.map(
      (feature) => feature.targetId,
    );
    const [
      profilesById,
      communitiesById,
      changemakersById,
      memberCountsByCommunityId,
      rosterFacesByCommunityId,
      gatheringsById,
      takenDownGatheringIds,
      storiesById,
    ] = await Promise.all([
      this.getProfilesByIds(memberFeatures.map((feature) => feature.targetId)),
      this.getCommunitiesByIds(communityTargetIds),
      this.getChangemakersByIds(
        changemakerFeatures.map((feature) => feature.targetId),
      ),
      this.getCommunityMemberCounts(communityTargetIds),
      this.getCommunityRosterFaces(communityTargetIds),
      this.getGatheringsByIds(gatheringTargetIds),
      this.getTakenDownGatheringIds(gatheringTargetIds),
      this.getStoriesByIds(storyFeatures.map((feature) => feature.targetId)),
    ]);

    // Two lookups that depend on the wave above, run together so they cost a
    // single extra round trip between them. The featured communities' owners:
    // `ownerId` is a `User.id`, which is exactly the key `getProfilesByIds`
    // maps on (`Profile.userId`). The featured stories' bylines: one query
    // for every story on the page.
    const [ownerProfilesByUserId, authorsById] = await Promise.all([
      this.getProfilesByIds(
        [...communitiesById.values()]
          .map((community) => community.ownerId)
          .filter((ownerId): ownerId is string => ownerId !== null),
      ),
      this.getAuthorsByIds(
        [...storiesById.values()].map((article) => article.authorId),
      ),
    ]);

    const members = memberFeatures.flatMap((feature) => {
      const profile = profilesById.get(feature.targetId);
      if (!profile || !isMemberEligible(profile)) return [];
      return [toLandingMemberFeatureDTO(feature, profile)];
    });

    const communities = communityFeatures.flatMap((feature) => {
      const community = communitiesById.get(feature.targetId);
      if (!community || !isCommunityEligible(community)) return [];
      // A community that hides its roster leaks no member faces on the public
      // card: it leans on the count alone.
      const faces = community.rosterVisible
        ? (rosterFacesByCommunityId.get(community.id) ?? [])
        : [];
      // The owner face honours the same privacy, hiding and suspension rules
      // as every other face: a private, hidden or suspended owner drops off
      // the card entirely, with no stale name or avatar left behind.
      const ownerProfile = community.ownerId
        ? (ownerProfilesByUserId.get(community.ownerId) ?? null)
        : null;
      const owner =
        ownerProfile && isPublicFace(ownerProfile) ? ownerProfile : null;
      return [
        toLandingCommunityFeatureDTO(
          feature,
          community,
          memberCountsByCommunityId.get(community.id) ?? 0,
          owner,
          faces,
        ),
      ];
    });

    const changemakers = changemakerFeatures.flatMap((feature) => {
      const changemaker = changemakersById.get(feature.targetId);
      if (!changemaker || !isChangemakerEligible(changemaker)) return [];
      return [toLandingChangemakerFeatureDTO(feature, changemaker)];
    });

    // One clock reading for the whole response, so two gatherings ending in
    // the same second cannot be judged against different instants.
    const now = new Date();

    const gatherings = gatheringFeatures.flatMap((feature) => {
      const event = gatheringsById.get(feature.targetId);
      if (!event) return [];
      const isTakenDown = takenDownGatheringIds.has(event.id);
      if (!isGatheringEligible(event, isTakenDown, now)) return [];
      return [toLandingGatheringFeatureDTO(feature, event)];
    });

    const stories = storyFeatures.flatMap((feature) => {
      const article = storiesById.get(feature.targetId);
      if (!article || !isStoryEligible(article, now)) return [];
      // `author_id` is a non-null FK, so a missing byline means the row
      // changed under this read. Drop the card over printing a blank credit.
      const author = authorsById.get(article.authorId);
      if (!author) return [];
      return [toLandingStoryFeatureDTO(feature, article, author)];
    });

    return { members, communities, changemakers, gatherings, stories };
  }

  /** One section's ACTIVE features in `position` order: what the public page
   *  renders, before the per-target eligibility check. */
  private activeFeatures(section: LandingSection): Promise<LandingFeature[]> {
    return this.landingFeatures.find({
      where: { section, active: true },
      order: { position: 'ASC' },
    });
  }

  /**
   * Every feature in `section` (active AND inactive), with a target summary,
   * a live `eligible` flag, and a `hiddenReason` so the admin UI can show
   * e.g. "Hidden: consent revoked" even while the row itself stays active.
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

    if (section === LandingSection.Gathering) {
      const [gatheringsById, takenDownGatheringIds] = await Promise.all([
        this.getGatheringsByIds(targetIds),
        this.getTakenDownGatheringIds(targetIds),
      ]);
      const now = new Date();
      return features.map((feature) => {
        const event = gatheringsById.get(feature.targetId);
        if (!event)
          return toAdminLandingFeatureDTO(feature, null, false, 'deleted');
        const isTakenDown = takenDownGatheringIds.has(event.id);
        return toAdminLandingFeatureDTO(
          feature,
          gatheringSummary(event),
          isGatheringEligible(event, isTakenDown, now),
          gatheringHiddenReason(event, isTakenDown, now),
        );
      });
    }

    if (section === LandingSection.Story) {
      const storiesById = await this.getStoriesByIds(targetIds);
      const now = new Date();
      return features.map((feature) => {
        const article = storiesById.get(feature.targetId);
        if (!article)
          return toAdminLandingFeatureDTO(feature, null, false, 'deleted');
        return toAdminLandingFeatureDTO(
          feature,
          storySummary(article),
          isStoryEligible(article, now),
          storyHiddenReason(article, now),
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
   * an accent-folded `search` over name/slug (so "joao" finds "João").
   * Capped at `MAX_ELIGIBLE_RESULTS`; see the constant's comment.
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
          `${foldedHaystack('profile', PROFILE_NAME_SEARCH_COLUMNS)} LIKE ${foldedSearchTerm('searchPattern')} ESCAPE '\\'`,
          { searchPattern },
        );
      }
      const profiles = await query
        .orderBy('profile.firstName', 'ASC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (profiles.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(member) truncated at ${MAX_ELIGIBLE_RESULTS} results. Narrow the search term to see more.`,
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
          `${foldedHaystack('community', ['name', 'slug'])} LIKE ${foldedSearchTerm('searchPattern')} ESCAPE '\\'`,
          { searchPattern },
        );
      }
      const communities = await query
        .orderBy('community.name', 'ASC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (communities.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(community) truncated at ${MAX_ELIGIBLE_RESULTS} results. Narrow the search term to see more.`,
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

    if (section === LandingSection.Gathering) {
      const query = this.gatheringEligibilityQuery();
      if (alreadyFeaturedTargetIds.length) {
        query.andWhere('gathering.id NOT IN (:...alreadyFeaturedTargetIds)', {
          alreadyFeaturedTargetIds,
        });
      }
      if (searchPattern) {
        query.andWhere(
          `${foldedHaystack('gathering', ['title', 'slug'])} LIKE ${foldedSearchTerm('searchPattern')} ESCAPE '\\'`,
          { searchPattern },
        );
      }
      // Soonest first: the gathering an admin is most likely to want on the
      // homepage this week leads the picker.
      const events = await query
        .orderBy('gathering.startAt', 'ASC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (events.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(gathering) truncated at ${MAX_ELIGIBLE_RESULTS} results. Narrow the search term to see more.`,
        );
      }
      return events.map((event) =>
        toAdminEligibleEntityDTO(
          event.id,
          event.slug,
          event.title,
          event.coverImageUrl,
        ),
      );
    }

    if (section === LandingSection.Story) {
      const query = this.storyEligibilityQuery();
      if (alreadyFeaturedTargetIds.length) {
        query.andWhere('story.id NOT IN (:...alreadyFeaturedTargetIds)', {
          alreadyFeaturedTargetIds,
        });
      }
      if (searchPattern) {
        query.andWhere(
          `${foldedHaystack('story', ['title', 'slug'])} LIKE ${foldedSearchTerm('searchPattern')} ESCAPE '\\'`,
          { searchPattern },
        );
      }
      // Newest first, the order the magazine itself lists its archive in.
      const articles = await query
        .orderBy('story.publishedAt', 'DESC')
        .take(MAX_ELIGIBLE_RESULTS)
        .getMany();
      if (articles.length === MAX_ELIGIBLE_RESULTS) {
        this.logger.warn(
          `listEligible(story) truncated at ${MAX_ELIGIBLE_RESULTS} results. Narrow the search term to see more.`,
        );
      }
      return articles.map((article) =>
        toAdminEligibleEntityDTO(
          article.id,
          article.slug,
          article.title,
          article.heroImageKey,
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
        `${foldedHaystack('changemaker', ['name', 'slug'])} LIKE ${foldedSearchTerm('searchPattern')} ESCAPE '\\'`,
        { searchPattern },
      );
    }
    const changemakers = await query
      .orderBy('changemaker.name', 'ASC')
      .take(MAX_ELIGIBLE_RESULTS)
      .getMany();
    if (changemakers.length === MAX_ELIGIBLE_RESULTS) {
      this.logger.warn(
        `listEligible(changemaker) truncated at ${MAX_ELIGIBLE_RESULTS} results. Narrow the search term to see more.`,
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

  /** SQL form of `isMemberEligible` (Open visibility + featuredConsent + not
   *  hidden now + active account), used by `listEligible`'s anti-join query,
   *  which filters in Postgres. Keep in sync with `isMemberEligible`. */
  private memberEligibilityQuery(): SelectQueryBuilder<Profile> {
    return this.profiles
      .createQueryBuilder('profile')
      .innerJoin('profile.user', 'user', 'user.status = :status', {
        status: UserStatus.Active,
      })
      .where('profile.visibility = :visibility', {
        visibility: ProfileVisibility.Open,
      })
      .andWhere('profile.featuredConsent = true')
      .andWhere(
        '(profile.hiddenUntil IS NULL OR profile.hiddenUntil <= now())',
      );
  }

  /** SQL form of `isCommunityEligible` (Public accessTier + not archived + not
   *  a space). Keep in sync with `isCommunityEligible`. */
  private communityEligibilityQuery(): SelectQueryBuilder<Community> {
    return topLevelOnly(
      this.communities
        .createQueryBuilder('community')
        .where('community.accessTier = :accessTier', {
          accessTier: AccessTier.Public,
        })
        .andWhere('community.archivedAt IS NULL'),
      'community',
    );
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

  /** SQL form of `isGatheringEligible` (Published + Public visibility + not
   *  ended + not taken down). "Not ended" is `hasEnded`'s rule inverted: the
   *  end instant, or the start when the host gave no end, is still ahead.
   *  Quoted snake_case column names throughout, since TypeORM leaves an
   *  `alias.property` path inside a function call or before `::text`
   *  unrewritten. Keep in sync with `isGatheringEligible`. */
  private gatheringEligibilityQuery(): SelectQueryBuilder<Event> {
    return this.events
      .createQueryBuilder('gathering')
      .where('gathering.status = :status', { status: EventStatus.Published })
      .andWhere('gathering.visibility = :visibility', {
        visibility: EventVisibility.Public,
      })
      .andWhere(
        'COALESCE("gathering"."end_at", "gathering"."start_at") > now()',
      )
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "content_moderation" "moderation"
          WHERE "moderation"."subject_type" = :gatheringSubjectType
            AND "moderation"."subject_id" = "gathering"."id"::text
            AND ("moderation"."hidden_at" IS NOT NULL
              OR "moderation"."removed_at" IS NOT NULL)
        )`,
        { gatheringSubjectType: GATHERING_MODERATION_SUBJECT_TYPE },
      );
  }

  /** SQL form of `isStoryEligible` (an original with its publish instant set
   *  and reached). Keep in sync with `isStoryEligible`. */
  private storyEligibilityQuery(): SelectQueryBuilder<MagazineArticle> {
    return this.articles
      .createQueryBuilder('story')
      .where('story.publishedAt IS NOT NULL')
      .andWhere('story.publishedAt <= now()')
      .andWhere('"story"."translation_of_article_id" IS NULL');
  }

  /**
   * Creates a feature. Rejects a copy payload that doesn't match the
   * section's required shape, a target that doesn't exist or isn't
   * currently eligible, and, via the unique index on `(section, targetId)`,
   * a duplicate feature for the same target.
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
        // collide on position: it blocks here until this transaction commits
        // (or rolls back) and then re-reads the fresh max. A section with NO
        // existing rows has nothing to lock, so two concurrent FIRST creates
        // in a brand-new section can still both compute position 0, a
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
   *  changed via update: delete and recreate to change either. */
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
   * exactly the current set of feature ids for that section: any missing or
   * extra id is rejected up front, with no row silently dropped or ignored.
   */
  async reorderFeatures(
    dto: ReorderLandingFeaturesDto,
  ): Promise<AdminLandingFeatureDTO[]> {
    await this.dataSource.transaction(async (manager) => {
      // The id-set read and its validation happen INSIDE the transaction,
      // under a row lock on this section, so the set this validates against
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

      // Sequential: these updates share one transactional connection, and
      // TypeORM does not support concurrent queries on a single QueryRunner.
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

  // ---- batch loaders (a fixed one query per entity type) -------------------

  private async getProfilesByIds(
    userIds: string[],
  ): Promise<Map<string, Profile>> {
    if (!userIds.length) return new Map();
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
      // `isMemberEligible` and `isPublicFace` both read `profile.user?.status`,
      // so every caller of this batch loader needs the relation loaded.
      relations: { user: true },
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

  private async getGatheringsByIds(
    eventIds: string[],
  ): Promise<Map<string, Event>> {
    if (!eventIds.length) return new Map();
    const events = await this.events.find({ where: { id: In(eventIds) } });
    return new Map(events.map((event) => [event.id, event]));
  }

  /** The subset of `eventIds` a moderator has hidden or removed. One query
   *  for the whole batch, read beside `getGatheringsByIds` so a takedown drops
   *  a featured gathering on the very next public read. */
  private async getTakenDownGatheringIds(
    eventIds: string[],
  ): Promise<Set<string>> {
    if (!eventIds.length) return new Set();
    const rows = await this.contentModeration.find({
      where: {
        subjectType: GATHERING_MODERATION_SUBJECT_TYPE,
        subjectId: In(eventIds),
      },
      select: { subjectId: true, hiddenAt: true, removedAt: true },
    });
    return new Set(
      rows
        .filter((row) => row.hiddenAt !== null || row.removedAt !== null)
        .map((row) => row.subjectId),
    );
  }

  private async getStoriesByIds(
    articleIds: string[],
  ): Promise<Map<string, MagazineArticle>> {
    if (!articleIds.length) return new Map();
    const articles = await this.articles.find({
      where: { id: In(articleIds) },
    });
    return new Map(articles.map((article) => [article.id, article]));
  }

  private async getAuthorsByIds(
    authorIds: string[],
  ): Promise<Map<string, MagazineAuthor>> {
    const uniqueAuthorIds = [...new Set(authorIds)];
    if (!uniqueAuthorIds.length) return new Map();
    const authors = await this.authors.find({
      where: { id: In(uniqueAuthorIds) },
    });
    return new Map(authors.map((author) => [author.id, author]));
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

  /**
   * The first N eligible members (by join date) of each community, joined to
   * their profile, as public roster faces for the featured-community cards.
   * One query for the whole section: a `ROW_NUMBER() OVER (PARTITION BY
   * community_id ...)` window ranks each community's members independently, and
   * the outer filter keeps only the top N per community, so a 5000-member
   * community ships only its top 5 rows here. Ordered by `joined_at ASC` so
   * the owner and longest-standing members lead the strip. Roster-visibility
   * gating stays the caller's own job (`getPublicFeatures`).
   *
   * The inner query joins `users` and requires an open, active, currently
   * unhidden profile before `ROW_NUMBER` ranks the rows, so a private, hidden
   * or suspended member never takes a strip slot: the window function only
   * ever sees eligible rows, so the strip fills with the next eligible member
   * and never leaves a gap. This is the SQL twin of `isPublicFace`; keep both
   * in sync by hand.
   */
  private async getCommunityRosterFaces(
    communityIds: string[],
  ): Promise<Map<string, LandingCommunityFaceDTO[]>> {
    if (!communityIds.length) return new Map();
    const rows = await this.dataSource.query<
      {
        communityId: string;
        firstName: string;
        lastName: string;
        avatarUrl: string | null;
        photoVisible: boolean;
      }[]
    >(
      `SELECT ranked.community_id AS "communityId",
              ranked.first_name AS "firstName",
              ranked.last_name AS "lastName",
              ranked.avatar_url AS "avatarUrl",
              ranked.photo_visible AS "photoVisible"
         FROM (
           SELECT m.community_id,
                  p.first_name,
                  p.last_name,
                  p.avatar_url,
                  p.photo_visible,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.community_id ORDER BY m.joined_at ASC
                  ) AS rn
             FROM community_members m
             JOIN profiles p ON p.user_id = m.user_id
             JOIN users u ON u.id = m.user_id
            WHERE m.community_id = ANY($1::uuid[])
              AND u.status = $3
              AND p.visibility = 'open'
              AND (p.hidden_until IS NULL OR p.hidden_until <= now())
         ) ranked
        WHERE ranked.rn <= $2
        ORDER BY ranked.community_id, ranked.rn`,
      [communityIds, LANDING_COMMUNITY_FACE_LIMIT, UserStatus.Active],
    );

    const facesByCommunity = new Map<string, LandingCommunityFaceDTO[]>();
    for (const row of rows) {
      const faces = facesByCommunity.get(row.communityId) ?? [];
      faces.push({
        name: `${row.firstName} ${row.lastName}`,
        avatarUrl: toVisibleAvatarUrl({
          avatarUrl: row.avatarUrl,
          photoVisible: row.photoVisible,
        }),
      });
      facesByCommunity.set(row.communityId, faces);
    }
    return facesByCommunity;
  }

  /** Single-target resolution used by `createFeature`/`updateFeature`, where
   *  only one target is ever looked up per call: batching would add
   *  complexity for no benefit here (contrast the batch loaders above, used
   *  by the list endpoints where N features would otherwise mean N queries). */
  private async loadTargetState(
    section: LandingSection,
    targetId: string,
  ): Promise<TargetState> {
    if (section === LandingSection.Member) {
      const profile = await this.profiles.findOne({
        where: { userId: targetId },
        // `isMemberEligible` reads `profile.user?.status`.
        relations: { user: true },
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

    if (section === LandingSection.Gathering) {
      const [event, takenDownGatheringIds] = await Promise.all([
        this.events.findOne({ where: { id: targetId } }),
        this.getTakenDownGatheringIds([targetId]),
      ]);
      if (!event)
        return { eligible: false, hiddenReason: 'deleted', summary: null };
      const isTakenDown = takenDownGatheringIds.has(event.id);
      const now = new Date();
      return {
        eligible: isGatheringEligible(event, isTakenDown, now),
        hiddenReason: gatheringHiddenReason(event, isTakenDown, now),
        summary: gatheringSummary(event),
      };
    }

    if (section === LandingSection.Story) {
      const article = await this.articles.findOne({ where: { id: targetId } });
      if (!article)
        return { eligible: false, hiddenReason: 'deleted', summary: null };
      const now = new Date();
      return {
        eligible: isStoryEligible(article, now),
        hiddenReason: storyHiddenReason(article, now),
        summary: storySummary(article),
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  DataSource,
  In,
  MoreThanOrEqual,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { handleFormatError, normalizeHandle } from '../common/handles';
import { toImageUrl } from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectionStatus } from '../connections/entities/connection.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  PROFILE_SEARCH_COLUMNS,
  PROFILE_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchQuery,
  foldedSearchTerm,
  searchRankExpression,
  weightedSearchVector,
} from '../search/search-text';
import { HandlesService } from '../handles/handles.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { StorageService } from '../storage/storage.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { ListMembersQuery, MemberSort } from './dto/list-members.query';
import { SocialLinkDto } from './dto/replace-socials.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { WorkItemDto } from './dto/replace-work.dto';
import { normalizeWorkLinks } from './work-links';
import {
  FeaturedCommunityRefView,
  communityTypeLabel,
} from './featured-communities';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';
import { pruneDiscoverable } from './identities';
import { normalizeOpenTo } from './open-to';
import { closenessFor, type RelatedCloseness } from './related-closeness';
import { reconcileDisciplineProfession } from './professions';
import {
  applyDirectoryFilters,
  countDirectoryFacets,
  type DirectoryFacetCounts,
  type DirectoryFacetGroup,
} from './member-directory.query';
import { Activity } from './entities/activity.entity';
import {
  BoardKind,
  BoardPost,
  BoardPostStatus,
} from './entities/board-post.entity';
import {
  BoardPostResponse,
  BoardResponseKind,
} from './entities/board-post-response.entity';
import {
  BOARD_INSIGHTS_WINDOW_DAYS,
  BOARD_MATCHES_PER_POST,
  BoardInsightsView,
  BoardMatchView,
} from './board-insights';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  BoardResponderView,
  BoardView,
  FullProfileResponse,
  GroupView,
  LimitedProfileResponse,
  MemberCard,
  MutualVoucherCount,
  ProfileCard,
  ProfileRelations,
  RelatedCard,
  SocialLinkView,
  WorkView,
  buildBoardResponderSummary,
  gateAvatarUrl,
  gateLocation,
  sortShapings,
  toBoardView,
  toFullProfile,
  toLimitedProfile,
  toMemberCard,
  toProfileCard,
} from './profile-response';
import { ActivityVisibilityService } from './activity-visibility.service';
import { visibleBand } from './last-active';
import { LastActiveService } from './last-active.service';
import { NowInsightsService } from './now-insights.service';

const PAGE_SIZE = 20;
const RELATED_LIMIT = 4;
// How many rows are READ to fill those four cards. The moderator-takedown gate
// runs after the fetch (see `dropTakenDown`), so reading exactly `RELATED_LIMIT`
// would show a short row whenever one of the matches had been taken down.
// A pool where EVERY row is taken down correctly renders nothing.
const RELATED_READ_LIMIT = RELATED_LIMIT * 3;
// How many activity rows a profile shows. Raised from 6 with the second and
// third kinds (a public community join, a persona publish): six rows was a
// half-screen of a section whose whole job is answering "what has this person
// been up to?".
const ACTIVITY_LIMIT = 12;
// How many rows are READ to fill those. The read-time visibility gate
// (`ActivityVisibilityService`) drops rows whose subject stopped being public,
// so reading exactly `ACTIVITY_LIMIT` would show a short page whenever
// anything went private. Over-fetching absorbs that; a member whose newest
// `ACTIVITY_READ_LIMIT` rows are ALL stale correctly shows nothing.
const ACTIVITY_READ_LIMIT = ACTIVITY_LIMIT * 2;
const DAY_MS = 24 * 60 * 60 * 1000;
// "looking" items expire sooner than "offering" items — a member actively
// searching for something needs a shorter shelf life than one advertising
// something they have to give.
const BOARD_ITEM_LIFESPAN_DAYS: Record<BoardKind, number> = {
  [BoardKind.Looking]: 30,
  [BoardKind.Offering]: 90,
};
// How many times a post can be renewed before a member has to rewrite it.
// Three renewals give a looking post four months and an offering post a year.
export const BOARD_RENEW_LIMIT = 3;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  // A member is reported (and taken down) under the `member` subject type,
  // keyed by EITHER the member's slug OR their raw userId (see
  // `Report.subjectId`'s doc) — the read gate below checks both.
  private static readonly MEMBER_SUBJECT_TYPE = 'member';

  private static isStaffRole(role: string | undefined): boolean {
    return role === UserRole.Admin || role === UserRole.Moderator;
  }

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(BoardPost)
    private readonly boardPosts: Repository<BoardPost>,
    @InjectRepository(BoardPostResponse)
    private readonly boardResponses: Repository<BoardPostResponse>,
    @InjectRepository(Shaping) private readonly shapings: Repository<Shaping>,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupMembership)
    private readonly groupMemberships: Repository<GroupMembership>,
    @InjectRepository(ProfileFeaturedCommunity)
    private readonly featuredCommunities: Repository<ProfileFeaturedCommunity>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(ProfileNowHistory)
    private readonly nowHistory: Repository<ProfileNowHistory>,
    private readonly dataSource: DataSource,
    private readonly vouchService: VouchService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly hiddenFrom: HiddenFromService,
    private readonly handles: HandlesService,
    private readonly storage: StorageService,
    private readonly contentModeration: ContentModerationService,
    // Batched crop lookup (`MediaCropService.getMany`) for a work item's
    // `imageUrl` sibling `crop`.
    private readonly mediaCropService: MediaCropService,
    // The read half of the activity privacy gate: re-checks that each stored
    // row's subject is still public before it is served. See
    // `ActivityVisibilityService`.
    private readonly activityVisibility: ActivityVisibilityService,
    // The coarse "recently active" band. Read-only from here: the only writer
    // is `LastActiveListener` off a session refresh.
    private readonly lastActive: LastActiveService,
    // How fast this member answers hellos, as a coarse phrase. A per-profile
    // aggregate over `connections`, so it is read here (the single-profile
    // path) only, never from `searchMembers`/`toMemberCard` (the list path),
    // where one aggregate per row would turn a single query into N.
    private readonly nowInsights: NowInsightsService,
  ) {}

  /**
   * The caller's own profile. `CurrentUserData` carries no slug, so resolve it
   * from the profile row first and delegate — the viewer is themselves, so
   * `canViewFull` always passes and this is always the full response.
   *
   * The extra `findOne` is deliberate: duplicating `getBySlug`'s assembly to
   * save one indexed primary-key lookup would be two code paths that must stay
   * identical forever, which is exactly the drift the bootstrap payload cannot
   * afford.
   */
  async getMine(
    userId: string,
  ): Promise<FullProfileResponse | LimitedProfileResponse> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // The viewer IS the owner here, so the moderation gate short-circuits on the
    // owner arm regardless of role — the passed role never matters for `getMine`.
    return this.getBySlug(profile.slug, userId);
  }

  async getBySlug(
    slug: string,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<FullProfileResponse | LimitedProfileResponse> {
    const profile = await this.findBySlugOrThrow(
      slug,
      viewerUserId,
      viewerRole,
    );
    const vouchCount = await this.vouchService.getVouchCount(profile.userId);
    if (!(await this.canViewFull(profile, viewerUserId))) {
      return toLimitedProfile(
        profile,
        vouchCount,
        profile.userId === viewerUserId,
        // The limited card carries the same gated trust cue as the full
        // profile: this is the "should I ask to connect?" surface.
        await this.loadMutualVoucherCount(profile, viewerUserId),
      );
    }
    return this.buildFullProfile(profile, vouchCount, viewerUserId);
  }

  /**
   * Resolve `slug` to a `Profile`, applying the same not-found-indistinguish-
   * able-from-hidden gates `getBySlug` has always applied — block, hidden-from
   * (member profile v2 Task 5), self-hide (member profile v2 Task 6), and
   * moderator takedown — WITHOUT assembling a full/limited response. Factored
   * out of `getBySlug` so any endpoint that needs "does the viewer get to know
   * this member/slug exists at all?" (currently `getBySlug` itself and the
   * `GET /:slug/mutuals` controller route) shares one answer instead of
   * re-deriving or drifting out of sync.
   *
   * A slug with no live profile is not automatically a 404: PRD-204 forwards a
   * renamed-away-from username while its reclaim cooldown is still running.
   * See `throwMovedOrNotFound`.
   */
  async findBySlugOrThrow(
    slug: string,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<Profile> {
    // PRD-204: a slug with no live profile may be a name this member renamed
    // away from and still holds the reclaim reservation for.
    // `throwMovedOrNotFound` always throws, so the `??` branch never yields.
    const profile =
      (await this.profiles.findOne({ where: { slug } })) ??
      (await this.throwMovedOrNotFound(slug, viewerUserId, viewerRole));
    await this.assertVisibleOrNotFound(profile, viewerUserId, viewerRole);
    return profile;
  }

  /**
   * The four "does the viewer get to know this member exists at all?" gates,
   * each throwing the SAME 404 so a hidden member is indistinguishable from a
   * slug that was never real. Shared by `findBySlugOrThrow` and by the moved-
   * handle path below, which must not answer "moved" for a member the viewer
   * is not allowed to know about.
   */
  private async assertVisibleOrNotFound(
    profile: Profile,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<void> {
    // Computed once, up front, so every owner-exception below (self-hide,
    // takedown) reads the same answer.
    const isOwner = profile.userId === viewerUserId;
    // Block-gate the lookup (P1-3): never surface a member's profile to someone
    // they've blocked, or who has blocked them — the same 404 subprofiles and
    // flatmate profiles already return, so a block is indistinguishable from a
    // non-existent slug. `isBlockedEitherWay` short-circuits to false for the
    // viewer's own profile (equal ids), so `getMine` is unaffected.
    if (
      await this.blockFilter.isBlockedEitherWay(viewerUserId, profile.userId)
    ) {
      throw new NotFoundException('Profile not found');
    }
    // Hidden-from gate (member profile v2 Task 5): same 404-not-distinguish-
    // able-from-nonexistent posture as the block gate above, but one-way —
    // `profile.userId` is the owner who may have hidden themself FROM
    // `viewerUserId`, not the reverse. `isHiddenFrom` short-circuits to
    // false when they're equal, so `getMine` is unaffected.
    if (await this.hiddenFrom.isHiddenFrom(profile.userId, viewerUserId)) {
      throw new NotFoundException('Profile not found');
    }
    // Self-hide gate (member profile v2 Task 6, "Hide me for 24 hours"): same
    // 404-not-distinguishable-from-nonexistent posture as the block/hidden-
    // from gates above, but blanket rather than viewer-relative — a live
    // `hiddenUntil` hides the profile from EVERY non-owner viewer, not just
    // one. The owner is exempted so they can always see (and manage) their
    // own hidden profile, matching the design's "you're hidden" banner.
    if (!isOwner && profile.hiddenUntil && profile.hiddenUntil > new Date()) {
      throw new NotFoundException('Profile not found');
    }
    // Moderator takedown gate. A `hide_content`/`remove_content` on this member
    // 404s the profile for everyone but the member themselves and platform
    // staff (admin/moderator) — the same don't-leak-existence posture as a
    // block above and `CommunitiesService.getBySlug`. The member subject is
    // addressed by slug OR userId, so both are checked.
    if (!isOwner && !ProfilesService.isStaffRole(viewerRole)) {
      await this.assertNotTakenDown(profile.slug, profile.userId);
    }
  }

  /**
   * PRD-204. A printed QR card, a shared `/members/<slug>` link and a pasted
   * `@mention` all die the moment a member renames, because the profile lookup
   * reads the live `slug` column alone. The reclaim ledger already knows who
   * held the name, so a rename can forward instead of breaking.
   *
   * The forwarding answer is bounded by the SAME window that protects the name:
   * `previousProfileOwnerOf` returns an owner only while the reclaim cooldown
   * is running and nobody else holds the name. Once the cooldown lapses (or the
   * previous owner re-releases it to someone who claims it), this method stops
   * answering, so a stranger who legitimately takes the name can never inherit
   * traffic and trust meant for its previous owner.
   *
   * It also runs the full visibility gate on the former owner before saying
   * anything. A member who blocked the viewer, hid from them, is inside "Hide
   * me for 24 hours", or has been taken down gets the plain 404 they would have
   * got under their current slug, so the move is never a way to confirm that
   * someone exists.
   *
   * Never returns. The caller treats it as a throw.
   */
  private async throwMovedOrNotFound(
    slug: string,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<never> {
    const previousOwnerUserId = await this.handles.previousProfileOwnerOf(slug);
    if (!previousOwnerUserId) {
      throw new NotFoundException('Profile not found');
    }
    const moved = await this.profiles.findOne({
      where: { userId: previousOwnerUserId },
    });
    if (!moved) {
      throw new NotFoundException('Profile not found');
    }
    // Throws the plain 404 for a viewer who may not know this member exists.
    await this.assertVisibleOrNotFound(moved, viewerUserId, viewerRole);
    // An application-level "moved" payload rather than an HTTP 301/308, for two
    // reasons that are each on their own fatal to a bare redirect. A 301/308 is
    // permanently cacheable by browsers and CDNs, and this forwarding MUST
    // expire with the reclaim cooldown. And `fetch` follows a redirect
    // transparently, so the SPA would render the profile under the dead URL
    // instead of correcting the address bar. The frontend branches on `code`
    // and re-navigates to `slug` with `replace: true`.
    throw new NotFoundException({
      code: 'PROFILE_MOVED',
      message: 'That username has moved',
      slug: moved.slug,
    });
  }

  private async buildFullProfile(
    profile: Profile,
    vouchCount: number,
    // The actual caller, not just an isOwner bool: `loadRelated` below needs
    // it too, because a `related` entry (a DIFFERENT member, similar by tags/
    // location to the profile being viewed — never the profile owner, see the
    // `p.user_id != :self` exclusion there) can still legitimately BE the
    // viewer themselves, and that person must see their own real photo/hood
    // regardless of their own photoVisible/hoodVisible toggle.
    viewerUserId: string,
  ): Promise<FullProfileResponse> {
    // Owner-only private fields (Interests) are included only when true.
    const isOwner = profile.userId === viewerUserId;
    const userId = profile.userId;
    const [
      socials,
      work,
      board,
      skills,
      shapings,
      activity,
      groups,
      related,
      featuredCommunities,
    ] = await Promise.all([
      this.socialLinks.find({
        where: { userId },
        order: { position: 'ASC' },
      }),
      this.workItems.find({ where: { userId }, order: { position: 'ASC' } }),
      this.boardPosts.find({ where: { userId }, order: { position: 'ASC' } }),
      this.skills.find({ where: { userId }, order: { position: 'ASC' } }),
      this.shapings.find({ where: { userId } }),
      this.loadVisibleActivity(userId),
      this.loadGroups(userId),
      this.loadRelated(profile, viewerUserId),
      this.loadFeaturedCommunities(userId),
    ]);
    const rels: ProfileRelations = {
      socials,
      work,
      board,
      skills,
      groups,
      shapings,
      activity,
      related,
      featuredCommunities,
    };
    // ONE batched crop lookup for every work item's image — never a per-item
    // query.
    const crops = await this.mediaCropService.getMany(
      work.flatMap((workItem) =>
        workItem.imageUrl ? [workItem.imageUrl] : [],
      ),
    );
    // The three reads below are all about the PROFILE OWNER (not the viewer),
    // and independent of each other and of the parallel block above, so they
    // run together rather than in series.
    // `activityBand` is one primary-key lookup on a two-column table;
    // `mutualVoucherCount` is two bounded trust-graph reads; `respondsWithin`
    // is one grouped aggregate over `connections`.
    const [activityBand, mutualVoucherCount, respondsWithin] =
      await Promise.all([
        // The band the VIEWER may see: `visibleBand` applies the member's
        // opt-out, with the owner exempted so their own switch has a visible
        // effect.
        this.lastActive
          .getSignal(userId)
          .then((signal) => visibleBand(signal, isOwner)),
        this.loadMutualVoucherCount(profile, viewerUserId),
        // Ungated, same as `now`/`notHereFor`: this is the single-profile
        // read path, never the member-directory list path (`searchMembers`),
        // which must not call this per row.
        this.nowInsights.getRespondsWithin(userId),
      ]);
    // Response counts and the first few responders for this member's board,
    // in ONE query keyed by post id — never per post. See loadBoardResponses.
    // `viewerUserId` gates each responder by the same visibility rule every
    // other surface uses: a responder must never be named to a viewer they
    // blocked, or who blocked/hid from them.
    const boardResponses = await this.loadBoardResponses(
      board.map((boardPost) => boardPost.id),
      viewerUserId,
    );
    return toFullProfile(
      profile,
      rels,
      vouchCount,
      isOwner,
      crops,
      activityBand,
      mutualVoucherCount,
      respondsWithin,
      boardResponses,
    );
  }

  /**
   * Response counts and the first few responders for a member's board, in one
   * query. Returns a map keyed by board post id so the caller can zip it onto
   * the posts it already has.
   *
   * `viewerUserId` gates every responder row by the SAME "may this viewer see
   * this member at all?" rule every other surface applies
   * (`applyMemberVisibilityGates` + active-user join + `dropTakenDown`) —
   * this is the more exposed of the two board reads that need it (the other
   * is `getBoardInsights`'s matches): a responder's name and photo are shown
   * to any VISITOR of the post owner's profile, not just the owner. A
   * responder who has blocked the viewer, been blocked by them, hidden their
   * own profile from them, is self-hidden, or been taken down by a moderator
   * must not appear here by name — and since the counts below are derived
   * from the SAME filtered rows, filtering also keeps `responseCount`/
   * `helloCount` honest rather than counting someone who is invisible.
   */
  private async loadBoardResponses(
    postIds: string[],
    viewerUserId: string,
  ): Promise<
    Map<
      string,
      {
        responders: BoardResponderView[];
        responseCount: number;
        helloCount: number;
      }
    >
  > {
    if (!postIds.length) return new Map();
    const qb = this.boardResponses
      .createQueryBuilder('response')
      .innerJoin(Profile, 'profile', 'profile.user_id = response.responder_id')
      // A deactivated (paused, or mid erasure-grace-period), suspended, or
      // still-pending responder must never surface by name — same active-only
      // rule `directoryBaseQuery` applies via `p.user`.
      .innerJoin(
        'profile.user',
        'profileUser',
        'profileUser.status = :active',
        {
          active: UserStatus.Active,
        },
      )
      .select([
        'response.post_id AS post_id',
        'response.kind AS kind',
        'response.created_at AS created_at',
        'profile.slug AS slug',
        'profile.first_name AS first',
        'profile.last_name AS last',
        'profile.avatar_url AS avatar_url',
        'profile.photo_visible AS photo_visible',
        'profile.user_id AS user_id',
      ])
      .where('response.post_id IN (:...postIds)', { postIds });
    this.applyMemberVisibilityGates(qb, viewerUserId, 'profile');
    const fetched = await qb.orderBy('response.created_at', 'ASC').getRawMany<{
      post_id: string;
      kind: string;
      created_at: Date;
      slug: string;
      first: string;
      last: string | null;
      avatar_url: string | null;
      photo_visible: boolean;
      user_id: string;
    }>();
    // Moderator takedown is the fourth gate and has no single-column in-query
    // form (see `dropTakenDown`), so it runs post-query, same as everywhere
    // else in this file — and before the grouping below, so a taken-down
    // responder never reaches the counts or the avatar list. `dropTakenDown`
    // reads `.userId` (camelCase); the raw row keeps its own `user_id` too,
    // widened rather than renamed, since nothing downstream needs it.
    const rows = await this.dropTakenDown(
      fetched.map((row) => ({ ...row, userId: row.user_id })),
    );
    // Group in application code: the counts and the capped avatar list come off
    // the same rows, so one pass beats two aggregate queries.
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = grouped.get(row.post_id) ?? [];
      bucket.push(row);
      grouped.set(row.post_id, bucket);
    }
    const result = new Map<
      string,
      {
        responders: BoardResponderView[];
        responseCount: number;
        helloCount: number;
      }
    >();
    for (const [postId, bucket] of grouped) {
      const help = bucket.filter((row) => row.kind === 'help');
      const summary = buildBoardResponderSummary(
        help.map((row) => ({
          slug: row.slug,
          first: row.first,
          last: row.last,
          // Same resolved-URL shape every other avatar on the wire uses (see
          // toProfileCard/gateAvatarUrl) — the raw column is a storage key or
          // external URL, not something the frontend can render directly.
          avatarUrl: toImageUrl(row.avatar_url),
          photoVisible: row.photo_visible,
        })),
        help.length,
      );
      result.set(postId, {
        ...summary,
        helloCount: bucket.filter((row) => row.kind === 'hello').length,
      });
    }
    return result;
  }

  /**
   * The member's newest activity rows, narrowed to those whose subject is
   * STILL public, capped at `ACTIVITY_LIMIT`.
   *
   * The write-time gate in `ActivityListener` is not enough on its own: a
   * public event can be switched to members-only, a public community to
   * request-to-join, a published persona unpublished, all AFTER the row was
   * written. `ActivityVisibilityService` re-checks each row's stored subject
   * and drops the ones that stopped being public (and purges them, so the
   * anonymous public-profile endpoint reading the same table cannot serve them
   * either). Reading `ACTIVITY_READ_LIMIT` rows and slicing after the filter
   * keeps the page full when a few drop.
   */
  private async loadVisibleActivity(userId: string): Promise<Activity[]> {
    const rows = await this.activities.find({
      where: { userId },
      order: { occurredAt: 'DESC' },
      take: ACTIVITY_READ_LIMIT,
    });
    const visible = await this.activityVisibility.filterVisible(rows);
    return visible.slice(0, ACTIVITY_LIMIT);
  }

  /**
   * "How many members you know vouched for them" for ONE profile read.
   *
   * Reuses the two existing batched primitives rather than adding a third
   * trust-graph query shape: `VouchService.getNamedVoucherIds` (active,
   * non-anonymous vouchers, capped) intersected with
   * `ConnectionsService.acceptedConnectionsAmong` (which candidate ids are the
   * viewer's accepted connections, one bounded query). Both are the same
   * methods the connection-card `{mutuals, vouchBadge}` batch is built from,
   * so there is one definition of "vouched for them" and one of "you know
   * them" in the codebase.
   *
   * Returns `null` rather than a number in the two cases documented on
   * {@link MutualVoucherCount}: the viewer is the member, or the member has
   * hidden their voucher roster. The roster gate is the important one. A
   * viewer-relative count is a partial roster to anyone who knows their own
   * connection list, which every viewer does, so `vouchersVisible: false` has
   * to suppress it. The plain `vouchCount` beside it is unaffected, matching
   * `VouchService.listVouchers`, which still returns the true total with an
   * empty roster.
   *
   * The viewer can never be counted in their own answer: nobody is an accepted
   * connection of themselves, so a vouch the viewer made drops out for free
   * (it surfaces as the connections `you-vouched` badge instead).
   */
  private async loadMutualVoucherCount(
    profile: Profile,
    viewerUserId: string,
  ): Promise<MutualVoucherCount> {
    if (profile.userId === viewerUserId) {
      return null;
    }
    if (!profile.vouchersVisible) {
      return null;
    }
    const voucherIds = await this.vouchService.getNamedVoucherIds(
      profile.userId,
    );
    if (!voucherIds.length) {
      return 0;
    }
    const connectedVouchers =
      await this.connectionsService.acceptedConnectionsAmong(
        viewerUserId,
        voucherIds,
      );
    return connectedVouchers.size;
  }

  private async loadGroups(userId: string): Promise<GroupView[]> {
    const rows = await this.groupMemberships
      .createQueryBuilder('gm')
      .innerJoin(Group, 'g', 'g.id = gm.group_id')
      .select('g.name', 'name')
      .addSelect('gm.role', 'role')
      .where('gm.user_id = :userId', { userId })
      .orderBy('g.name', 'ASC')
      .getRawMany<{ name: string; role: string }>();
    return rows.map((r) => ({ name: r.name, role: r.role }));
  }

  /**
   * Resolve the member's featured-community pins for display, in pin order. The
   * pin table stores only (community, position); name/type/role/count are joined
   * live here so a pin stays truthful as things change:
   *
   *  - The INNER JOIN to `community_members` (on the PROFILE OWNER's membership)
   *    means a pin the member has since LEFT drops out entirely — role comes
   *    from that same row, so it always reflects their current standing.
   *  - Private-tier communities are excluded, mirroring the picker: a profile
   *    never advertises that its owner is in a private community, even if the
   *    tier changed to private after the pin was made.
   *
   * `countLabel` is the community's live roster size (`community_members` count).
   */
  private async loadFeaturedCommunities(
    userId: string,
  ): Promise<FeaturedCommunityRefView[]> {
    const rows = await this.featuredCommunities
      .createQueryBuilder('pin')
      .innerJoin(Community, 'c', 'c.id = pin.community_id')
      .innerJoin(
        CommunityMember,
        'cm',
        'cm.community_id = c.id AND cm.user_id = :userId',
        { userId },
      )
      .where('pin.user_id = :userId', { userId })
      .andWhere('c.access_tier != :private', { private: AccessTier.Private })
      .select('c.id', 'communityId')
      .addSelect('c.slug', 'slug')
      .addSelect('c.name', 'name')
      .addSelect('c.tagline', 'tagline')
      .addSelect('c.type', 'type')
      .addSelect('cm.role', 'role')
      // The display fields the shared community card renders alongside the
      // name: its tag pills, its letterhead cover, and this week's activity.
      // Selected in the same pass rather than fetched per pin.
      .addSelect('c.tags', 'tags')
      .addSelect('c.cover_image_url', 'coverImageUrl')
      // The community's own square identity mark. Rides the SAME select as
      // the cover, so profile pins inherit it with no extra query and no
      // N+1. `CommunityCardShell`'s prop is optional and an absent mark draws
      // nothing, so an unmarked community's pin is unchanged. PRD-146.
      .addSelect('c.avatar_image_url', 'avatarImageUrl')
      .addSelect('c.active_this_week', 'activeThisWeek')
      .orderBy('pin.position', 'ASC')
      .getRawMany<{
        communityId: string;
        slug: string;
        name: string;
        tagline: string;
        type: CommunityType;
        role: RosterRole;
        tags: string[] | null;
        coverImageUrl: string | null;
        avatarImageUrl: string | null;
        activeThisWeek: number | string | null;
      }>();

    if (rows.length === 0) {
      return [];
    }

    // One grouped count across all pinned communities — the live roster size
    // each `countLabel` renders (avoids a per-pin count query).
    const countRows = await this.communityMembers
      .createQueryBuilder('cm')
      .select('cm.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('cm.community_id IN (:...ids)', {
        ids: rows.map((r) => r.communityId),
      })
      .groupBy('cm.community_id')
      .getRawMany<{ communityId: string; count: string }>();
    const memberCountById = new Map(
      countRows.map((r) => [r.communityId, Number(r.count)]),
    );

    return rows.map((r) => {
      const memberCount = memberCountById.get(r.communityId) ?? 0;
      return {
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        type: r.type,
        typeLabel: communityTypeLabel(r.type),
        countLabel: `${memberCount} members`,
        role: r.role,
        tags: r.tags ?? [],
        coverImageUrl: toImageUrl(r.coverImageUrl),
        avatarImageUrl: toImageUrl(r.avatarImageUrl),
        activeThisWeek: Number(r.activeThisWeek ?? 0),
      };
    });
  }

  private async loadRelated(
    profile: Profile,
    // The `related` set is filtered to exclude the PROFILE OWNER
    // (`p.user_id != :self` below) but not the viewer — a related member (by
    // shared tags/location) can legitimately BE the person looking at this
    // page, and that person must see their own real photo regardless of
    // their own `photoVisible` toggle. See `gateAvatarUrl`.
    viewerUserId: string,
  ): Promise<RelatedCard[]> {
    const hasTags = profile.tags.length > 0;
    const hasLocation = !!profile.location;
    if (!hasTags && !hasLocation) {
      return [];
    }
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.user_id != :self', { self: profile.userId });
    // ENG-150: the same viewer gates the directory applies. A related card
    // carries a member's name, pronouns and photo, so it is a read path like
    // any other: someone who blocked the viewer, hid from them, or turned on
    // "Hide me for 24 hours" must not appear here either.
    this.applyMemberVisibilityGates(qb, viewerUserId);
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (hasTags) {
      conds.push('p.tags && :tags');
      params.tags = profile.tags;
    }
    if (hasLocation) {
      conds.push('p.location = :loc');
      params.loc = profile.location;
    }
    qb.andWhere(`(${conds.join(' OR ')})`, params)
      // `firstName` alone ties constantly across a member base, and a tie under
      // a LIMIT makes the four cards shuffle between two requests. `userId` is
      // the primary key, so it breaks every tie.
      .orderBy('p.firstName', 'ASC')
      .addOrderBy('p.userId', 'ASC')
      // Read a wider pool than we render: the fourth gate (moderator takedown)
      // has no in-query form here, so it drops rows AFTER the fetch and reading
      // exactly `RELATED_LIMIT` would leave a short row of cards whenever a
      // match had been taken down.
      .take(RELATED_READ_LIMIT);
    const pool = await this.dropTakenDown(await qb.getMany());
    const rows = pool.slice(0, RELATED_LIMIT);
    const [counts, closeness] = await Promise.all([
      this.vouchService.getVouchCounts(rows.map((r) => r.userId)),
      this.loadCloseness(profile, rows, viewerUserId),
    ]);
    return rows.map((r) => {
      const isSelf = r.userId === viewerUserId;
      return {
        ...toProfileCard(r, counts.get(r.userId) ?? 0),
        avatarUrl: gateAvatarUrl(r, isSelf),
        // Same two-layer gate `toMemberCard` applies to a directory card: a
        // `network`/`private` member shows no neighbourhood at all, and an
        // `open` one shows it only to themselves or once they opted into
        // `hoodVisible`.
        location:
          r.visibility === ProfileVisibility.Open
            ? gateLocation(r, isSelf)
            : null,
        closeness: closeness.get(r.userId) ?? null,
      };
    });
  }

  /**
   * The one chip each related card carries ("Vouched for Ines", "Both in
   * Editorial Reading Circle"), keyed by user id. Two queries for the whole
   * set of four (vouch directions, shared communities); every other signal
   * comes off rows already in memory.
   *
   * The privacy toggles and the ranking both live in `closenessFor`, which is
   * pure and specced; this method's whole job is to read the two queries and
   * hand it facts that are already gated on the two things only a Profile row
   * can answer (the `open`-visibility layer, and `gateLocation`).
   */
  private async loadCloseness(
    owner: Profile,
    rows: Profile[],
    viewerUserId: string,
  ): Promise<Map<string, RelatedCloseness>> {
    const ids = rows.map((r) => r.userId);
    const out = new Map<string, RelatedCloseness>();
    if (!ids.length) {
      return out;
    }
    const [directions, communities] = await Promise.all([
      this.vouchService.getPublicVouchDirections(owner.userId, ids),
      this.sharedCommunityNames(owner.userId, ids),
    ]);
    // The owner's own neighbourhood, under the same gate their profile header
    // renders it with (`toFullProfile`). A member who hid their hood hid it
    // from this chip too, whichever card it would have sat on.
    const ownerHood = gateLocation(owner, owner.userId === viewerUserId);
    for (const row of rows) {
      const isSelf = row.userId === viewerUserId;
      const rowOpen = row.visibility === ProfileVisibility.Open;
      const rowHood = rowOpen ? gateLocation(row, isSelf) : null;
      const closeness = closenessFor({
        ownerVouchersVisible: owner.vouchersVisible,
        theirVouchersVisible: row.vouchersVisible,
        theyVouchedForOwner: directions.vouchedForYou.has(row.userId),
        ownerVouchedForThem: directions.youVouched.has(row.userId),
        sharedCommunity: communities.get(row.userId) ?? null,
        theirProfileOpen: rowOpen,
        ownerOpenTo: owner.openTo,
        theirOpenTo: row.openTo,
        ownerTags: owner.tags,
        theirTags: row.tags,
        ownerHood,
        theirHood: rowHood,
      });
      if (closeness) {
        out.set(row.userId, closeness);
      }
    }
    return out;
  }

  /**
   * For each of `otherIds`, the name of one community they and `ownerUserId`
   * are both on the roster of, or nothing. Alphabetical, so a pair always
   * yields the same name instead of shuffling between reads.
   *
   * Two gates, both the community's own promise rather than the viewer's: a
   * private-tier community is never advertised (mirroring
   * `loadFeaturedCommunities`), and neither is one whose roster has been
   * turned invisible. "Both in X" is a statement about who is on that roster,
   * so `rosterVisible: false` forbids it just as surely as the tier does.
   */
  private async sharedCommunityNames(
    ownerUserId: string,
    otherIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.communityMembers
      .createQueryBuilder('mine')
      .innerJoin(
        CommunityMember,
        'theirs',
        'theirs.community_id = mine.community_id AND theirs.user_id IN (:...otherIds)',
        { otherIds },
      )
      .innerJoin(Community, 'c', 'c.id = mine.community_id')
      .where('mine.user_id = :ownerUserId', { ownerUserId })
      .andWhere('c.access_tier != :privateTier', {
        privateTier: AccessTier.Private,
      })
      .andWhere('c.roster_visible = true')
      .select('theirs.user_id', 'userId')
      .addSelect('c.name', 'name')
      .orderBy('c.name', 'ASC')
      .getRawMany<{ userId: string; name: string }>();
    const out = new Map<string, string>();
    for (const row of rows) {
      if (!out.has(row.userId)) {
        out.set(row.userId, row.name);
      }
    }
    return out;
  }

  private async canViewFull(
    profile: Profile,
    viewerUserId: string,
  ): Promise<boolean> {
    if (profile.userId === viewerUserId) {
      return true; // owner
    }
    if (profile.visibility === ProfileVisibility.Open) {
      return true;
    }
    if (profile.visibility === ProfileVisibility.Network) {
      // network: accepted connections see the full profile.
      return this.connectionsService.areConnected(viewerUserId, profile.userId);
    }
    return false; // private → limited card to everyone but the owner
  }

  /**
   * 404s the profile when a moderator has hidden or removed this member. The
   * member subject can be keyed by either the slug or the userId in a report
   * (`Report.subjectId`), so both are checked and the strongest state wins —
   * either a hide or a removal takes the profile down for a non-staff,
   * non-owner viewer (callers gate the owner/staff bypass before calling).
   */
  private async assertNotTakenDown(
    slug: string,
    userId: string,
  ): Promise<void> {
    const subjectIds = [slug, userId];
    const states = await this.contentModeration.statesForAnyType(
      [ProfilesService.MEMBER_SUBJECT_TYPE],
      subjectIds,
    );
    const takenDown = subjectIds.some((subjectId) => {
      const state = states.get(subjectId);
      return !!state && (state.hidden || state.removed);
    });
    if (takenDown) {
      throw new NotFoundException('Profile not found');
    }
  }

  /**
   * List form of `assertNotTakenDown`: drops every candidate a moderator has
   * hidden or removed, in ONE batched lookup for the whole pool. Same
   * both-keys rule as the single-profile gate, because a member can be
   * reported under either their slug or their user id.
   *
   * Generic over anything carrying `{slug, userId}` rather than pinned to
   * `Profile` — board reads (`loadBoardResponses`, `getBoardInsights`) call
   * this over plain raw-query rows (a responder or a matched member, each
   * shaped down to just those two fields plus whatever the caller already
   * selected), not `Profile` entities, and a second takedown-filtering
   * function for that shape would be exactly the drift this method's own
   * "ONE spelling" precedent (see `applyMemberVisibilityGates`) exists to
   * prevent.
   *
   * Post-query rather than in-query on purpose. The subject is addressed by two
   * different columns and a REMOVED member counts as well as a hidden one, so
   * `ContentModerationService.excludeHidden` (one column, hidden-but-not-removed
   * only) is the wrong predicate here. Callers therefore over-fetch and slice,
   * the same shape `MemberSuggestionsService.dropTakenDown` uses.
   */
  private async dropTakenDown<T extends { slug: string; userId: string }>(
    candidates: T[],
  ): Promise<T[]> {
    if (!candidates.length) {
      return candidates;
    }
    const states = await this.contentModeration.statesForAnyType(
      [ProfilesService.MEMBER_SUBJECT_TYPE],
      candidates.flatMap((candidate) => [candidate.slug, candidate.userId]),
    );
    if (!states.size) {
      return candidates;
    }
    return candidates.filter((candidate) => {
      const isTakenDown = [candidate.slug, candidate.userId].some(
        (subjectId) => {
          const state = states.get(subjectId);
          return !!state && (state.hidden || state.removed);
        },
      );
      return !isTakenDown;
    });
  }

  async updateMe(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<FullProfileResponse> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // `now`, `openTo`, `pronunciation`, `bioPt`, `notHereFor`, and `hiddenUntil`
    // are pulled out of the blanket assign because each needs an explicit
    // `undefined` check: `{ now: '' }` CLEARS the status and `{ openTo: [] }`
    // clears the chips, so neither empty value may be treated as "field
    // omitted". `pronunciation`/`bioPt`/`notHereFor` follow the same
    // empty-string-clears pattern as `now`. `hiddenUntil` additionally needs a
    // string → Date conversion the DTO's wire shape doesn't carry. `openTo` is
    // a full replace, not a merge.
    const {
      now,
      openTo,
      featuredCommunities,
      pronunciation,
      bioPt,
      notHereFor,
      hiddenUntil,
      ...rest
    } = dto;
    // Snapshot the avatar the profile pointed at BEFORE `Object.assign` overwrites
    // it, so a replaced/cleared upload can be deleted from the bucket afterwards.
    const previousAvatarUrl = profile.avatarUrl;
    // Resolve + validate the featured-community pins BEFORE any write, so an
    // ineligible slug rejects the WHOLE patch (400) rather than half-applying
    // it — the profile fields and the pins move together. `undefined` = the
    // client omitted the field (leave pins alone); `[]` = clear all pins.
    const featuredCommunityIds =
      featuredCommunities !== undefined
        ? await this.resolveFeaturedCommunityIds(userId, featuredCommunities)
        : undefined;
    Object.assign(profile, rest);
    if (openTo !== undefined) {
      profile.openTo = normalizeOpenTo(openTo);
    }
    // The outgoing status, archived below only if this patch actually changes
    // it. Built here (before profile.now is overwritten) and written inside
    // the same transaction as the profile save, so a failed save can never
    // leave a history row describing a status the member still carries.
    let archivedStatus: ProfileNowHistory | null = null;
    if (now !== undefined) {
      // An empty status normalises to NULL so a cleared Now reads back absent
      // rather than as an empty string.
      const nextNow = now.trim() || null;
      if (nextNow !== profile.now) {
        if (profile.now) {
          archivedStatus = this.nowHistory.create({
            userId,
            text: profile.now,
            // Pre-nowUpdatedAt statuses have no start date of their own, so
            // the profile's creation date is the only honest floor.
            startedAt: profile.nowUpdatedAt ?? profile.createdAt,
            endedAt: new Date(),
          });
        }
        // Only a real change moves this. Re-saving the same words must not
        // make the card claim the member updated it today.
        profile.nowUpdatedAt = new Date();
      }
      profile.now = nextNow;
    }
    if (pronunciation !== undefined) {
      profile.pronunciation = pronunciation.trim() || null;
    }
    if (bioPt !== undefined) {
      profile.bioPt = bioPt.trim() || null;
    }
    if (notHereFor !== undefined) {
      profile.notHereFor = notHereFor.trim() || null;
    }
    if (hiddenUntil !== undefined) {
      // `null` clears it early ("bring me back"); an ISO string is stored
      // verbatim as the timestamp past which the profile is hidden — see the
      // DTO's `hiddenUntil` comment. `@IsISO8601()` already validated the
      // string, so this Date conversion cannot fail.
      profile.hiddenUntil = hiddenUntil === null ? null : new Date(hiddenUntil);
    }
    // Keep `profession ⊆ discipline` coherent: a profession implies its
    // parent discipline, auto-added rather than rejected — see
    // reconcileDisciplineProfession. Unconditional for the same reason the
    // identity prune below is: idempotent when nothing changed, and a
    // conditional here is one refactor away from silently going stale.
    const reconciled = reconcileDisciplineProfession(
      profile.discipline ?? [],
      profile.profession ?? [],
    );
    profile.discipline = reconciled.disciplines;
    profile.profession = reconciled.professions;
    // RETRACTION. `rest` may have just replaced `identities`, and anything the
    // member dropped from it must stop being published in the SAME write —
    // otherwise un-declaring "Disabled or chronically ill" leaves them still
    // findable by it, which is the precise opposite of what retracting a
    // disclosure means, and the member has no way to see it lingering.
    //
    // Unconditional rather than gated on `dto.identities !== undefined`: it is
    // idempotent when nothing changed, and a conditional here is one refactor
    // away from being wrong. The DB CHECK would reject the row anyway — this is
    // what turns that 500 into correct behaviour.
    profile.discoverableIdentities = pruneDiscoverable(
      profile.discoverableIdentities ?? [],
      profile.identities ?? [],
    );
    if (archivedStatus) {
      await this.dataSource.transaction(async (manager) => {
        await manager.save(profile);
        await manager.save(archivedStatus);
      });
    } else {
      await this.profiles.save(profile);
    }
    if (featuredCommunityIds !== undefined) {
      await this.writeFeaturedCommunities(userId, featuredCommunityIds);
    }
    // Delete-on-replace: once the new avatar has committed, the object the old
    // `avatarUrl` referenced is orphaned (avatar keys are per-upload unique).
    // Only when it actually changed AND was one of our bucket objects — an
    // external Google/Unsplash URL is never ours to delete. Best-effort +
    // post-commit: a storage hiccup must never fail the profile update.
    if (previousAvatarUrl && previousAvatarUrl !== profile.avatarUrl) {
      try {
        await this.storage.deleteObjectByReference(previousAvatarUrl);
      } catch (error) {
        this.logger.warn(
          `Failed to delete replaced avatar object for member ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const vouchCount = await this.vouchService.getVouchCount(userId);
    return this.buildFullProfile(profile, vouchCount, userId);
  }

  /**
   * Map an ordered list of community slugs to their ids, validating that each
   * is eligible to feature: a NON-PRIVATE community the member is actually on
   * the roster of. Rejects duplicates and unknown/ineligible slugs with 400
   * (mirrors `replaceGroups`), so the client can't pin a community it doesn't
   * belong to or a private one. Order is preserved — it becomes `position`.
   */
  private async resolveFeaturedCommunityIds(
    userId: string,
    slugs: string[],
  ): Promise<string[]> {
    if (slugs.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    for (const slug of slugs) {
      if (seen.has(slug)) {
        throw new BadRequestException(`Duplicate community: ${slug}`);
      }
      seen.add(slug);
    }
    const rows = await this.communities
      .createQueryBuilder('c')
      .innerJoin(
        CommunityMember,
        'cm',
        'cm.community_id = c.id AND cm.user_id = :userId',
        { userId },
      )
      .where('c.slug IN (:...slugs)', { slugs })
      .andWhere('c.access_tier != :private', { private: AccessTier.Private })
      .select('c.id', 'id')
      .addSelect('c.slug', 'slug')
      .getRawMany<{ id: string; slug: string }>();
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    return slugs.map((slug) => {
      const id = idBySlug.get(slug);
      if (!id) {
        throw new BadRequestException(
          `Unknown or ineligible community: ${slug}`,
        );
      }
      return id;
    });
  }

  /** Full REPLACE of the member's featured-community pins, in the given order. */
  private async writeFeaturedCommunities(
    userId: string,
    communityIds: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ProfileFeaturedCommunity, { userId });
      if (communityIds.length === 0) {
        return;
      }
      const rows = communityIds.map((communityId, position) =>
        manager.create(ProfileFeaturedCommunity, {
          userId,
          communityId,
          position,
        }),
      );
      await manager.save(rows);
    });
  }

  // Set/rename the caller's mandatory global @username. The username IS the
  // profile `slug` and doubles as its entry in the ONE global handle namespace
  // (design plan PART C / UC4): rename in the `handles` registry and update
  // `profiles.slug` atomically. Collisions surface as 409; bad format/reserved
  // as 422.
  async updateUsername(
    userId: string,
    rawUsername: string,
  ): Promise<FullProfileResponse> {
    const username = normalizeHandle(rawUsername);
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // No-op if it already resolves to the current username.
    if (username === profile.slug) {
      const vouchCount = await this.vouchService.getVouchCount(userId);
      return this.buildFullProfile(profile, vouchCount, userId);
    }

    const fmt = handleFormatError(username);
    if (fmt === 'invalid') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_INVALID',
        message: 'That username contains characters that are not allowed.',
        reason: 'invalid',
      });
    }
    if (fmt === 'reserved') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_RESERVED',
        message: 'That username is reserved.',
        reason: 'reserved',
      });
    }

    const currentSlug = profile.slug;
    try {
      await this.dataSource.transaction(async (m) => {
        // Releases the old registry name and claims the new one; a taken name
        // throws ConflictException (→ 409), which bubbles unchanged.
        await this.handles.rename(m, currentSlug, username, {
          kind: 'profile',
          userId,
        });
        await m.update(Profile, { userId }, { slug: username });
      });
    } catch (err) {
      // The `profiles.slug` unique index can also lose the race.
      if (isUniqueViolation(err)) {
        throw new ConflictException('That username is already taken');
      }
      throw err;
    }

    const updated = await this.profiles.findOne({ where: { userId } });
    const vouchCount = await this.vouchService.getVouchCount(userId);
    return this.buildFullProfile(updated ?? profile, vouchCount, userId);
  }

  async replaceSocials(
    userId: string,
    items: SocialLinkDto[],
  ): Promise<SocialLinkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SocialLink, { userId });
      const rows = items.map((it, index) =>
        manager.create(SocialLink, {
          userId,
          platform: it.platform,
          urlOrHandle: it.urlOrHandle,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.socialLinks.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
      position: s.position,
    }));
  }

  async replaceWork(userId: string, items: WorkItemDto[]): Promise<WorkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WorkItem, { userId });
      const rows = items.map((it, index) =>
        manager.create(WorkItem, {
          userId,
          category: it.category,
          title: it.title,
          year: it.year,
          imageUrl: it.imageUrl ?? null,
          position: index,
          links: normalizeWorkLinks(it.links ?? []),
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.workItems.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((workItem) => ({
      category: workItem.category,
      title: workItem.title,
      year: workItem.year,
      imageUrl: toImageUrl(workItem.imageUrl),
      links: workItem.links,
      position: workItem.position,
    }));
  }

  async replaceSkills(
    userId: string,
    items: { name: string; meta: string }[],
  ): Promise<{ name: string; meta: string }[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Skill, { userId });
      const rows = items.map((it, index) =>
        manager.create(Skill, {
          userId,
          name: it.name,
          meta: it.meta,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.skills.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({ name: s.name, meta: s.meta }));
  }

  async replaceBoard(
    userId: string,
    items: {
      kind: BoardPost['kind'];
      title: string;
      slug: string;
      tags?: string[];
    }[],
  ): Promise<BoardView[]> {
    // board_posts has a unique (userId, slug); reject in-payload duplicates up
    // front so the whole replace fails cleanly rather than tripping the DB
    // constraint mid-transaction.
    const seenSlugs = new Set<string>();
    for (const item of items) {
      if (seenSlugs.has(item.slug)) {
        throw new BadRequestException(`Duplicate board slug: ${item.slug}`);
      }
      seenSlugs.add(item.slug);
    }
    await this.dataSource.transaction(async (manager) => {
      // This endpoint replaces the caller's whole ORDERED LIST on every save
      // (title/slug/position edits, reordering, add/remove) — it does not
      // reset each item's closed/found lifecycle, and it does not reset each
      // item's IDENTITY either. `board_post_responses` hangs off
      // `board_posts.id` with ON DELETE CASCADE, so deleting a row that is
      // about to be recreated would silently destroy every offer to help and
      // every board-scoped hello that post has received. A surviving slug is
      // therefore UPDATED IN PLACE, keeping its `id`; only slugs absent from
      // the payload are deleted, and only genuinely new slugs are inserted.
      //
      // The same reasoning covers the field values a survivor carries
      // forward untouched: status/closedAt/closedNote/expiresAt/renewCount/
      // renewedAt/createdAt. `createdAt` matters beyond bookkeeping — the FE
      // renders it as relative-age copy ("Asked 12 days ago"), so resetting
      // it on an unrelated list edit would misdate every existing item shown
      // to visitors. `renewCount` matters because BOARD_RENEW_LIMIT is
      // counted from it: resetting it here while keeping the already
      // pushed-out `expiresAt` would let a member renew forever by saving
      // the editor between runs.
      const existing = await manager.find(BoardPost, { where: { userId } });
      const existingBySlug = new Map(
        existing.map((boardPost) => [boardPost.slug, boardPost]),
      );

      // Ordering inside the transaction: the deletes run FIRST, before any
      // insert or update, so a slug freed by this same save is already gone
      // from `UQ_board_posts_user_slug` by the time anything else claims it.
      // Beyond that the unique index cannot be transiently violated at all,
      // because `slug` is the match key: a surviving row keeps the slug it
      // already had (only kind/title/position/tags are written), so no
      // update ever moves a slug from one row to another. A pure reorder
      // touches `position`, which carries no unique constraint, and deletes
      // nothing.
      const incomingSlugs = new Set(items.map((item) => item.slug));
      const removedIds = existing
        .filter((boardPost) => !incomingSlugs.has(boardPost.slug))
        .map((boardPost) => boardPost.id);
      if (removedIds.length) {
        await manager.delete(BoardPost, { userId, id: In(removedIds) });
      }

      const now = Date.now();
      const rows = items.map((item, index) => {
        const previous = existingBySlug.get(item.slug);
        if (previous) {
          // In place, on the loaded entity: `previous.id` is untouched, so
          // `manager.save` issues an UPDATE and the response rows keyed to
          // that id survive. Everything not assigned here is preserved by
          // simply not being written.
          previous.kind = item.kind;
          previous.title = item.title;
          previous.position = index;
          previous.tags = item.tags ?? [];
          return previous;
        }
        return manager.create(BoardPost, {
          userId,
          kind: item.kind,
          title: item.title,
          slug: item.slug,
          position: index,
          status: BoardPostStatus.Open,
          closedNote: null,
          closedAt: null,
          expiresAt: new Date(
            now + BOARD_ITEM_LIFESPAN_DAYS[item.kind] * DAY_MS,
          ),
          renewCount: 0,
          renewedAt: null,
          // Left undefined for a genuinely new slug so `@CreateDateColumn`
          // populates it on insert as usual.
          createdAt: undefined,
          tags: item.tags ?? [],
        });
      });
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.boardPosts.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    // `.map(toBoardView)` would hand toBoardView the array index as its
    // second (responses) argument — see the same note in profile-response.ts.
    return saved.map((b) => toBoardView(b));
  }

  async closeBoardItem(
    userId: string,
    slug: string,
    note: string | undefined,
  ): Promise<BoardView> {
    const boardPost = await this.boardPosts.findOne({
      where: { userId, slug },
    });
    if (!boardPost) {
      throw new NotFoundException('No board item with that slug.');
    }
    boardPost.status = BoardPostStatus.Closed;
    boardPost.closedAt = new Date();
    boardPost.closedNote = note ?? null;
    await this.boardPosts.save(boardPost);
    return toBoardView(boardPost);
  }

  /**
   * Push a board post's expiry out by its kind's full window, from now.
   *
   * One endpoint serves two labels in the UI: "Renew 30 days" while the post
   * is still alive, and "Repost" once it has expired. Both land here, and both
   * measure the new window from now, so a post that lapsed three weeks ago
   * gets a full fresh run rather than a backdated one.
   *
   * A closed post is reopened through the board editor, so renewing one is a
   * conflict.
   */
  async renewBoardItem(userId: string, slug: string): Promise<BoardView> {
    const boardPost = await this.boardPosts.findOne({
      where: { userId, slug },
    });
    if (!boardPost) {
      throw new NotFoundException('No board item with that slug.');
    }
    if (boardPost.status === BoardPostStatus.Closed) {
      throw new ConflictException(
        'This post is closed. Reopen it from the board editor.',
      );
    }
    if (boardPost.renewCount >= BOARD_RENEW_LIMIT) {
      throw new ConflictException(
        'This post has been renewed as many times as it can be. Write a fresh one.',
      );
    }
    const now = Date.now();
    boardPost.expiresAt = new Date(
      now + BOARD_ITEM_LIFESPAN_DAYS[boardPost.kind] * DAY_MS,
    );
    boardPost.renewedAt = new Date(now);
    boardPost.renewCount += 1;
    await this.boardPosts.save(boardPost);
    return toBoardView(boardPost);
  }

  /**
   * Record one member's response to another's board post: an offer to help, or
   * a board-scoped hello.
   *
   * The unique index on (postId, responderId, kind) makes a repeat response a
   * conflict rather than a second row, so counts stay honest. Visibility is the
   * profile's own gate, reused here: a member who only shows their profile to
   * their network only takes board responses from their network.
   */
  async respondToBoardItem(
    viewerId: string,
    ownerSlug: string,
    postSlug: string,
    kind: BoardResponseKind,
    note?: string,
  ): Promise<{ kind: string; createdAt: string }> {
    // Reuses the single-profile read's own two-part visibility gate rather
    // than a second rule: `findBySlugOrThrow` covers the "does the viewer get
    // to know this member exists at all?" gates (block, hidden-from,
    // self-hide, moderator takedown — all the same indistinguishable-from-404
    // as `getBySlug`, plus PRD-204 moved-slug forwarding), and `canViewFull`
    // below covers the owner/open/network/private visibility TIER on top of
    // that. Calling `this.profiles.findOne` directly here would skip the
    // block/hidden-from/takedown gates entirely.
    const owner = await this.findBySlugOrThrow(ownerSlug, viewerId);
    if (owner.userId === viewerId) {
      throw new ForbiddenException('This is your own board post.');
    }
    if (!(await this.canViewFull(owner, viewerId))) {
      throw new ForbiddenException('This board is not open to you.');
    }
    const boardPost = await this.boardPosts.findOne({
      where: { userId: owner.userId, slug: postSlug },
    });
    // A closed or lapsed post is gone as far as a responder is concerned, so it
    // reads as absent rather than as a separate refusal.
    if (
      !boardPost ||
      boardPost.status === BoardPostStatus.Closed ||
      boardPost.expiresAt.getTime() <= Date.now()
    ) {
      throw new NotFoundException('No open board item with that slug.');
    }
    const existing = await this.boardResponses.findOne({
      where: { postId: boardPost.id, responderId: viewerId, kind },
    });
    if (existing) {
      throw new ConflictException('You have already responded to this post.');
    }
    const row = this.boardResponses.create({
      postId: boardPost.id,
      responderId: viewerId,
      kind,
      note: note?.trim() || null,
    });
    try {
      await this.boardResponses.save(row);
    } catch (err) {
      // The pre-check above has a TOCTOU gap: two concurrent identical
      // requests can both pass it, and the loser trips the unique index on
      // (postId, responderId, kind) here instead. Same recovery as
      // `updateUsername`'s handle-collision race.
      if (
        isUniqueViolation(err, 'UQ_board_post_responses_post_responder_kind')
      ) {
        throw new ConflictException('You have already responded to this post.');
      }
      throw err;
    }
    // Task 3 does not wire an owner notification here: ProfilesService injects
    // no notifications dependency, and adding one is out of scope for this
    // task. See the Task 3 report — the owner is not yet notified of a help
    // response; that needs its own task.
    return { kind: row.kind, createdAt: row.createdAt.toISOString() };
  }

  /**
   * The owner's board figures: the hellos/replies funnel over the trailing
   * window, and the reciprocal matches for each of their live posts.
   *
   * Matching is deliberately literal. A post matches another member's post when
   * the kinds are opposite and they share at least one tag from the curated
   * vocabulary, so a pill only ever claims something both members typed. The
   * whole board resolves in ONE query via a windowed derived-table join (see
   * the `ROW_NUMBER()` inside the `ranked` subquery below); a per-post query
   * here would be an N+1 on the owner's own profile load.
   */
  async getBoardInsights(userId: string): Promise<BoardInsightsView> {
    const windowStart = new Date(
      Date.now() - BOARD_INSIGHTS_WINDOW_DAYS * DAY_MS,
    );
    const own = await this.boardPosts.find({ where: { userId } });
    const ownIds = own.map((post) => post.id);

    const [hellos, replies] = ownIds.length
      ? await Promise.all([
          this.boardResponses.count({
            where: {
              postId: In(ownIds),
              kind: BoardResponseKind.Hello,
              createdAt: MoreThanOrEqual(windowStart),
            },
          }),
          this.boardResponses.count({
            where: {
              postId: In(ownIds),
              kind: BoardResponseKind.Help,
              createdAt: MoreThanOrEqual(windowStart),
            },
          }),
        ])
      : [0, 0];

    // `own` is filtered against the Node clock (`Date.now()`/`new Date()`
    // here) while `other`'s expiry check below runs Postgres's own `now()`
    // inside the query. The two clocks can drift by a few ms; harmless at
    // this day-scale expiry window, so left as two clocks rather than forcing
    // one query to read the other's snapshot.
    const now = new Date();
    const matchable = own.filter(
      (post) =>
        post.status === BoardPostStatus.Open &&
        post.expiresAt > now &&
        post.tags.length > 0,
    );

    const matches: Record<string, BoardMatchView[]> = {};
    if (matchable.length) {
      const ids = matchable.map((post) => post.id);
      // Capped IN SQL via a window function, not a plain `.limit()` —
      // `.limit()` would cap the WHOLE result set, letting one post's
      // matches starve another's once one owner post has many candidates.
      // `ROW_NUMBER() OVER (PARTITION BY own.id ORDER BY …)` ranks each
      // owner post's candidates independently; the outer `ranked` query below
      // keeps only rows `<= BOARD_MATCHES_PER_POST * 3` per partition, so the
      // cap is enforced in Postgres and rows other than a small multiple of
      // 3-per-post never leave it, not after the full cross product is on
      // the wire.
      const rows = await this.dataSource
        .createQueryBuilder()
        .select([
          'ranked.owner_post_slug AS owner_post_slug',
          'ranked.post_slug AS post_slug',
          'ranked.kind AS kind',
          'ranked.slug AS slug',
          'ranked.first AS first',
          'ranked.matched_user_id AS matched_user_id',
        ])
        .from((rankedQb) => {
          const inner = rankedQb
            .select([
              'own.slug AS owner_post_slug',
              'other.post_slug AS post_slug',
              'other.kind AS kind',
              'profile.slug AS slug',
              'profile.first_name AS first',
              'other.user_id AS matched_user_id',
              // Tiebroken by the matched post's own slug: posts written in
              // the same `replaceBoard` transaction share `created_at` down
              // to the millisecond, and without a tiebreaker which 3 survive
              // the cap below would be nondeterministic between requests.
              'ROW_NUMBER() OVER (PARTITION BY own.id ORDER BY other.created_at DESC, other.post_slug ASC) AS rn',
            ])
            .from(BoardPost, 'own')
            .innerJoin(
              (sub) =>
                sub
                  .select([
                    'other.slug AS post_slug',
                    'other.kind AS kind',
                    'other.user_id AS user_id',
                    'other.tags AS tags',
                    'other.created_at AS created_at',
                  ])
                  .from(BoardPost, 'other')
                  .where('other.status = :open', { open: BoardPostStatus.Open })
                  .andWhere('other.expires_at > now()')
                  .andWhere('other.user_id != :userId', { userId }),
              'other',
              'other.tags && own.tags AND other.kind != own.kind',
            )
            .innerJoin(Profile, 'profile', 'profile.user_id = other.user_id')
            // The matched member must be an ACTIVE user — deactivated
            // (covers both "pause my account" and the 30-day erasure grace
            // period), suspended, and pending members must never surface by
            // name. Same join `directoryBaseQuery` uses via `p.user`.
            .innerJoin(
              'profile.user',
              'profileUser',
              'profileUser.status = :active',
              { active: UserStatus.Active },
            )
            .where('own.id IN (:...ids)', { ids });
          // The SAME single spelling of "may this viewer see this member at
          // all?" every other read path uses — block either way, hidden-from,
          // and self-hide — with `userId` (the insights OWNER) as the viewer.
          // A member who blocked the owner, or whom the owner blocked, or who
          // hid their profile from the owner, or is self-hidden, must not
          // surface as a match by name. Called with `'profile'` because this
          // query's `Profile` join is aliased `profile`, not the directory's
          // `p`.
          this.applyMemberVisibilityGates(inner, userId, 'profile');
          return inner;
        }, 'ranked')
        // Read a wider pool than we render: the fourth gate (moderator
        // takedown) has no in-query form here, so it drops rows AFTER the
        // fetch (see `dropTakenDown` below), and capping the SQL at exactly
        // `BOARD_MATCHES_PER_POST` would leave a short (or, in the
        // degenerate case, missing) bucket whenever one of a post's top 3
        // matches had been taken down — same reasoning as `RELATED_READ_LIMIT`
        // above. The JS trim after `dropTakenDown`, below, cuts each bucket
        // back down to `BOARD_MATCHES_PER_POST` once takedowns are removed.
        .where('ranked.rn <= :cap', { cap: BOARD_MATCHES_PER_POST * 3 })
        .orderBy('ranked.rn', 'ASC')
        .getRawMany<{
          owner_post_slug: string;
          post_slug: string;
          kind: 'looking' | 'offering';
          slug: string;
          first: string;
          matched_user_id: string;
        }>();

      // Moderator takedown is the fourth gate and has no single-column
      // in-query form (see `dropTakenDown`), so it runs post-query, same as
      // everywhere else in this file — BEFORE the per-post trim below, so a
      // taken-down member never occupies one of the BOARD_MATCHES_PER_POST
      // slots a visible member could have filled instead.
      const visibleRows = await this.dropTakenDown(
        rows.map((row) => ({ ...row, userId: row.matched_user_id })),
      );

      for (const row of visibleRows) {
        const bucket = matches[row.owner_post_slug] ?? [];
        // The real trim: the SQL cap above over-fetches to
        // `BOARD_MATCHES_PER_POST * 3` per post specifically so takedowns can
        // be removed first without shorting a bucket, so this cuts each one
        // back down to the real, displayed cap.
        if (bucket.length >= BOARD_MATCHES_PER_POST) continue;
        bucket.push({
          slug: row.slug,
          first: row.first,
          kind: row.kind,
          postSlug: row.post_slug,
        });
        matches[row.owner_post_slug] = bucket;
      }
    }

    return {
      hellos,
      replies,
      windowDays: BOARD_INSIGHTS_WINDOW_DAYS,
      matches,
    };
  }

  async replaceShapings(
    userId: string,
    items: { kind: Shaping['kind']; title: string; note: string }[],
  ): Promise<{ kind: string; title: string; note: string }[]> {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.kind)) {
        throw new BadRequestException(`Duplicate shaping kind: ${it.kind}`);
      }
      seen.add(it.kind);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Shaping, { userId });
      const rows = items.map((it) =>
        manager.create(Shaping, {
          userId,
          kind: it.kind,
          title: it.title,
          note: it.note,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.shapings.find({ where: { userId } });
    return sortShapings(saved).map((s) => ({
      kind: s.kind,
      title: s.title,
      note: s.note,
    }));
  }

  async replaceGroups(
    userId: string,
    items: { groupSlug: string; role: string }[],
  ): Promise<GroupView[]> {
    const slugs = items.map((i) => i.groupSlug);
    const found = slugs.length
      ? await this.groups.find({ where: { slug: In(slugs) } })
      : [];
    const bySlug = new Map(found.map((g) => [g.slug, g]));
    for (const it of items) {
      if (!bySlug.has(it.groupSlug)) {
        throw new BadRequestException(`Unknown group: ${it.groupSlug}`);
      }
    }
    const seenSlugs = new Set<string>();
    for (const it of items) {
      if (seenSlugs.has(it.groupSlug)) {
        throw new BadRequestException(`Duplicate group: ${it.groupSlug}`);
      }
      seenSlugs.add(it.groupSlug);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(GroupMembership, { userId });
      const rows = items.map((it) =>
        manager.create(GroupMembership, {
          userId,
          groupId: bySlug.get(it.groupSlug)!.id,
          role: it.role,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    return this.loadGroups(userId);
  }

  /**
   * The in-query half of "may this viewer see this member at all?", applied to
   * any query builder carrying a `Profile` join, whatever it is aliased. ONE
   * spelling of the rule, shared by the directory (`directoryBaseQuery`), the
   * profile page's related list (`loadRelated`), and the board reads
   * (`loadBoardResponses`, `getBoardInsights`) — because a second spelling is
   * how a surface quietly drifts out of sync with every other read path.
   *
   * `alias` defaults to `'p'` (the directory/related-list alias); board reads
   * join `Profile` as `'profile'` and pass that explicitly. The generic `E`
   * (not pinned to `Profile`) is what lets this be called on a query builder
   * whose MAIN entity is `BoardPost`/`BoardPostResponse` rather than
   * `Profile` itself — the four gates below only ever touch the named
   * `alias`'s columns, never the query's root entity.
   *
   * Three of the four member gates live here. The fourth, moderator takedown,
   * is keyed by slug OR userId in `content_moderation` and counts a removal as
   * well as a hide, so it has no single-column `NOT EXISTS` form: callers apply
   * it separately (`assertNotTakenDown` for a single profile, `dropTakenDown`
   * over a fetched pool).
   */
  private applyMemberVisibilityGates<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    viewerUserId: string,
    alias = 'p',
  ): void {
    const userIdColumn = `"${alias}"."user_id"`;
    // Blocked-either-way members (in either direction) never surface (spec §2).
    // `user_id` is snake_case per SnakeNamingStrategy, matching every alias
    // this is called with.
    this.blockFilter.excludeBlocked(qb, viewerUserId, userIdColumn);
    // Hidden-from (member profile v2 Task 5): a candidate who hid THEIR
    // profile from this viewer never surfaces either, same as a block —
    // directional, unlike `excludeBlocked` above.
    this.hiddenFrom.excludeHiddenFrom(qb, viewerUserId, userIdColumn);
    // Self-hide (member profile v2 Task 6, "Hide me for 24 hours"): a member
    // with a live `hiddenUntil` excludes themself from EVERY viewer's
    // results — unlike the block/hidden-from gates above, this is not
    // viewer-relative, so it applies unconditionally rather than being
    // scoped to `viewerUserId`. They can still fetch their own profile
    // directly (`getMine`/`getBySlug` own the owner exception via
    // `findBySlugOrThrow`).
    qb.andWhere(
      `("${alias}"."hidden_until" IS NULL OR "${alias}"."hidden_until" <= now())`,
    );
  }

  /**
   * A fresh directory query builder carrying the viewer's visibility gates and
   * every facet predicate — the single definition of "who is in this
   * directory". `searchMembers` orders and pages one of these; each facet count
   * query gets its own with that group's predicate skipped.
   *
   * Returns a NEW builder every call, because both callers mutate what they are
   * handed (select lists, joins, ordering) and a shared one would leak a count
   * query's aggregate select into the page query.
   */
  private directoryBaseQuery(
    q: ListMembersQuery,
    viewerUserId: string,
    skip?: DirectoryFacetGroup,
  ): SelectQueryBuilder<Profile> {
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      });
    this.applyMemberVisibilityGates(qb, viewerUserId);
    applyDirectoryFilters(qb, q, skip);
    return qb;
  }

  async searchMembers(
    q: ListMembersQuery,
    viewerUserId: string,
    // Global search paginates by a flat offset, not by the directory's fixed
    // 20-per-page window (SOC-08): the search page's "load more" on the Members
    // tab asks for rows 50..99 of one type, which `q.page` cannot express. When
    // absent, paging is exactly what it was.
    pagination?: { offset: number; limit: number },
  ): Promise<{
    items: MemberCard[];
    total: number;
    page: number;
    pageSize: number;
    /**
     * Per-option availability counts for the directory sidebar's filter groups.
     *
     * Absent for the offset-paginated caller (global search), which renders a
     * plain results list with no filter sidebar: computing five aggregates for
     * a surface that cannot show them is wasted work, and returning them anyway
     * would invite a future caller to display numbers describing a filter UI
     * that isn't on screen.
     */
    facets?: DirectoryFacetCounts;
  }> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const qb = this.directoryBaseQuery(q, viewerUserId);

    // The relevance ordering below needs the same folded search expressions the
    // search PREDICATE uses (now in `applyDirectoryFilters`). They are pure
    // string builders over the alias, so rebuilding them here costs nothing and
    // keeps the shared filter function free of any ordering concern.
    const memberSearchVector = weightedSearchVector('p', PROFILE_SEARCH_FIELDS);
    const memberSearchHaystack = foldedHaystack('p', PROFILE_SEARCH_COLUMNS);
    const memberSearchTsQuery = foldedSearchQuery('memberSearchTerm');
    const hasSearchTerm = Boolean(q.query);

    // Ordering. Applied here rather than on the client because the directory is
    // paginated — the client only ever holds one page and cannot sort across the
    // whole set. Every branch ends with a `p.slug` tiebreaker so pages stay
    // deterministic when the primary key ties (otherwise the same member could
    // straddle a page boundary).
    switch (q.sort) {
      case MemberSort.AToZ:
        qb.orderBy('p.firstName', 'ASC').addOrderBy('p.lastName', 'ASC');
        break;
      case MemberSort.MostVouched:
        // Reads the denormalized `profiles.vouch_count` column instead of a
        // correlated `COUNT(*) FROM vouches` subquery evaluated per candidate
        // row — see AddProfileVouchCount1787600100000. `VouchService` keeps
        // this column in sync on every vouch create/reactivate/withdraw.
        // Ties fall back to name order.
        //
        // This is the ONLY place that still reads the column, and it reads it
        // knowingly. The column is block-blind (see `Profile.vouchCount`),
        // so a candidate who has blocked one of their own vouchers ranks one
        // place higher here than the number printed on their card. Going
        // block-aware would mean putting the pair-correlated `NOT EXISTS`
        // from `VouchService.getVouchCounts` into a correlated subquery in
        // the ORDER BY, re-evaluated per candidate row before the LIMIT,
        // which is exactly the O(members) count-per-search that
        // AddProfileVouchCount1787600100000 was written to remove. A ranking
        // nudge of one place is not worth reopening that. The NUMBER each
        // card prints is unaffected: `searchMembers` maps its cards from the
        // batched, block-aware `VouchService.getVouchCounts` below.
        qb.orderBy('p.vouchCount', 'DESC').addOrderBy('p.firstName', 'ASC');
        break;
      case MemberSort.ClosestMutuals: {
        // Rank by how many of the viewer's own accepted connections each
        // candidate is also connected to. With no connections of your own,
        // nobody shares any — the ranking would be a uniform zero, so fall back
        // to newest-joined rather than returning an arbitrary order.
        const viewerConnectionIds =
          await this.connectionsService.getAcceptedConnectionUserIds(
            viewerUserId,
          );
        if (viewerConnectionIds.length) {
          // Build a named placeholder per id: raw ORDER BY fragments don't get
          // TypeORM's `:...list` array expansion, so expand it ourselves.
          const placeholders = viewerConnectionIds
            .map((_, index) => `:mutual${index}`)
            .join(', ');
          const parameters: Record<string, string> = {
            mutualAccepted: ConnectionStatus.Accepted,
          };
          viewerConnectionIds.forEach((id, index) => {
            parameters[`mutual${index}`] = id;
          });
          // Rank via an aliased scalar subquery rather than a raw ORDER BY
          // expression: this query paginates over a join, so TypeORM rewrites it
          // into a DISTINCT-id subquery and re-parses each ORDER BY term as
          // `alias.column`. A raw subquery's dots (mc.status, p.user_id) get
          // mistaken for an alias and it throws "alias was not found". Selecting
          // the count under a dot-free alias and ordering by that alias avoids
          // the parser entirely; the count query resets its select, so
          // getManyAndCount stays unaffected.
          qb.addSelect(
            `(SELECT COUNT(*) FROM connections mc
                WHERE mc.status = :mutualAccepted
                  AND ((mc.requester_id = p.user_id AND mc.addressee_id IN (${placeholders}))
                    OR (mc.addressee_id = p.user_id AND mc.requester_id IN (${placeholders}))))`,
            'mutual_connection_count',
          )
            .setParameters(parameters)
            .orderBy('mutual_connection_count', 'DESC')
            .addOrderBy('p.joinedAt', 'DESC');
        } else {
          qb.orderBy('p.joinedAt', 'DESC');
        }
        break;
      }
      case MemberSort.RecentlyActive:
        // Ordered through an ALIASED SCALAR SUBQUERY, not a join, for the same
        // reason `ClosestMutuals` above uses one: this query paginates over a
        // join, so TypeORM rewrites it into a DISTINCT-id subquery and re-parses
        // every ORDER BY term as `alias.column`. Ordering by a genuinely joined
        // column here would be the broken `.skip()`/`.take()` + join + joined
        // ORDER BY combination, and would have forced this whole method onto
        // `.offset()`/`.limit()`, silently changing how the other three sorts
        // paginate. A dot-free alias sidesteps the parser entirely and leaves
        // them untouched.
        //
        // The subquery reads `is_hidden = false`, so a member who opted out
        // carries NO ordering value at all rather than a demoted one. They keep
        // their place in the directory, they simply stop being ranked by this
        // signal, which is the whole point of the opt-out.
        //
        // NULLS LAST covers the two honest unknowns together: opted out, and
        // nothing recorded yet. Neither is "dormant", and neither may be sorted
        // as though it were. The stored value is a month, so most of a month's
        // members tie here and fall through to the `p.slug` tiebreaker below:
        // this ordering cannot be read backwards as a precise last-seen rank.
        qb.addSelect(
          `(SELECT la.last_active_month FROM profile_last_active la
              WHERE la.user_id = p.user_id AND la.is_hidden = false)`,
          'last_active_month_sort',
        )
          .orderBy('last_active_month_sort', 'DESC', 'NULLS LAST')
          .addOrderBy('p.joinedAt', 'DESC');
        break;
      case MemberSort.RecentlyJoined:
      default:
        // With a search term and no sort chosen, order by relevance (SOC-08).
        // Every explicit sort above is left exactly as it was: a member who
        // picked "A to Z" asked for A to Z, term or no term. Selected under a
        // DOT-FREE alias for the same reason `ClosestMutuals` and
        // `RecentlyActive` are: this query paginates over a join, so TypeORM
        // rewrites it into a DISTINCT-id subquery and re-parses each ORDER BY
        // term as `alias.column`.
        if (hasSearchTerm) {
          qb.addSelect(
            searchRankExpression(
              memberSearchVector,
              memberSearchTsQuery,
              memberSearchHaystack,
              foldedSearchTerm('memberSearchTerm'),
            ),
            'member_search_rank',
          )
            .orderBy('member_search_rank', 'DESC')
            .addOrderBy('p.joinedAt', 'DESC');
        } else {
          qb.orderBy('p.joinedAt', 'DESC');
        }
        break;
    }

    qb.addOrderBy('p.slug', 'ASC')
      .skip(pagination ? pagination.offset : (page - 1) * PAGE_SIZE)
      .take(pagination ? pagination.limit : PAGE_SIZE);

    // The page and the six facet aggregates are independent reads of the same
    // committed snapshot, so they go out together rather than in series.
    const [[rows, total], facets] = await Promise.all([
      qb.getManyAndCount(),
      pagination
        ? Promise.resolve(undefined)
        : countDirectoryFacets((skip) =>
            this.directoryBaseQuery(q, viewerUserId, skip),
          ),
    ]);
    const memberIds = rows.map((r) => r.userId);
    const counts = await this.vouchService.getVouchCounts(memberIds);
    // ONE batched lookup for the whole page's activity bands, never one per
    // card. A member with no row is simply absent from the map, and
    // `visibleBand` renders that as no band rather than as "not active
    // recently". See last-active.ts on why the two must not be confused.
    const activitySignals = await this.lastActive.getSignals(memberIds);
    return {
      // Directory search never excludes the viewer's own profile from their
      // own results (unlike `excludeBlocked` above) — the viewer's own name/
      // slug can legitimately match their own query, or they can simply
      // appear on a page in the unfiltered listing. When that happens, they
      // must still see their own real photo/hood, hence `isOwner` here rather
      // than a hardcoded `false`. See `toMemberCard`/`gateAvatarUrl`.
      items: rows.map((r) => {
        const isOwner = r.userId === viewerUserId;
        return toMemberCard(
          r,
          counts.get(r.userId) ?? 0,
          isOwner,
          visibleBand(activitySignals.get(r.userId), isOwner),
        );
      }),
      total,
      page,
      pageSize: pagination ? pagination.limit : PAGE_SIZE,
      facets,
    };
  }
}

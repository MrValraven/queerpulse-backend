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
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { ConnectionsService } from '../connections/connections.service';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MediaCropService } from '../media-crops/media-crops.service';
import { knownCommunityTags } from './community-tags';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { VouchService } from '../vouch/vouch.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityCardDTO,
  CommunityDetailDTO,
  CommunityJoinRequestDTO,
  CommunityStats,
  JoinResultDTO,
  MemberRoleDTO,
  MyCommunityDTO,
  RosterEntryDTO,
  toCommunityCard,
  toCommunityDetail,
  toJoinRequestDTO,
  toRosterEntry,
} from './community-response';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import { CommunityTagRequest } from './entities/community-tag-request.entity';
import { CreateCommunityTagRequestDto } from './dto/create-community-tag-request.dto';
import {
  CommunityTagRequestResponseDTO,
  toCommunityTagRequestResponse,
} from './community-tag-request-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPost } from './entities/community-post.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

// Comma-separated query param -> trimmed, non-empty values. Mirrors
// `ProfilesService`'s file-local helper of the same name/shape.
function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_STATS: CommunityStats = {
  memberCount: 0,
  activeThisWeek: 0,
  postsThisWeek: 0,
};

// `suggestedCommunities` caps its result the same way `relatedCommunities`
// caps at 4 — a short shelf, not a browse list.
const SUGGESTED_COMMUNITIES_LIMIT = 6;

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on
// the QueryFailedError or on the wrapped driverError depending on the path.
// Mirrors `EventsService`'s identical helper (file-local there too, not
// shared/exported — kept consistent with that precedent).
export interface CreateCommunityInput {
  name: string;
  purpose: string;
  type: CommunityType;
  whoFor: string;
  accessTier: AccessTier;
  rosterVisible: boolean;
  features: string[];
  rules: string[];
  tagline: string;
  tags?: string[]; // curated ids from COMMUNITY_TAGS; defaults to [] when omitted
  coverImageUrl?: string | null; // storage key / https URL / '' to clear
  handle: string; // desired slug
  stewards?: string[]; // member slugs -> seeded as 'mod'
  invites?: string[]; // member slugs -> sent a CommunityInviteReceived notification, never force-added to the roster (see `seedExtraRoster`)
}

// `handle` only ever applies at creation time (spec: "handle ignored on
// patch"). `stewards`/`invites` are creation-time roster seeding, not a
// patchable field either — there's no PATCH-time re-seeding semantics in the
// spec's endpoint table, so `update()` simply never reads them even though
// the type carries them (mirrors `PartialType(CreateCommunityDto)`).
export type UpdateCommunityInput = Partial<
  Omit<CreateCommunityInput, 'handle'>
>;

export type CommunityListFilter = 'discover' | 'mine';

// 'active' (most members / most recent post activity) was deliberately left
// out: both would need an aggregate join/subquery across `community_members`
// or `community_posts` evaluated for the *whole* filtered set before
// pagination — unlike `statsForMany`, which only ever batches stats for the
// current page's rows after the fact — and neither table carries an index
// that makes that aggregate cheap. Doing it properly would mean a
// denormalized, trigger-maintained counter column (its own migration +
// sync mechanism), which is out of scope here.
export type CommunityListSort = 'newest' | 'name';

export interface CommunityListQuery {
  filter?: CommunityListFilter;
  type?: CommunityType;
  access?: AccessTier;
  page?: number;
  // Free-text search over name/tagline/purpose, ANDed with `type`/`access`/
  // `filter` rather than replacing them — mirrors `searchByText`'s ILIKE
  // clause, applied inline so it composes with the rest of `list()`'s query
  // instead of duplicating the pagination/stats/role hydration path.
  q?: string;
  // Defaults to 'newest' (the pre-existing, unparametrized behavior) when
  // omitted — see `list()`'s `ORDER BY`.
  sort?: CommunityListSort;
  // Comma-separated curated tag ids, e.g. ?tags=trans-nonbinary,book-club.
  // Filters `communities.tags` via array overlap (`&&`), same shape as
  // `ProfilesService.searchMembers`'s `?tags=` filter over `profiles.tags`.
  // Unknown ids are dropped before the query runs; see COMMUNITY_TAGS.
  tags?: string;
}

export interface JoinCommunityInput {
  note?: string;
}

export type JoinRequestAction = 'approve' | 'decline';

/** The only roles `setMemberRole` can assign — `owner` is not grantable here
 * (see `UpdateMemberRoleDto`). */
export type AssignableRole = RosterRole.Member | RosterRole.Mod;

@Injectable()
export class CommunitiesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    @InjectRepository(CommunityTagRequest)
    private readonly tagRequests: Repository<CommunityTagRequest>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // For the house-account guardrail on `transferOwnership` (a `User.isSystem`
    // account can never be handed a community). The repo is available via
    // `UsersModule`'s exported `TypeOrmModule` (no extra `forFeature` needed).
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly contentModeration: ContentModerationService,
    private readonly notifications: NotificationsService,
    // Second-vouch join gating reads the platform vouch graph to check whether a
    // current community member has vouched for an applicant.
    private readonly vouch: VouchService,
    // `suggestedCommunities`'s social-graph signal: the viewer's accepted
    // connections. See that method's doc comment for why connections (not
    // tags) is the real signal here.
    private readonly connectionsService: ConnectionsService,
    // Batched crop lookup (`MediaCropService.getMany`) for `coverImageUrl`'s
    // sibling `coverCrop`.
    private readonly mediaCropService: MediaCropService,
    // Governance audit trail (`community_governance_log`) — every roster/
    // lifecycle action this service performs (role change, removal,
    // ownership transfer, archive, freeze/unfreeze) writes one entry.
    private readonly governanceLog: CommunityGovernanceLogService,
  ) {}

  private readonly logger = new Logger(CommunitiesService.name);

  // A community is taken down under the `community` taxonomy code, keyed by its
  // slug (matching the report `subjectId`).
  private static readonly SUBJECT_TYPE = 'community';

  private static isStaffRole(role: RosterRole | null): boolean {
    return role === RosterRole.Owner || role === RosterRole.Mod;
  }

  // Excludes moderator-taken-down communities from a browse/search query, in
  // the query itself so the paginated `total` stays consistent with the rows
  // returned. A community's own owner/mod (`m.role`) still sees it — the
  // moderated-away card is withheld from members and non-members only. Assumes
  // the querybuilder has joined `CommunityMember` as `m` on the viewer (both
  // `list` and `searchByText` do).
  private excludeModeratedCommunities(qb: SelectQueryBuilder<Community>): void {
    qb.andWhere(
      `(NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :communitySubjectType
            AND "cm"."subject_id" = c.slug
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        ) OR m.role IN (:...communityStaffRoles))`,
      {
        communitySubjectType: CommunitiesService.SUBJECT_TYPE,
        communityStaffRoles: [RosterRole.Owner, RosterRole.Mod],
      },
    );
  }

  async create(
    ownerId: string,
    dto: CreateCommunityInput,
  ): Promise<CommunityDetailDTO> {
    const { community: saved, invitedUserIds } = await this.createWithUniqueRef(
      ownerId,
      dto,
    );

    // Best-effort, after the create transaction has committed — see
    // `notifyInvitees`.
    await this.notifyInvitees(saved, ownerId, invitedUserIds);

    // The creator is always 'owner' right after creation — skip the extra
    // roster lookup `buildDetail` would otherwise do.
    return this.buildDetail(saved, ownerId, RosterRole.Owner);
  }

  // `ref = QP-C-<count()+1>` (and, like it, the slug pre-check) can lose a
  // race to a concurrent create landing between the read and this INSERT;
  // the unique indexes on `ref`/`slug` are the real backstop and turn that
  // race into a 23505. A 23505 aborts the whole transaction (Postgres poisons
  // it on any statement error), so the retry has to re-run the *entire*
  // transaction with freshly recomputed values, not just the failed insert.
  // Mirrors `EventsService.saveWithUniqueSlug`'s retry loop, generalized from
  // a single `.save()` to the whole create transaction.
  private async createWithUniqueRef(
    ownerId: string,
    dto: CreateCommunityInput,
  ): Promise<{ community: Community; invitedUserIds: string[] }> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle, 'community'),
        (s) => this.communities.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const communitiesRepo = manager.getRepository(Community);
          const membersRepo = manager.getRepository(CommunityMember);

          // Best-effort sequential ref (`QP-C-0004`, ...), per the brief.
          // Computed inside the transaction so it sees the latest committed
          // count; the enclosing retry loop is what covers the race.
          const count = await communitiesRepo.count();
          const ref = `QP-C-${String(count + 1).padStart(4, '0')}`;

          const community = await communitiesRepo.save(
            communitiesRepo.create({
              slug,
              name: dto.name,
              purpose: dto.purpose,
              type: dto.type,
              whoFor: dto.whoFor,
              tagline: dto.tagline,
              accessTier: dto.accessTier,
              rosterVisible: dto.rosterVisible,
              features: dto.features,
              rules: dto.rules,
              tags: dto.tags ?? [],
              coverImageUrl: dto.coverImageUrl ?? null,
              ownerId,
              ref,
            }),
          );

          await membersRepo.save(
            membersRepo.create({
              communityId: community.id,
              userId: ownerId,
              role: RosterRole.Owner,
            }),
          );

          const invitedUserIds = await this.seedExtraRoster(
            manager.getRepository(Profile),
            membersRepo,
            community.id,
            ownerId,
            dto.stewards ?? [],
            dto.invites ?? [],
          );

          return { community, invitedUserIds };
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the ref/slug race — recompute both and retry a fresh
            // transaction (the aborted one can't be resumed).
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique community ref',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved community or throws above.
    throw new ConflictException('Could not allocate a unique community ref');
  }

  async list(
    viewerId: string,
    query: CommunityListQuery,
  ): Promise<Paginated<CommunityCardDTO>> {
    const page = normalizePage(query.page);
    const filter = query.filter ?? 'discover';

    const qb = this.communities.createQueryBuilder('c');

    if (filter === 'mine') {
      qb.innerJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      );
    } else {
      // 'discover' — a LEFT JOIN so a non-member row still surfaces (as long
      // as it isn't private); a member always sees their own communities
      // regardless of tier.
      qb.leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      ).andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      });
    }

    if (query.type) {
      qb.andWhere('c.type = :type', { type: query.type });
    }
    if (query.access) {
      qb.andWhere('c.access_tier = :access', { access: query.access });
    }
    if (query.q) {
      // ANDed onto the existing filters (not a replacement) — mirrors
      // `searchByText`'s ILIKE clause over the same three columns.
      const pattern = `%${escapeLikeTerm(query.q)}%`;
      qb.andWhere(
        '(c.name ILIKE :qPattern OR c.tagline ILIKE :qPattern OR c.purpose ILIKE :qPattern)',
        { qPattern: pattern },
      );
    }
    // Curated tag filter. Plain array-overlap against the GIN-indexed
    // `communities.tags` (see `AddCommunityTags`), same shape as
    // `ProfilesService.searchMembers`'s `?tags=`/`?disciplines=` filters.
    // Unknown ids are dropped; if EVERY id was unknown the caller asked for a
    // tag that cannot exist, so match nothing rather than silently returning
    // the unfiltered list.
    const tags = knownCommunityTags(csv(query.tags));
    if (csv(query.tags).length) {
      if (!tags.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('c.tags && :tags', { tags });
      }
    }
    // An archived community leaves every listing (discover AND mine) — it has
    // been taken down by its owner, so it should stop surfacing anywhere a card
    // is rendered, exactly like the moderated-away exclusion just below.
    qb.andWhere('c.archived_at IS NULL');
    this.excludeModeratedCommunities(qb);

    // 'name' ties (names aren't unique) get a stable, deterministic
    // secondary key so pagination doesn't reshuffle rows across pages.
    if (query.sort === 'name') {
      qb.orderBy('c.name', 'ASC').addOrderBy('c.id', 'ASC');
    } else {
      qb.orderBy('c.createdAt', 'DESC');
    }

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const ids = rows.map((c) => c.id);
      const [stats, myRoles] = await Promise.all([
        this.statsForMany(ids),
        this.myRoleByCommunity(ids, viewerId),
      ]);
      return rows.map((c) =>
        toCommunityCard(
          c,
          stats.get(c.id) ?? EMPTY_STATS,
          myRoles.get(c.id) ?? null,
        ),
      );
    });
  }

  /**
   * `GET /communities/featured` — the single admin-chosen community the
   * Discover page's hero card shows (`AdminCommunitiesService.updateSettings`
   * is the only writer of `is_featured`, enforced as a singleton there).
   * `null` when no community is currently featured, or when the featured
   * community is archived/moderated-away/private-to-someone-else — this
   * reuses `list()`'s own visibility rule rather than a bare `findOne` so the
   * hero card never leaks a private community to a non-member.
   */
  async getFeatured(viewerId: string): Promise<CommunityCardDTO | null> {
    const qb = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .andWhere('c.is_featured = true')
      .andWhere('c.archived_at IS NULL')
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      });
    this.excludeModeratedCommunities(qb);

    const community = await qb.getOne();
    if (!community) return null;

    const [stats, myRoles] = await Promise.all([
      this.statsForMany([community.id]),
      this.myRoleByCommunity([community.id], viewerId),
    ]);
    return toCommunityCard(
      community,
      stats.get(community.id) ?? EMPTY_STATS,
      myRoles.get(community.id) ?? null,
    );
  }

  // Cross-entity global search (SearchService) — mirrors `list()`'s visibility
  // rule (private communities are only visible to their own members) and its
  // batched stats/role hydration. ILIKE over name / tagline / purpose.
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<CommunityCardDTO[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const rowsQb = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      })
      .andWhere(
        '(c.name ILIKE :pattern OR c.tagline ILIKE :pattern OR c.purpose ILIKE :pattern)',
        { pattern },
      )
      .andWhere('c.archived_at IS NULL');
    this.excludeModeratedCommunities(rowsQb);
    const rows = await rowsQb.orderBy('c.name', 'ASC').take(limit).getMany();

    if (!rows.length) return [];
    const ids = rows.map((community) => community.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(ids),
      this.myRoleByCommunity(ids, viewerId),
    ]);
    return rows.map((community) =>
      toCommunityCard(
        community,
        stats.get(community.id) ?? EMPTY_STATS,
        myRoles.get(community.id) ?? null,
      ),
    );
  }

  /**
   * `GET /communities/:slug/related` — up to 4 OTHER communities sharing at
   * least one curated tag with this one, ranked by overlap count (highest
   * first). If the source community has no tags at all, returns `[]` rather
   * than falling back to some other ranking — an untagged community has no
   * tag-based notion of "related" to compute.
   *
   * Same visibility posture as `list()`/`searchByText`: a private community
   * only surfaces to its own members, archived/moderated-away communities
   * never surface. `viewerId` also drives `myRole` on each returned card,
   * same as every other card-producing method here.
   *
   * The overlap count is computed with `cardinality(ARRAY(... INTERSECT
   * ...))` rather than a bespoke intersection operator — Postgres has no
   * built-in array-intersection operator (`&&` only tests *whether* two
   * arrays overlap, not by how much), so the exact count needs this
   * unnest/INTERSECT idiom. The `c.tags && :tags` filter runs first and can
   * use the existing GIN index (`AddCommunityTags`) to narrow candidates
   * before the per-row cardinality is computed and sorted on.
   */
  async relatedCommunities(
    slug: string,
    viewerId: string,
  ): Promise<CommunityCardDTO[]> {
    const community = await this.loadOr404(slug);
    if (!community.tags.length) return [];

    const qb = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .where('c.id != :id', { id: community.id })
      .andWhere('c.tags && :tags', { tags: community.tags })
      .andWhere('c.archived_at IS NULL')
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      });
    this.excludeModeratedCommunities(qb);

    qb.addSelect(
      'cardinality(ARRAY(SELECT unnest(c.tags) INTERSECT SELECT unnest(CAST(:tags AS text[]))))',
      'overlap',
    )
      .orderBy('overlap', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .take(4);

    const rows = await qb.getMany();
    if (!rows.length) return [];

    const ids = rows.map((c) => c.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(ids),
      this.myRoleByCommunity(ids, viewerId),
    ]);
    return rows.map((c) =>
      toCommunityCard(
        c,
        stats.get(c.id) ?? EMPTY_STATS,
        myRoles.get(c.id) ?? null,
      ),
    );
  }

  /**
   * `GET /communities/suggested` — up to `SUGGESTED_COMMUNITIES_LIMIT`
   * communities the viewer hasn't joined that people in their SOCIAL GRAPH
   * have joined, ranked by how many of those connections are on each
   * community's roster (most-connected-in first).
   *
   * The signal is the viewer's ACCEPTED `connections` graph — not
   * `Community.tags`/`Profile.tags` (a tag-based version was investigated and
   * rejected: there's no real vocabulary bridge between free-text profile
   * tags and curated community tags). "Who is this member connected to" is
   * `ConnectionsService.allAcceptedConnectionUserIds`, the same uncapped,
   * id-only accepted-connection read `EventsService`'s `network`-visibility
   * gate reuses — uncapped (unlike the 200-capped
   * `getAcceptedConnectionUserIds`, fine for a rendered list but wrong here:
   * truncating a viewer's own connections would silently under-rank or drop a
   * community their 201st+ connection is in).
   *
   * If the viewer has no accepted connections, or none of those connections
   * belong to any community the viewer hasn't already joined, this returns
   * `[]` — no fallback ranking. Same "no signal = empty, don't guess" posture
   * as `relatedCommunities`.
   *
   * Visibility mirrors `list()`/`relatedCommunities()`: archived and
   * moderator-taken-down communities never surface (`excludeModeratedCommunities`),
   * and since every candidate here is, by construction, a community the
   * viewer has NOT joined (`m.user_id IS NULL`), the private-tier exclusion
   * `list()` expresses as "`private` OR I'm a member" collapses to a flat
   * `access_tier != private` — a private community the viewer isn't in can
   * never be a legitimate suggestion.
   *
   * The connection-overlap count is a correlated-subquery `COUNT(DISTINCT
   * ...)` over `community_members`, mirroring `relatedCommunities`'s own
   * addSelect-a-raw-expression-then-ORDER-BY-its-alias shape (there it's
   * `cardinality(ARRAY(... INTERSECT ...))` for tag overlap; here it's a
   * membership-count subquery). `community_members` already carries a unique
   * composite index on `(community_id, user_id)` (`UQ_community_members`),
   * which backs both the `EXISTS` candidate filter and the `COUNT` — no new
   * index needed.
   */
  async suggestedCommunities(userId: string): Promise<CommunityCardDTO[]> {
    const connectionIds =
      await this.connectionsService.allAcceptedConnectionUserIds(userId);
    if (!connectionIds.length) return [];

    const qb = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :userId',
        { userId },
      )
      .where('m.user_id IS NULL') // the viewer hasn't joined this one
      .andWhere('c.archived_at IS NULL')
      .andWhere('c.access_tier != :privateTier', {
        privateTier: AccessTier.Private,
      })
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "community_members" "cm"
          WHERE "cm"."community_id" = c.id AND "cm"."user_id" IN (:...connectionIds)
        )`,
        { connectionIds },
      );
    this.excludeModeratedCommunities(qb);

    qb.addSelect(
      `(SELECT COUNT(DISTINCT "cm2"."user_id") FROM "community_members" "cm2"
        WHERE "cm2"."community_id" = c.id AND "cm2"."user_id" IN (:...connectionIds))`,
      'connectionCount',
    )
      .orderBy('"connectionCount"', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .take(SUGGESTED_COMMUNITIES_LIMIT);

    const rows = await qb.getMany();
    if (!rows.length) return [];

    const ids = rows.map((c) => c.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(ids),
      this.myRoleByCommunity(ids, userId),
    ]);
    return rows.map((c) =>
      toCommunityCard(
        c,
        stats.get(c.id) ?? EMPTY_STATS,
        myRoles.get(c.id) ?? null,
      ),
    );
  }

  async getBySlug(slug: string, viewerId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);
    // Private + non-member -> 404, not 403, so existence isn't leaked.
    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }
    // A moderator takedown 404s the detail for everyone but the community's own
    // owner/mod — same "don't leak existence" posture as the private-tier gate.
    const moderation = await this.contentModeration.stateFor(
      CommunitiesService.SUBJECT_TYPE,
      community.slug,
    );
    if (
      (moderation.hidden || moderation.removed) &&
      !CommunitiesService.isStaffRole(role)
    ) {
      throw new NotFoundException('Community not found');
    }
    // An archived community 404s for everyone but its own owner/mods — same
    // "don't leak existence" posture as the private-tier and takedown gates.
    // Staff still get the detail (with `archived: true`) so the mod panel can
    // render the archived state rather than "not found".
    if (community.archivedAt != null && !CommunitiesService.isStaffRole(role)) {
      throw new NotFoundException('Community not found');
    }
    return this.buildDetail(community, viewerId, role, moderation);
  }

  async update(
    slug: string,
    userId: string,
    dto: UpdateCommunityInput,
  ): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, userId);

    Object.assign(community, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.whoFor !== undefined ? { whoFor: dto.whoFor } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.accessTier !== undefined ? { accessTier: dto.accessTier } : {}),
      ...(dto.rosterVisible !== undefined
        ? { rosterVisible: dto.rosterVisible }
        : {}),
      ...(dto.features !== undefined ? { features: dto.features } : {}),
      ...(dto.rules !== undefined ? { rules: dto.rules } : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      // '' from the client (cleared field) normalizes to NULL so an empty
      // cover reads back as "no cover", not an empty string.
      ...(dto.coverImageUrl !== undefined
        ? { coverImageUrl: dto.coverImageUrl || null }
        : {}),
    });

    const saved = await this.communities.save(community);
    return this.buildDetail(saved, userId);
  }

  /**
   * `POST /communities/:slug/archive` — take the community down from the mod
   * panel's danger zone.
   *
   * OWNER-ONLY, deliberately stricter than the `owner/mod` gate `update` and
   * the roster routes use. Archiving takes the *whole community* down for every
   * member at once; letting a single moderator do that would be a takeover-by-
   * destruction — the same class of escalation the owner-immutability rules in
   * `removeMember`/`setMemberRole` exist to prevent. Ownership
   * (`Community.ownerId`) is the root of authority, so only the owner may pull
   * this lever.
   *
   * Idempotent: archiving an already-archived community is a no-op 200 (the
   * first `archivedAt` timestamp stands), matching this module's posture on
   * `join`, reaction-add and approve-triage. The owner is still staff, so the
   * returned detail carries `archived: true` rather than 404ing.
   */
  async archive(slug: string, userId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    this.assertOwner(community, userId);

    if (community.archivedAt == null) {
      community.archivedAt = new Date();
      await this.communities.save(community);
      await this.logGovernanceAction(
        community.id,
        userId,
        GovernanceLogAction.Archived,
      );
      await this.notifyRosterArchived(community, userId);
    }
    return this.buildDetail(community, userId, RosterRole.Owner);
  }

  /**
   * `POST /communities/:slug/freeze` — an owner or mod manually freezes a
   * community (e.g. ahead of a moderation review), symmetric to `unfreeze`.
   * Unlike `unfreeze`'s automatic-only counterpart (`CommunityAutoFreezeService`),
   * this action has a real human actor, so it's logged with `actorUserId`
   * set rather than `null`. Idempotent: freezing an already-frozen community
   * is a no-op 200. Uses the same atomic conditional-UPDATE guard (`frozen_at
   * IS NULL`) as `CommunityAutoFreezeService.maybeFreeze`, so a manual freeze
   * racing an automatic one (or a second manual call) can't double-log or
   * double-notify.
   */
  async freeze(slug: string, userId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, userId);
    if (!CommunitiesService.isStaffRole(role)) {
      throw new ForbiddenException(
        'Only an owner or mod can freeze a community',
      );
    }

    if (community.frozenAt == null) {
      const result = await this.communities
        .createQueryBuilder()
        .update(Community)
        .set({ frozenAt: () => 'now()' })
        .where('id = :id AND frozen_at IS NULL', { id: community.id })
        .execute();
      if (result.affected) {
        community.frozenAt = new Date();
        await this.logGovernanceAction(
          community.id,
          userId,
          GovernanceLogAction.Frozen,
          null,
          { reason: 'manual' },
        );
        await this.notifyStaffFreezeChange(
          community,
          NotificationType.CommunityFrozen,
          userId,
          { reason: 'manual' },
        );
      }
    }
    return this.buildDetail(community, userId, role);
  }

  /**
   * `POST /communities/:slug/unfreeze` — an owner or mod lifts a freeze
   * (automatic or manual) once they've handled whatever triggered it.
   * Idempotent — unfreezing a community that isn't frozen is a no-op 200
   * that just returns the current detail.
   */
  async unfreeze(slug: string, userId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, userId);
    if (!CommunitiesService.isStaffRole(role)) {
      throw new ForbiddenException(
        'Only an owner or mod can unfreeze a community',
      );
    }
    if (community.frozenAt != null) {
      community.frozenAt = null;
      await this.communities.save(community);
      await this.logGovernanceAction(
        community.id,
        userId,
        GovernanceLogAction.Unfrozen,
      );
      await this.notifyStaffFreezeChange(
        community,
        NotificationType.CommunityUnfrozen,
        userId,
      );
    }
    return this.buildDetail(community, userId, role);
  }

  /**
   * `POST /communities/:slug/transfer` — hand ownership to another member.
   *
   * Guardrails, in the order enforced below (mirrors `AdminMembersService
   * .updateRole`'s house-account + self-action posture, and this module's own
   * owner invariants):
   *
   *  1. **Actor must be the CURRENT owner.** Not owner-or-mod: transferring the
   *     community away is the single most consequential act on it, and only its
   *     root of authority (`Community.ownerId`) may perform it. A mod attempting
   *     it gets Forbidden.
   *  2. **Target must be a member of this community.** Unknown slug, or a member
   *     of some other community, both 404 `Member not found` — same as
   *     `setMemberRole`/`removeMember`.
   *  3. **No self-transfer.** Handing the community to yourself is a no-op the
   *     caller almost certainly didn't mean; 400 rather than silently succeed.
   *  4. **No transfer to the house account.** A `User.isSystem` account is a
   *     non-human platform account that never rides a permission path; making
   *     it a community owner would strand the community under an account no one
   *     signs in as. Mirrors the immovable-house-account rule in admin role
   *     management.
   *
   * The swap runs in one transaction: `Community.ownerId` moves to the target,
   * the target's roster row becomes `owner`, and the outgoing owner is demoted
   * to `mod` (they keep moderator reach and stay on the roster rather than being
   * orphaned). All three writes commit together or none do.
   */
  async transferOwnership(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);

    // 1. actor is the current owner
    this.assertOwner(community, actorId);

    // 2. target is on this roster
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }

    // 3. not a self-transfer (checked before the roster lookup below since the
    //    owner is trivially their own member)
    if (targetUserId === actorId) {
      throw new BadRequestException('You already own this community');
    }

    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    // 4. not the house account
    const targetUser = await this.users.findOne({
      where: { id: targetUserId },
      select: { id: true, isSystem: true },
    });
    if (targetUser?.isSystem) {
      throw new BadRequestException(
        'Ownership cannot be transferred to the house account',
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const communitiesRepo = manager.getRepository(Community);
      const membersRepo = manager.getRepository(CommunityMember);

      community.ownerId = targetUserId;
      const savedCommunity = await communitiesRepo.save(community);

      // New owner's roster row -> owner.
      targetMembership.role = RosterRole.Owner;
      await membersRepo.save(targetMembership);

      // Outgoing owner stays on the roster, demoted to mod. Guarded on the row
      // still reading `owner` so a retry can't double-demote something already
      // moved.
      const actorMembership = await membersRepo.findOne({
        where: { communityId: community.id, userId: actorId },
      });
      if (actorMembership && actorMembership.role === RosterRole.Owner) {
        actorMembership.role = RosterRole.Mod;
        await membersRepo.save(actorMembership);
      }

      return savedCommunity;
    });

    await this.logGovernanceAction(
      community.id,
      actorId,
      GovernanceLogAction.OwnershipTransferred,
      targetUserId,
      { fromOwnerId: actorId },
    );
    await this.notifyOwnershipTransferred(community, actorId, targetUserId);

    // The actor is now a moderator of the community they handed off.
    return this.buildDetail(saved, actorId, RosterRole.Mod);
  }

  // `public` joins land on the roster instantly; every other tier
  // (`request`/`invite`/`private`) creates a pending `CommunityJoinRequest`
  // for an owner/mod to triage. Idempotent either way: already being on the
  // roster short-circuits to `joined` regardless of tier, so a repeat call
  // (or a UI double-click) never 500s.
  async join(
    slug: string,
    userId: string,
    dto: JoinCommunityInput,
  ): Promise<JoinResultDTO> {
    const community = await this.loadOr404(slug);

    const existingMembership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (existingMembership) {
      return { outcome: 'joined', role: RosterRole.Member, request: null };
    }

    // A frozen community stays visible but takes no new members until an
    // owner/mod lifts the freeze (see `Community.frozenAt`). Existing members
    // short-circuit above, so this only blocks a genuinely new join.
    if (community.frozenAt) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }

    // Second-vouch gate: a community that requires a vouch to join can only
    // instant-admit an applicant a current member has vouched for. An un-vouched
    // applicant to an otherwise-public community is routed to a reviewable
    // request rather than silently turned away — a mod (themselves a member)
    // can vouch, then approve. Request/invite/private tiers already create a
    // request; the same gate is enforced again at approval in `triageJoinRequest`.
    const instantJoinAllowed =
      community.accessTier === AccessTier.Public &&
      (!community.requiresSecondVouch ||
        (await this.hasMemberVouch(community.id, userId)));

    if (instantJoinAllowed) {
      // ON CONFLICT DO NOTHING absorbs a race between two concurrent joins
      // without a pre-check + 23505 — mirrors `CommunityPostsService
      // .addReaction`/`EventsService.addCohost`'s insert idiom.
      await this.members
        .createQueryBuilder()
        .insert()
        .into(CommunityMember)
        .values({ communityId: community.id, userId, role: RosterRole.Member })
        .orIgnore()
        .execute();
      return { outcome: 'joined', role: RosterRole.Member, request: null };
    }

    // request | invite | private, or a second-vouch-gated public join -> pending.
    return this.createJoinRequest(community, slug, userId, dto);
  }

  /**
   * Create a pending join request. Used by the request/invite/private tiers and
   * by a public community whose second-vouch gate the applicant hasn't met. The
   * partial-unique index on (community_id, user_id) WHERE status='pending' is
   * the real backstop against a double-request race; a hit surfaces here as
   * 23505 and converges on a 409.
   */
  private async createJoinRequest(
    community: Community,
    slug: string,
    userId: string,
    dto: JoinCommunityInput,
  ): Promise<JoinResultDTO> {
    try {
      const saved = await this.joinRequests.save(
        this.joinRequests.create({
          communityId: community.id,
          userId,
          note: dto.note ?? null,
        }),
      );
      const memberRef = await this.memberRefFor(userId);
      // Tell the owner + mods a request is waiting. Best-effort: a notification
      // failure must not fail the request itself. `createForRecipients` applies
      // the actor block/mute filter per recipient and drops the requester
      // themselves, so no self-notification is possible.
      await this.notifyStaffOfJoinRequest(community, slug, userId);
      return {
        outcome: 'requested',
        role: null,
        request: toJoinRequestDTO(saved, memberRef),
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A join request is already pending');
      }
      throw err;
    }
  }

  /**
   * Whether a current member of the community holds an active platform vouch for
   * the applicant — the "second vouch" a `requiresSecondVouch` community needs
   * before admitting someone. An empty roster (nobody to have vouched) is
   * trivially unmet.
   */
  private async hasMemberVouch(
    communityId: string,
    applicantId: string,
  ): Promise<boolean> {
    const rows = await this.members.find({
      where: { communityId },
      select: { userId: true },
    });
    return this.vouch.hasActiveVouchFrom(
      rows.map((row) => row.userId),
      applicantId,
    );
  }

  // Private + non-member -> 404, not 403, so existence isn't leaked — mirrors
  // `getBySlug`/`CommunityPostsService.assertViewable`. Beyond that, respects
  // `rosterVisible`: a non-member is forbidden from seeing the roster of a
  // (non-private) community that has opted to keep it members-only.
  //
  // DELIBERATELY NOT block/mute filtered, unlike the post feeds in
  // `CommunityPostsService.listPosts`. A roster is a factual membership
  // record, not a content feed: hiding a blocked member from it would tell the
  // viewer that someone they blocked is *absent* from a space they are in fact
  // in — actively misleading, and worse for the blocker than the truth, since
  // deciding whether to join or post somewhere may depend on exactly that.
  // Blocks already do the work that matters here by severing interaction; they
  // are not a "make them disappear from the world" primitive.
  async roster(
    slug: string,
    viewerId: string,
    page?: number,
  ): Promise<Paginated<RosterEntryDTO>> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);

    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }

    if (!community.rosterVisible && !role) {
      throw new ForbiddenException('Roster is private to members');
    }

    const normalizedPage = normalizePage(page);
    const qb = this.members
      .createQueryBuilder('m')
      .where('m.community_id = :communityId', { communityId: community.id })
      .orderBy('m.joined_at', 'ASC');

    return paginate(qb, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      const refs = await new MemberLookup(this.profiles).byUserIds(
        rows.map((m) => m.userId),
      );
      return rows
        .filter((m) => refs.has(m.userId))
        .map((m) => toRosterEntry(m, refs.get(m.userId)!));
    });
  }

  // Also NOT block/mute filtered, for a stronger reason than `roster` above:
  // this is a moderation queue, not a feed. Silently hiding a join request
  // because the reviewing mod happens to have blocked (or muted) the applicant
  // would strand that request as permanently pending, with no one aware it
  // exists — a block by one mod would become an invisible, unaccountable veto.
  // A mod who cannot fairly triage a specific applicant should recuse
  // themselves; the queue must still show the work.
  /**
   * `POST /communities/:slug/tag-requests` — an owner/mod's free-text
   * "I wish this tag existed" feedback. Same owner/mod gate as `update`.
   * INFORMATIONAL ONLY: this never touches `COMMUNITY_TAGS` or
   * `Community.tags` — see `CommunityTagRequest`'s docstring. An admin
   * reviews the resulting inbox from `AdminCommunityTagRequestsController`.
   */
  async createTagRequest(
    slug: string,
    actorId: string,
    dto: CreateCommunityTagRequestDto,
  ): Promise<CommunityTagRequestResponseDTO> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const saved = await this.tagRequests.save(
      this.tagRequests.create({
        communityId: community.id,
        requestedByUserId: actorId,
        label: dto.label.trim(),
        note: dto.note?.trim() ? dto.note.trim() : null,
      }),
    );
    return toCommunityTagRequestResponse(saved);
  }

  async listJoinRequests(
    slug: string,
    actorId: string,
  ): Promise<CommunityJoinRequestDTO[]> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const rows = await this.joinRequests.find({
      where: { communityId: community.id, status: JoinRequestStatus.Pending },
      order: { createdAt: 'ASC' },
    });
    if (!rows.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((r) => r.userId),
    );
    return rows
      .filter((r) => refs.has(r.userId))
      .map((r) => toJoinRequestDTO(r, refs.get(r.userId)!));
  }

  async triageJoinRequest(
    slug: string,
    id: string,
    actorId: string,
    action: JoinRequestAction,
  ): Promise<CommunityJoinRequestDTO> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const request = await this.joinRequests.findOne({
      where: { id, communityId: community.id },
    });
    if (!request) {
      throw new NotFoundException('Join request not found');
    }
    if (request.status !== JoinRequestStatus.Pending) {
      throw new ConflictException('Join request already resolved');
    }

    // Second-vouch gate at admission: even a mod can't approve until a current
    // member holds a vouch for the applicant (a mod is a member, so they can
    // vouch first, then approve). Only enforced on approve — declining is always
    // allowed.
    if (
      action === 'approve' &&
      community.requiresSecondVouch &&
      !(await this.hasMemberVouch(community.id, request.userId))
    ) {
      throw new UnprocessableEntityException(
        'This community requires a vouch from a current member before this applicant can be admitted',
      );
    }

    const newStatus =
      action === 'approve'
        ? JoinRequestStatus.Approved
        : JoinRequestStatus.Declined;

    const saved = await this.dataSource.transaction(async (manager) => {
      const joinRequestsRepo = manager.getRepository(CommunityJoinRequest);
      const membersRepo = manager.getRepository(CommunityMember);

      // Atomic conditional claim: flip `pending -> newStatus` only if the row
      // is STILL pending. The pre-transaction status check above is just a
      // fast-path; without this guarded UPDATE an approve and a decline racing
      // (or a double-approve) could both pass that check as read-modify-write,
      // and the approve branch could leave a just-declined applicant on the
      // roster. `affected === 0` means another call already resolved it — the
      // roster insert below is then skipped and we abort with a 409.
      const claim = await joinRequestsRepo
        .createQueryBuilder()
        .update(CommunityJoinRequest)
        .set({ status: newStatus })
        .where('id = :id AND status = :pending', {
          id: request.id,
          pending: JoinRequestStatus.Pending,
        })
        .execute();
      if (claim.affected === 0) {
        // Rolls the transaction back (nothing was inserted, since the roster
        // insert is gated on this claim succeeding).
        throw new ConflictException('Join request already resolved');
      }

      if (action === 'approve') {
        // Idempotent upsert: approving a request whose applicant is somehow
        // already a member must not 500 on the roster's unique constraint.
        await membersRepo
          .createQueryBuilder()
          .insert()
          .into(CommunityMember)
          .values({
            communityId: community.id,
            userId: request.userId,
            role: RosterRole.Member,
          })
          .orIgnore()
          .execute();
      }

      // Reflect the claimed status on the in-memory entity for the DTO — the
      // guarded UPDATE doesn't hydrate it.
      request.status = newStatus;
      return request;
    });

    // Tell the applicant the outcome — they always have an account (a
    // `CommunityJoinRequest.userId` is a real member), so this in-app
    // notification always reaches them. No actor: it's the community telling
    // you about your own status, not a member action to filter on. Best-effort.
    try {
      await this.notifications.create(
        saved.userId,
        action === 'approve'
          ? NotificationType.JoinRequestApproved
          : NotificationType.JoinRequestDeclined,
        { source: 'community', communitySlug: slug },
      );
    } catch {
      // Intentionally ignored — the triage decision already committed.
    }

    const memberRef = await this.memberRefFor(saved.userId);
    return toJoinRequestDTO(saved, memberRef);
  }

  /**
   * Fan the "someone wants to join" notification out to the owner and every
   * mod. Own try/catch so a notification failure never surfaces as a failed
   * join request. Deep-links to the community (where the triage queue lives).
   */
  private async notifyStaffOfJoinRequest(
    community: Community,
    slug: string,
    requesterId: string,
  ): Promise<void> {
    try {
      const recipientIds = await this.staffRecipientIds(community);
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.JoinRequestReceived,
        { actorId: requesterId, source: 'community', communitySlug: slug },
        requesterId,
      );
    } catch {
      // Intentionally ignored — best-effort, same contract as the reply fan-out.
    }
  }

  // Self-leave or mod-remove; the owner is never removable (they'd orphan
  // the community) — that check runs after authorization so an unauthorized
  // stranger gets Forbidden rather than a hint about who owns it.
  async removeMember(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<void> {
    const community = await this.loadOr404(slug);

    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    if (actorId !== targetUserId) {
      await this.assertOwnerOrMod(community.id, actorId);
    }

    if (targetMembership.role === RosterRole.Owner) {
      throw new BadRequestException('The owner cannot be removed');
    }

    await this.members.delete({ id: targetMembership.id });

    const removedBySelf = actorId === targetUserId;
    await this.logGovernanceAction(
      community.id,
      actorId,
      GovernanceLogAction.MemberRemoved,
      targetUserId,
      { removedBySelf },
    );
    // A self-leave doesn't need a "you were removed" notification telling the
    // member the thing they themselves just did.
    if (!removedBySelf) {
      await this.notifyMemberRemoved(community, actorId, targetUserId);
    }
  }

  /**
   * `GET /me/communities` — every community the caller is actually *on the
   * roster of*, as a flat `{ slug, name, role, joinedAt }[]`.
   *
   * DELIBERATELY NOT PAGINATED, unlike `list()`. This is a membership index
   * the client needs *whole* (it keys a slug -> role map used to decide, for
   * any community it renders from any other source, whether the viewer is a
   * member). Serving it a page at a time is precisely the defect this
   * endpoint exists to fix: the previous workaround — filtering
   * `myRole !== null` across `GET /communities` — is incomplete by
   * construction, because that route is paginated and there is no guarantee
   * the caller's memberships fall on the pages fetched. A member's community
   * count is inherently small and bounded by deliberate human action (you
   * join communities one at a time), so the whole set is a safe response
   * size; if that ever stops being true the fix is a cap plus an explicit
   * signal, not silent truncation.
   *
   * Only `community_members` rows count. A *pending* `CommunityJoinRequest`
   * is not a membership and never appears here — it has no roster row at all,
   * so it is excluded structurally rather than by a filter. (`myJoinRequestStatus`
   * on the community card/detail is where a pending request surfaces.)
   *
   * NOT block-filtered, and there is nothing here to filter: every row
   * describes the caller's own relationship to a community, so no other
   * member's identity or content is exposed. (`BlockFilterService` is used in
   * this module only by `CommunityPostsService`, over post/reply *authors* —
   * see the notes on `roster` and `listJoinRequests` for why the membership
   * surfaces stay unfiltered.)
   */
  async myCommunities(userId: string): Promise<MyCommunityDTO[]> {
    const rows = await this.members
      .createQueryBuilder('m')
      .innerJoin(Community, 'c', 'c.id = m.community_id')
      .select('c.slug', 'slug')
      .addSelect('c.name', 'name')
      .addSelect('m.role', 'role')
      .addSelect('m.joined_at', 'joinedAt')
      .where('m.user_id = :userId', { userId })
      // An archived community drops out of the caller's membership map too, so
      // the client stops treating it as a live community they belong to.
      .andWhere('c.archived_at IS NULL')
      .orderBy('m.joined_at', 'DESC')
      .limit(DEFAULT_LIST_LIMIT)
      .getRawMany<{
        slug: string;
        name: string;
        role: RosterRole;
        joinedAt: Date;
      }>();

    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      role: r.role,
      joinedAt: new Date(r.joinedAt).toISOString(),
    }));
  }

  /**
   * `PATCH /communities/:slug/members/:memberSlug` — promote a member to
   * moderator, or demote a moderator back to member.
   *
   * Authorization rules, in the order enforced below:
   *
   *  1. **Actor must be owner or mod** — the same `assertOwnerOrMod` gate the
   *     join-request review routes (`listJoinRequests`/`triageJoinRequest`)
   *     and `update` already use. Checked *first*, before the target is even
   *     resolved, so an unauthorized caller learns nothing about who is on
   *     the roster (stricter than `removeMember`, which has to resolve the
   *     target first because self-leave is an authorized path there; this
   *     route has no self path at all — see rule 4).
   *  2. **Target must be on this roster** — unknown/inactive member slug, or
   *     a real member of some *other* community, both 404 `Member not found`,
   *     mirroring `removeMember`.
   *  3. **The owner's role is immutable.** Mirrors `removeMember`'s "the
   *     owner cannot be removed": the owner is the community's root of
   *     authority and `Community.ownerId` is the source of truth for it, so a
   *     roster row can't contradict it. Without this a *mod* could demote the
   *     owner and take over the community — the escalation this route most
   *     obviously invites. 400, not 403: the actor is allowed to be here, the
   *     requested change is the impossible part.
   *  4. **Nobody changes their own role.** Redundant in today's role set
   *     (an owner acting on themselves is caught by rule 3, a mod acting on
   *     themselves by rule 5) but stated explicitly so the invariant survives
   *     any future rule change — self-mutation is the classic escalation
   *     vector. Stepping down is done by leaving (`DELETE .../members/:me`),
   *     which is the self-service path that already exists.
   *  5. **Only the owner may change an existing moderator's role.** A mod may
   *     therefore only promote a plain `member` to `mod`; they may not demote
   *     a peer. Otherwise any single mod could unilaterally dismantle the rest
   *     of the mod team and become the sole moderator — a takeover from
   *     inside the mod tier, quietly and with nothing on the roster to show
   *     for it. (Note the deliberate asymmetry with `removeMember`, which does
   *     let a mod remove a peer mod outright. Removing is loud — the target
   *     vanishes from the roster and notices at once, and getting back in
   *     needs a fresh request plus an approval. A silent demotion is not, and
   *     "the same end is reachable by a noisier route" is not a reason to add
   *     a quiet one.)
   *
   * The rules are evaluated against the *current* roles only, never against
   * the role being requested, so authorization can't be steered by the body.
   * The requested value is consulted afterwards, and only to skip a no-op
   * write — the call is idempotent (re-promoting an existing mod, as the
   * owner, is a 200 with no UPDATE), matching this module's posture on
   * `join`, reaction-add and approve-triage.
   */
  async setMemberRole(
    slug: string,
    actorId: string,
    memberSlug: string,
    role: AssignableRole,
  ): Promise<MemberRoleDTO> {
    const community = await this.loadOr404(slug);

    // 1. actor is owner/mod
    const actorMembership = await this.assertOwnerOrMod(community.id, actorId);

    // 2. target is on this roster
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    // 3. the owner's role can never change
    if (targetMembership.role === RosterRole.Owner) {
      throw new BadRequestException("The owner's role cannot be changed");
    }

    // 4. no self role change
    if (targetUserId === actorId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    // 5. only the owner may change a moderator's role
    if (
      targetMembership.role === RosterRole.Mod &&
      actorMembership.role !== RosterRole.Owner
    ) {
      throw new ForbiddenException(
        "Only the owner can change a moderator's role",
      );
    }

    if (targetMembership.role !== role) {
      const fromRole = targetMembership.role;
      targetMembership.role = role;
      await this.members.save(targetMembership);
      await this.logGovernanceAction(
        community.id,
        actorId,
        GovernanceLogAction.RoleChanged,
        targetUserId,
        { fromRole, toRole: role },
      );
      await this.notifyRoleChanged(
        community,
        actorId,
        targetUserId,
        fromRole,
        role,
      );
    }

    return { slug: community.slug, memberSlug, role };
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Community> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  /** Returns the actor's roster row on success, so callers that need to
   * distinguish owner from mod (`setMemberRole`) don't re-query for it.
   * Callers that only need the gate can keep ignoring the value. */
  private async assertOwnerOrMod(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    if (
      !membership ||
      (membership.role !== RosterRole.Owner &&
        membership.role !== RosterRole.Mod)
    ) {
      throw new ForbiddenException('Only the owner or a moderator can do that');
    }
    return membership;
  }

  /** Owner-only gate, from `Community.ownerId` (the source of truth for
   * ownership — a roster row can never contradict it). Used by the community-
   * level destructive actions (`archive`, `transferOwnership`) that a mod must
   * not reach. Throws Forbidden otherwise. */
  private assertOwner(community: Community, userId: string): void {
    if (community.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can do that');
    }
  }

  private async myRole(
    communityId: string,
    userId: string,
  ): Promise<RosterRole | null> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    return membership?.role ?? null;
  }

  // Resolves a single userId to a MemberRef, for mapping a join-request /
  // roster row this service itself just created or mutated. A miss here
  // would mean a data-integrity bug (an authenticated actor without a
  // profile row), not a legitimate empty state, so it 404s rather than
  // silently mapping to `null` (unlike `toMemberRef`'s callers elsewhere,
  // which tolerate an optional/foreign profile being absent).
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async myRoleByCommunity(
    communityIds: string[],
    userId: string,
  ): Promise<Map<string, RosterRole>> {
    if (!communityIds.length) return new Map();
    const rows = await this.members.find({
      where: { communityId: In(communityIds), userId },
    });
    return new Map(rows.map((m) => [m.communityId, m.role]));
  }

  /**
   * Seeds the roster's `mod` rows from `stewards`, and resolves (but never
   * roster-adds) `invites`. Returns the resolved invitee user ids so the
   * caller (`create`, after this transaction commits) can send each of them
   * a `CommunityInviteReceived` notification — closing the gap where invites
   * were accepted by the create form but silently discarded. Still no
   * `CommunityInvite`/accept entity: force-adding members without consent is
   * unsafe, so an invite never becomes a `CommunityMember` row here, only a
   * notification. The slugs are resolved in one batched lookup alongside
   * `stewards` so an unknown/typo'd invite slug doesn't silently behave
   * differently from a valid one — it just resolves to nothing.
   */
  private async seedExtraRoster(
    profilesRepo: Repository<Profile>,
    membersRepo: Repository<CommunityMember>,
    communityId: string,
    ownerId: string,
    stewards: string[],
    invites: string[],
  ): Promise<string[]> {
    const slugs = [...stewards, ...invites];
    if (!slugs.length) return [];

    const lookup = new MemberLookup(profilesRepo);
    const idBySlug = await lookup.userIdsForSlugs(slugs);
    const seen = new Set<string>([ownerId]);
    const rows: CommunityMember[] = [];

    for (const slug of stewards) {
      const uid = idBySlug.get(slug);
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        rows.push(
          membersRepo.create({
            communityId,
            userId: uid,
            role: RosterRole.Mod,
          }),
        );
      }
    }

    if (rows.length) {
      await membersRepo.save(rows);
    }

    // A steward is already rostered as mod (and the owner is trivially
    // already in `seen`) — never also "invite" someone who's already on the
    // roster.
    const invitedUserIds: string[] = [];
    for (const slug of invites) {
      const uid = idBySlug.get(slug);
      if (uid && !seen.has(uid) && !invitedUserIds.includes(uid)) {
        invitedUserIds.push(uid);
      }
    }
    return invitedUserIds;
  }

  private async buildDetail(
    community: Community,
    viewerId: string,
    myRole?: RosterRole | null,
    moderation?: ContentModerationState,
  ): Promise<CommunityDetailDTO> {
    const [role, stats, ownerProfile, myJoinRequest, crops] = await Promise.all(
      [
        myRole !== undefined
          ? Promise.resolve(myRole)
          : this.myRole(community.id, viewerId),
        this.statsFor(community.id),
        // `ownerId` is null for an ownerless (post-erasure, pre-promotion)
        // community — no profile to look up; the detail simply renders no
        // owner rather than throwing or querying `userId IS NULL`.
        community.ownerId
          ? this.profiles.findOne({ where: { userId: community.ownerId } })
          : Promise.resolve(null),
        this.joinRequests.findOne({
          where: { communityId: community.id, userId: viewerId },
          order: { createdAt: 'DESC' },
        }),
        this.mediaCropService.getMany(
          community.coverImageUrl ? [community.coverImageUrl] : [],
        ),
      ],
    );
    return toCommunityDetail(
      community,
      stats,
      role,
      toMemberRef(ownerProfile),
      myJoinRequest?.status ?? null,
      moderation,
      crops,
    );
  }

  private async statsFor(communityId: string): Promise<CommunityStats> {
    const stats = await this.statsForMany([communityId]);
    return stats.get(communityId) ?? EMPTY_STATS;
  }

  // Grouped-count pattern (mirrors `EventsService.summarize`): one query per
  // metric across the whole page/id-set instead of N+1 per-row lookups.
  private async statsForMany(
    communityIds: string[],
  ): Promise<Map<string, CommunityStats>> {
    const stats = new Map<string, CommunityStats>(
      communityIds.map((id) => [id, { ...EMPTY_STATS }]),
    );
    if (!communityIds.length) return stats;
    const since = new Date(Date.now() - WEEK_MS);

    const memberRows = await this.members
      .createQueryBuilder('m')
      .select('m.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('m.community_id IN (:...ids)', { ids: communityIds })
      .groupBy('m.community_id')
      .getRawMany<{ communityId: string; count: string }>();
    for (const row of memberRows) {
      const s = stats.get(row.communityId);
      if (s) s.memberCount = Number(row.count);
    }

    const activeAuthors = new Map<string, Set<string>>(
      communityIds.map((id) => [id, new Set<string>()]),
    );

    const postRows = await this.posts
      .createQueryBuilder('p')
      .select('p.community_id', 'communityId')
      .addSelect('p.author_id', 'authorId')
      .where('p.community_id IN (:...ids)', { ids: communityIds })
      .andWhere('p.created_at >= :since', { since })
      .getRawMany<{ communityId: string; authorId: string }>();
    for (const row of postRows) {
      const s = stats.get(row.communityId);
      if (s) s.postsThisWeek += 1;
      activeAuthors.get(row.communityId)?.add(row.authorId);
    }

    const replyRows = await this.replies
      .createQueryBuilder('r')
      .innerJoin(CommunityPost, 'p', 'p.id = r.post_id')
      .select('p.community_id', 'communityId')
      .addSelect('r.author_id', 'authorId')
      .where('p.community_id IN (:...ids)', { ids: communityIds })
      .andWhere('r.created_at >= :since', { since })
      .getRawMany<{ communityId: string; authorId: string }>();
    for (const row of replyRows) {
      activeAuthors.get(row.communityId)?.add(row.authorId);
    }

    for (const [id, authors] of activeAuthors) {
      const s = stats.get(id);
      if (s) s.activeThisWeek = authors.size;
    }

    return stats;
  }

  // --- governance audit log + lifecycle notifications ---

  /**
   * Writes one `community_governance_log` entry. Best-effort: a logging
   * failure must never roll back the action it describes or surface to the
   * caller as a failed request — mirrors this module's existing posture on
   * notification failures (see `notifyStaffOfJoinRequest`).
   */
  private async logGovernanceAction(
    communityId: string,
    actorUserId: string | null,
    action: GovernanceLogAction,
    targetUserId?: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId,
        action,
        targetUserId,
        metadata,
      });
    } catch (error) {
      this.logger.error(
        `Failed to write governance log (${action}) for community ${communityId}: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /**
   * The owner + every mod on the roster, deduped and null-filtered — the
   * recipient set for staff-scoped notifications (join requests, freeze/
   * unfreeze). `Community.ownerId` can be null for an ownerless (post-
   * erasure, pre-promotion) community.
   */
  private async staffRecipientIds(community: Community): Promise<string[]> {
    const staff = await this.members.find({
      where: {
        communityId: community.id,
        role: In([RosterRole.Owner, RosterRole.Mod]),
      },
      select: { userId: true },
    });
    return [
      ...new Set(
        [community.ownerId, ...staff.map((row) => row.userId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
  }

  /** Best-effort "your role changed" notification for `setMemberRole`. */
  private async notifyRoleChanged(
    community: Community,
    actorId: string,
    targetUserId: string,
    fromRole: RosterRole,
    toRole: RosterRole,
  ): Promise<void> {
    try {
      await this.notifications.create(
        targetUserId,
        NotificationType.CommunityRoleChanged,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
          fromRole,
          toRole,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the role change already committed.
    }
  }

  /** Best-effort "you were removed" notification for `removeMember` (never
   *  sent for a self-leave — see the caller). */
  private async notifyMemberRemoved(
    community: Community,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        targetUserId,
        NotificationType.CommunityMemberRemoved,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the removal already committed.
    }
  }

  /**
   * Two best-effort notifications for `transferOwnership`: one to the
   * incoming owner ("you are now owner"), one to the outgoing owner
   * ("ownership was transferred"), each own try/catch so one send failing
   * never suppresses the other.
   */
  private async notifyOwnershipTransferred(
    community: Community,
    fromOwnerId: string,
    toOwnerId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        toOwnerId,
        NotificationType.CommunityOwnershipTransferred,
        {
          actorId: fromOwnerId,
          source: 'community',
          communitySlug: community.slug,
          youAreNowOwner: true,
          counterpartId: fromOwnerId,
        },
        fromOwnerId,
      );
    } catch {
      // Intentionally ignored — best-effort; the transfer already committed.
    }
    try {
      await this.notifications.create(
        fromOwnerId,
        NotificationType.CommunityOwnershipTransferred,
        {
          actorId: fromOwnerId,
          source: 'community',
          communitySlug: community.slug,
          youAreNowOwner: false,
          counterpartId: toOwnerId,
        },
        fromOwnerId,
      );
    } catch {
      // Intentionally ignored — best-effort; the transfer already committed.
    }
  }

  /** Best-effort "this community was archived" fan-out to the whole roster,
   *  for `archive`. Batched via `createForRecipients`, not row-by-row. */
  private async notifyRosterArchived(
    community: Community,
    actorId: string,
  ): Promise<void> {
    try {
      const rosterRows = await this.members.find({
        where: { communityId: community.id },
        select: { userId: true },
      });
      const recipientIds = rosterRows.map((row) => row.userId);
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunityArchived,
        { actorId, source: 'community', communitySlug: community.slug },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the archive already committed.
    }
  }

  /**
   * Best-effort freeze/unfreeze notification, scoped to staff only (owner +
   * mods) — operational, matching `notifyStaffOfJoinRequest`'s scope, not the
   * whole-roster fan-out `notifyRosterArchived` does.
   */
  private async notifyStaffFreezeChange(
    community: Community,
    type: NotificationType.CommunityFrozen | NotificationType.CommunityUnfrozen,
    actorId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const recipientIds = await this.staffRecipientIds(community);
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        type,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
          ...metadata,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the freeze/unfreeze already committed.
    }
  }

  /**
   * Best-effort "you were invited" fan-out for `create`'s resolved `invites`.
   * NOT a roster add — see `seedExtraRoster`'s "no consent-less roster adds"
   * note. Runs after the create transaction has committed (notification
   * writes aren't part of it), so a failure here can never roll back a
   * successful community creation.
   */
  private async notifyInvitees(
    community: Community,
    inviterId: string,
    invitedUserIds: string[],
  ): Promise<void> {
    if (!invitedUserIds.length) return;
    try {
      await this.notifications.createForRecipients(
        invitedUserIds,
        NotificationType.CommunityInviteReceived,
        {
          actorId: inviterId,
          source: 'community',
          communitySlug: community.slug,
        },
        inviterId,
      );
    } catch {
      // Intentionally ignored — best-effort; the community already exists.
    }
  }
}

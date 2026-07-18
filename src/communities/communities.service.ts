import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_STATS: CommunityStats = {
  memberCount: 0,
  activeThisWeek: 0,
  postsThisWeek: 0,
};

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on
// the QueryFailedError or on the wrapped driverError depending on the path.
// Mirrors `EventsService`'s identical helper (file-local there too, not
// shared/exported — kept consistent with that precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

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
  handle: string; // desired slug
  stewards?: string[]; // member slugs -> seeded as 'mod'
  invites?: string[]; // member slugs -> accepted for forward-compat, not persisted (see `seedExtraRoster`)
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

export interface CommunityListQuery {
  filter?: CommunityListFilter;
  type?: CommunityType;
  access?: AccessTier;
  page?: number;
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
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
  ) {}

  async create(
    ownerId: string,
    dto: CreateCommunityInput,
  ): Promise<CommunityDetailDTO> {
    const saved = await this.createWithUniqueRef(ownerId, dto);

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
  ): Promise<Community> {
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

          await this.seedExtraRoster(
            manager.getRepository(Profile),
            membersRepo,
            community.id,
            ownerId,
            dto.stewards ?? [],
            dto.invites ?? [],
          );

          return community;
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

    qb.orderBy('c.created_at', 'DESC');

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

  async getBySlug(slug: string, viewerId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);
    // Private + non-member -> 404, not 403, so existence isn't leaked.
    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }
    return this.buildDetail(community, viewerId, role);
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
    });

    const saved = await this.communities.save(community);
    return this.buildDetail(saved, userId);
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

    if (community.accessTier === AccessTier.Public) {
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

    // request | invite | private -> pending, gated by listJoinRequests /
    // triageJoinRequest. The partial-unique index on
    // (community_id, user_id) WHERE status='pending' is the real backstop
    // against a double-request race; a hit surfaces here as 23505.
    try {
      const saved = await this.joinRequests.save(
        this.joinRequests.create({
          communityId: community.id,
          userId,
          note: dto.note ?? null,
        }),
      );
      const memberRef = await this.memberRefFor(userId);
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
  async roster(slug: string, viewerId: string): Promise<RosterEntryDTO[]> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);

    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }

    if (!community.rosterVisible && !role) {
      throw new ForbiddenException('Roster is private to members');
    }

    const rows = await this.members.find({
      where: { communityId: community.id },
      order: { joinedAt: 'ASC' },
    });
    if (!rows.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((m) => m.userId),
    );
    return rows
      .filter((m) => refs.has(m.userId))
      .map((m) => toRosterEntry(m, refs.get(m.userId)!));
  }

  // Also NOT block/mute filtered, for a stronger reason than `roster` above:
  // this is a moderation queue, not a feed. Silently hiding a join request
  // because the reviewing mod happens to have blocked (or muted) the applicant
  // would strand that request as permanently pending, with no one aware it
  // exists — a block by one mod would become an invisible, unaccountable veto.
  // A mod who cannot fairly triage a specific applicant should recuse
  // themselves; the queue must still show the work.
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

    const saved = await this.dataSource.transaction(async (manager) => {
      const joinRequestsRepo = manager.getRepository(CommunityJoinRequest);
      const membersRepo = manager.getRepository(CommunityMember);

      request.status =
        action === 'approve'
          ? JoinRequestStatus.Approved
          : JoinRequestStatus.Declined;
      const updated = await joinRequestsRepo.save(request);

      if (action === 'approve') {
        // Idempotent upsert: approving an already-approved request (or one
        // whose applicant is somehow already a member) must not 500 on the
        // roster's unique constraint.
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

      return updated;
    });

    const memberRef = await this.memberRefFor(saved.userId);
    return toJoinRequestDTO(saved, memberRef);
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
      .orderBy('m.joined_at', 'DESC')
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
      targetMembership.role = role;
      await this.members.save(targetMembership);
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

  private async seedExtraRoster(
    profilesRepo: Repository<Profile>,
    membersRepo: Repository<CommunityMember>,
    communityId: string,
    ownerId: string,
    stewards: string[],
    invites: string[],
  ): Promise<void> {
    const slugs = [...stewards, ...invites];
    if (!slugs.length) return;

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
    // invites: no CommunityInvite/accept entity exists yet — accepted for
    // forward-compat but intentionally not persisted (force-adding members
    // without consent is unsafe). See phase-A hand-back.
    // The slugs are still resolved above (batched into the same lookup query
    // as `stewards`, so this costs nothing extra) purely so an unknown/typo'd
    // invite slug doesn't silently behave differently from a valid one; the
    // resolved ids are deliberately never turned into `CommunityMember` rows.

    if (rows.length) {
      await membersRepo.save(rows);
    }
  }

  private async buildDetail(
    community: Community,
    viewerId: string,
    myRole?: RosterRole | null,
  ): Promise<CommunityDetailDTO> {
    const [role, stats, ownerProfile, myJoinRequest] = await Promise.all([
      myRole !== undefined
        ? Promise.resolve(myRole)
        : this.myRole(community.id, viewerId),
      this.statsFor(community.id),
      this.profiles.findOne({ where: { userId: community.ownerId } }),
      this.joinRequests.findOne({
        where: { communityId: community.id, userId: viewerId },
        order: { createdAt: 'DESC' },
      }),
    ]);
    return toCommunityDetail(
      community,
      stats,
      role,
      toMemberRef(ownerProfile),
      myJoinRequest?.status ?? null,
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
}

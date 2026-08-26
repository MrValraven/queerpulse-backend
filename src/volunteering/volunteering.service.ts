import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PartnersService } from '../partners/partners.service';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityRef,
  MyOpportunitySummary,
  OpportunityCardDTO,
  OpportunityDetailDTO,
  PartnerRef,
  toMyOpportunitySummary,
  toOpportunityCard,
  toOpportunityDetail,
  toVolunteerSignup,
  VolunteerSignupDTO,
} from './opportunity-response';
import { VolunteerOpportunityTeam } from './entities/volunteer-opportunity-team.entity';
import {
  SignupStatus,
  VolunteerSignup,
} from './entities/volunteer-signup.entity';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  OpportunityCommitment,
  OpportunityDetailBody,
  OpportunityStatus,
  OpportunityTask,
  VolunteerOpportunity,
} from './entities/volunteer-opportunity.entity';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `JobsService`'s identical file-local helper (not shared/exported, kept
// consistent with that precedent).
export interface CreateOpportunityInput {
  org: string;
  // Resolved to `partner_id` via `PartnersService.idBySlug` — see
  // `resolvePartnerId`/`createWithUniqueSlug`. `null` when absent or when the
  // slug doesn't resolve to any partner (any `status` counts as a match; see
  // `PartnersService.idBySlug`).
  partnerSlug?: string;
  // Resolved to `community_id` via
  // `CommunityMembershipService.assertMemberBySlug` — see
  // `resolveCommunityId`. Unlike `partnerSlug`, an unknown/non-member slug
  // throws (404/403) rather than resolving to `null`.
  communitySlug?: string;
  role: string;
  cause: OpportunityCause;
  commit: OpportunityCommitLevel;
  time: string;
  location: string;
  skills?: string[];
  desc: string;
  spotsTotal: number;
  applyRole: string;
  why?: string[];
  tasks?: OpportunityTask[];
  commitments?: OpportunityCommitment[];
  goodFor?: string[];
  teamIntro?: string;
  team?: string[]; // member slugs -> seeded as `volunteer_opportunity_team` rows
  handle?: string; // desired slug; defaults from `role`+`org`
}

// `handle`/`team` only ever apply at creation time — a slug never changes
// post-creation and team membership isn't re-seeded on PATCH (mirrors
// `UpdateCompanyInput`/`UpdateJobInput`'s identical "ignored on patch"
// precedent). `partnerSlug`/`communitySlug` are NOT in that list: re-linking
// an opportunity to a different (or no) organization is a legitimate PATCH,
// unlike a slug or a team roster.
export type UpdateOpportunityInput = Partial<
  Omit<CreateOpportunityInput, 'handle' | 'team'>
>;

export interface OpportunityListQuery {
  cause?: OpportunityCause;
  commit?: OpportunityCommitLevel;
  page?: number;
}

export interface CreateSignupInput {
  note?: string;
}

/** Fills every `OpportunityDetailBody` subfield so the `jsonb NOT NULL`
 * `detail` column is always fully populated, even when a caller only
 * supplies part of it (or omits it entirely at creation). Mirrors
 * `JobsService`'s `normalizeDetail`. */
function normalizeDetail(dto: {
  why?: string[];
  tasks?: OpportunityTask[];
  commitments?: OpportunityCommitment[];
  goodFor?: string[];
  teamIntro?: string;
}): OpportunityDetailBody {
  return {
    why: dto.why ?? [],
    tasks: dto.tasks ?? [],
    commitments: dto.commitments ?? [],
    goodFor: dto.goodFor ?? [],
    teamIntro: dto.teamIntro ?? null,
  };
}

@Injectable()
export class VolunteeringService {
  constructor(
    @InjectRepository(VolunteerOpportunity)
    private readonly opportunities: Repository<VolunteerOpportunity>,
    @InjectRepository(VolunteerOpportunityTeam)
    private readonly team: Repository<VolunteerOpportunityTeam>,
    @InjectRepository(VolunteerSignup)
    private readonly signups: Repository<VolunteerSignup>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly partnersService: PartnersService,
    private readonly communityMembership: CommunityMembershipService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    posterId: string,
    dto: CreateOpportunityInput,
  ): Promise<OpportunityDetailDTO> {
    const saved = await this.createWithUniqueSlug(posterId, dto);
    return this.buildDetail(saved, posterId);
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // create landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505, which
  // aborts the whole transaction, forcing a retry with a freshly recomputed
  // slug (mirrors `CompaniesService.createWithUniqueSlug`).
  private async createWithUniqueSlug(
    posterId: string,
    dto: CreateOpportunityInput,
  ): Promise<VolunteerOpportunity> {
    const MAX_ATTEMPTS = 5;
    // Resolved once, outside the retry loop — these are reads against
    // Partners/Communities, not part of the slug-race being retried below.
    const partnerId = await this.resolvePartnerId(dto.partnerSlug);
    const communityId = await this.resolveCommunityId(
      dto.communitySlug,
      posterId,
    );
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle ?? `${dto.role} ${dto.org}`, 'opportunity'),
        (s) => this.opportunities.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const opportunitiesRepo = manager.getRepository(VolunteerOpportunity);
          const teamRepo = manager.getRepository(VolunteerOpportunityTeam);

          const teamUserIds = await this.resolveTeamUserIds(
            manager.getRepository(Profile),
            dto.team ?? [],
            posterId,
          );

          const opportunity = await opportunitiesRepo.save(
            opportunitiesRepo.create({
              slug,
              org: dto.org,
              partnerId,
              communityId,
              role: dto.role,
              cause: dto.cause,
              commit: dto.commit,
              time: dto.time,
              location: dto.location,
              skills: dto.skills ?? [],
              desc: dto.desc,
              detail: normalizeDetail(dto),
              spotsTotal: dto.spotsTotal,
              applyRole: dto.applyRole,
              posterId,
              status: OpportunityStatus.Open,
            }),
          );

          if (teamUserIds.size) {
            await teamRepo.save(
              [...teamUserIds].map((userId) =>
                teamRepo.create({ opportunityId: opportunity.id, userId }),
              ),
            );
          }

          return opportunity;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry a fresh transaction
            // (the aborted one can't be resumed).
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique opportunity slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved opportunity or throws above.
    throw new ConflictException('Could not allocate a unique opportunity slug');
  }

  async list(
    query: OpportunityListQuery,
  ): Promise<Paginated<OpportunityCardDTO>> {
    const page = normalizePage(query.page);
    const qb = this.opportunities
      .createQueryBuilder('o')
      .orderBy('o.created_at', 'DESC');

    if (query.cause) {
      qb.andWhere('o.cause = :cause', { cause: query.cause });
    }
    if (query.commit) {
      qb.andWhere('o.commit = :commit', { commit: query.commit });
    }

    return paginate(qb, page, async (rows) => {
      if (!rows.length) return [];
      const [filled, partnerRefs, communityRefs] = await Promise.all([
        this.spotsFilledForMany(rows.map((o) => o.id)),
        this.partnerRefsForMany(rows.map((o) => o.partnerId)),
        this.communityRefsForMany(rows.map((o) => o.communityId)),
      ]);
      return rows.map((o) =>
        toOpportunityCard(
          o,
          o.partnerId ? (partnerRefs.get(o.partnerId) ?? null) : null,
          o.communityId ? (communityRefs.get(o.communityId) ?? null) : null,
          filled.get(o.id) ?? 0,
        ),
      );
    });
  }

  async getBySlug(
    slug: string,
    viewerId: string,
  ): Promise<OpportunityDetailDTO> {
    const opportunity = await this.loadOr404(slug);
    return this.buildDetail(opportunity, viewerId);
  }

  async update(
    slug: string,
    posterId: string,
    dto: UpdateOpportunityInput,
  ): Promise<OpportunityDetailDTO> {
    const opportunity = await this.loadOr404(slug);
    if (opportunity.posterId !== posterId) {
      throw new ForbiddenException(
        'Only the poster can update this opportunity',
      );
    }

    Object.assign(opportunity, {
      ...(dto.org !== undefined ? { org: dto.org } : {}),
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.cause !== undefined ? { cause: dto.cause } : {}),
      ...(dto.commit !== undefined ? { commit: dto.commit } : {}),
      ...(dto.time !== undefined ? { time: dto.time } : {}),
      ...(dto.location !== undefined ? { location: dto.location } : {}),
      ...(dto.skills !== undefined ? { skills: dto.skills } : {}),
      ...(dto.desc !== undefined ? { desc: dto.desc } : {}),
      ...(dto.spotsTotal !== undefined ? { spotsTotal: dto.spotsTotal } : {}),
      ...(dto.applyRole !== undefined ? { applyRole: dto.applyRole } : {}),
    });

    // Unlike `handle`/`team`, `partnerSlug` IS a legitimate PATCH field — see
    // `UpdateOpportunityInput`'s comment. Absent (`undefined`) leaves the
    // existing link untouched; present (even `''`/unknown) re-resolves it,
    // including clearing it back to `null` for an unknown slug.
    if (dto.partnerSlug !== undefined) {
      opportunity.partnerId = await this.resolvePartnerId(dto.partnerSlug);
    }

    // Same "absent leaves it, present re-resolves/clears it" semantics as
    // `partnerSlug` above, via `resolveCommunityId` instead.
    if (dto.communitySlug !== undefined) {
      opportunity.communityId = await this.resolveCommunityId(
        dto.communitySlug,
        posterId,
      );
    }

    // `why`/`tasks`/`commitments`/`goodFor`/`teamIntro` are flat fields on
    // `CreateOpportunityDto` (unlike Jobs' single nested `detail` object), so
    // each patches its own `detail` subfield independently rather than
    // requiring/replacing the whole jsonb blob.
    if (
      dto.why !== undefined ||
      dto.tasks !== undefined ||
      dto.commitments !== undefined ||
      dto.goodFor !== undefined ||
      dto.teamIntro !== undefined
    ) {
      opportunity.detail = {
        why: dto.why ?? opportunity.detail.why,
        tasks: dto.tasks ?? opportunity.detail.tasks,
        commitments: dto.commitments ?? opportunity.detail.commitments,
        goodFor: dto.goodFor ?? opportunity.detail.goodFor,
        teamIntro:
          dto.teamIntro !== undefined
            ? dto.teamIntro
            : opportunity.detail.teamIntro,
      };
    }

    const saved = await this.opportunities.save(opportunity);
    return this.buildDetail(saved, posterId);
  }

  // Idempotent: re-closing an already-closed opportunity just re-saves the
  // same status (mirrors `JobsService.close`'s identical terminal-state
  // precedent).
  async close(slug: string, posterId: string): Promise<OpportunityDetailDTO> {
    const opportunity = await this.loadOr404(slug);
    if (opportunity.posterId !== posterId) {
      throw new ForbiddenException(
        'Only the poster can close this opportunity',
      );
    }
    opportunity.status = OpportunityStatus.Closed;
    const saved = await this.opportunities.save(opportunity);
    return this.buildDetail(saved, posterId);
  }

  // Capacity is scoped to ACCEPTED signups only — a pile of pending
  // applications never blocks new applicants, only confirmed volunteers do.
  // Uniqueness is still enforced inside the same pessimistic-write-locked
  // transaction (mirrors the prior version), but a `declined` row for this
  // (opportunity, user) pair is reactivated in place rather than rejected —
  // see the design's "reapply after decline" decision — since the UNIQUE
  // constraint on (opportunity_id, user_id) forbids a second row either way.
  async signup(
    slug: string,
    userId: string,
    dto: CreateSignupInput,
  ): Promise<VolunteerSignupDTO> {
    // Null both before the transaction resolves it and when the poster has
    // erased their account
    // (`SetNullContentAuthorFksOnUserErasure1794610000000`): the opportunity
    // outlives them, so a signup still records, it just notifies nobody.
    let posterId: string | null = null;
    const saved = await this.dataSource.transaction(async (manager) => {
      const opportunity = await manager.findOne(VolunteerOpportunity, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!opportunity) {
        throw new NotFoundException('Opportunity not found');
      }
      posterId = opportunity.posterId;
      if (posterId !== null && posterId === userId) {
        throw new ForbiddenException(
          'You cannot apply to your own opportunity',
        );
      }

      const signupRepo = manager.getRepository(VolunteerSignup);
      const acceptedCount = await signupRepo.count({
        where: { opportunityId: opportunity.id, status: SignupStatus.Accepted },
      });
      if (acceptedCount >= opportunity.spotsTotal) {
        throw new ConflictException('This opportunity is at capacity');
      }

      const existing = await signupRepo.findOne({
        where: { opportunityId: opportunity.id, userId },
      });
      if (existing) {
        if (existing.status !== SignupStatus.Declined) {
          throw new ConflictException(
            'You have already signed up for this opportunity',
          );
        }
        existing.note = dto.note ?? null;
        existing.status = SignupStatus.Pending;
        existing.decidedAt = null;
        return signupRepo.save(existing);
      }

      try {
        return await signupRepo.save(
          signupRepo.create({
            opportunityId: opportunity.id,
            userId,
            note: dto.note ?? null,
            status: SignupStatus.Pending,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'You have already signed up for this opportunity',
          );
        }
        throw err;
      }
    });

    const member = await this.memberRefFor(userId);

    // Best-effort: the signup already committed above, so a notification
    // failure must never surface as a failed signup (mirrors
    // `CommunitiesService.triageJoinRequest`'s identical try/catch-swallow).
    try {
      if (posterId !== null) {
        await this.notifications.create(
          posterId,
          NotificationType.VolunteerApplicationReceived,
          { source: 'volunteering', opportunitySlug: slug },
          userId,
        );
      }
    } catch {
      // Intentionally ignored.
    }

    return toVolunteerSignup(saved, member);
  }

  // Idempotent delete: withdrawing when there's no signup is a no-op, not a
  // 404 (mirrors the "self" guard's semantics — there's nothing distinct to
  // report either way from the caller's perspective).
  async withdraw(slug: string, userId: string): Promise<void> {
    const opportunity = await this.loadOr404(slug);
    await this.signups.delete({ opportunityId: opportunity.id, userId });
  }

  async listSignups(
    slug: string,
    viewerId: string,
  ): Promise<VolunteerSignupDTO[]> {
    const opportunity = await this.loadOr404(slug);
    await this.assertCanManageApplicants(
      opportunity,
      viewerId,
      'view signups for',
    );

    // Bounded: a popular posting can carry thousands of signups, each with a
    // full `answers` jsonb blob, and this had no `take` at all.
    const rows = await this.signups.find({
      where: { opportunityId: opportunity.id },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((s) => s.userId),
    );
    return rows.map((s) => toVolunteerSignup(s, refs.get(s.userId) ?? null));
  }

  // Mirrors `CommunitiesService.triageJoinRequest`'s atomic conditional-claim
  // UPDATE: the pre-check above is a fast-path, but only the guarded
  // `status = 'pending'` WHERE clause actually closes the race between two
  // concurrent decisions (or a double-decide) on the same signup.
  async decideSignup(
    slug: string,
    signupId: string,
    deciderId: string,
    status: SignupStatus.Accepted | SignupStatus.Declined,
  ): Promise<VolunteerSignupDTO> {
    const opportunity = await this.loadOr404(slug);
    await this.assertCanManageApplicants(
      opportunity,
      deciderId,
      'decide on applicants for',
    );

    const signup = await this.signups.findOne({
      where: { id: signupId, opportunityId: opportunity.id },
    });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }
    if (signup.status !== SignupStatus.Pending) {
      throw new ConflictException('This application was already decided');
    }

    const decidedAt = new Date();
    const claim = await this.signups
      .createQueryBuilder()
      .update(VolunteerSignup)
      .set({ status, decidedAt })
      .where('id = :id AND status = :pending', {
        id: signup.id,
        pending: SignupStatus.Pending,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('This application was already decided');
    }
    signup.status = status;
    signup.decidedAt = decidedAt;

    const member = await this.memberRefFor(signup.userId);

    try {
      await this.notifications.create(
        signup.userId,
        NotificationType.VolunteerApplicationDecided,
        { source: 'volunteering', opportunitySlug: slug, status },
      );
    } catch {
      // Intentionally ignored — the decision already committed.
    }

    return toVolunteerSignup(signup, member);
  }

  /**
   * The viewer's manage-applicants desk: everything they posted themselves,
   * PLUS everything attributed to a community they own or moderate. The
   * community tier mirrors how the attribution got there in the first place
   * (`resolveCommunityId` only accepts an owner/mod), so a community's
   * standing roster can review its own applicants without the original
   * poster becoming a single point of failure. Editing and closing stay
   * poster-only.
   */
  async listMine(userId: string): Promise<MyOpportunitySummary[]> {
    const managedCommunityIds =
      await this.communityMembership.ownerOrModCommunityIdsForUser(userId);
    // `In([])` is not a safe empty-set predicate, so the community branch is
    // only added when the viewer actually has standing somewhere.
    const where: FindOptionsWhere<VolunteerOpportunity>[] = [
      { posterId: userId },
      ...(managedCommunityIds.length
        ? [{ communityId: In(managedCommunityIds) }]
        : []),
    ];
    const rows = await this.opportunities.find({
      where,
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];

    const counts = await this.signups
      .createQueryBuilder('s')
      .select('s.opportunity_id', 'opportunityId')
      .addSelect('s.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('s.opportunity_id IN (:...ids)', { ids: rows.map((o) => o.id) })
      .groupBy('s.opportunity_id')
      .addGroupBy('s.status')
      .getRawMany<{
        opportunityId: string;
        status: SignupStatus;
        count: string;
      }>();

    const pendingByOpp = new Map<string, number>();
    const acceptedByOpp = new Map<string, number>();
    for (const row of counts) {
      const n = Number(row.count);
      if (row.status === SignupStatus.Pending)
        pendingByOpp.set(row.opportunityId, n);
      if (row.status === SignupStatus.Accepted)
        acceptedByOpp.set(row.opportunityId, n);
    }

    return rows.map((o) =>
      toMyOpportunitySummary(
        o,
        pendingByOpp.get(o.id) ?? 0,
        acceptedByOpp.get(o.id) ?? 0,
      ),
    );
  }

  /**
   * `GET /communities/:slug/pulse`'s opportunities lane — a community's own
   * still-open opportunities (status `open` AND not yet at capacity),
   * newest-first. "Open" alone isn't enough: a filled-but-not-yet-closed
   * opportunity (the poster hasn't called `close()`) shouldn't read as
   * something a member can still sign up for, so the capacity check is
   * folded into the query itself (a correlated subquery over
   * `volunteer_signups`, mirroring `EventsService.excludeModeratedEvents`'s
   * `NOT EXISTS`-style in-query filtering) rather than fetched then
   * post-filtered in JS. Card shaping (`toOpportunityCard`) reuses the same
   * batched partner/community-ref + spots-filled lookups `list()` already
   * does for a page of cards.
   */
  async listOpenByCommunity(
    communityId: string,
    limit = 5,
  ): Promise<OpportunityCardDTO[]> {
    const rows = await this.opportunities
      .createQueryBuilder('o')
      .where('o.community_id = :communityId', { communityId })
      .andWhere('o.status = :status', { status: OpportunityStatus.Open })
      .andWhere(
        `(SELECT COUNT(*) FROM "volunteer_signups" "s" WHERE "s"."opportunity_id" = "o"."id" AND "s"."status" = 'accepted') < "o"."spots_total"`,
      )
      .orderBy('o.created_at', 'DESC')
      .take(limit)
      .getMany();
    if (!rows.length) return [];

    const [filled, partnerRefs, communityRefs] = await Promise.all([
      this.spotsFilledForMany(rows.map((o) => o.id)),
      this.partnerRefsForMany(rows.map((o) => o.partnerId)),
      this.communityRefsForMany(rows.map((o) => o.communityId)),
    ]);
    return rows.map((o) =>
      toOpportunityCard(
        o,
        o.partnerId ? (partnerRefs.get(o.partnerId) ?? null) : null,
        o.communityId ? (communityRefs.get(o.communityId) ?? null) : null,
        filled.get(o.id) ?? 0,
      ),
    );
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<VolunteerOpportunity> {
    const opportunity = await this.opportunities.findOne({ where: { slug } });
    if (!opportunity) {
      throw new NotFoundException('Opportunity not found');
    }
    return opportunity;
  }

  // Resolves a single userId to a MemberRef for an actor who just
  // created/owns a row (a miss here would mean a data-integrity bug — an
  // authenticated member without a profile — not a legitimate empty state).
  // Mirrors `CompaniesService.memberRefFor`/`JobsService.memberRefFor`.
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async resolveTeamUserIds(
    profilesRepo: Repository<Profile>,
    slugs: string[],
    posterId: string,
  ): Promise<Set<string>> {
    if (!slugs.length) return new Set();

    const lookup = new MemberLookup(profilesRepo);
    const idBySlug = await lookup.userIdsForSlugs(slugs);
    const seen = new Set<string>([posterId]);
    const result = new Set<string>();

    for (const s of slugs) {
      const uid = idBySlug.get(s);
      if (uid && !seen.has(uid)) {
        seen.add(uid);
        result.add(uid);
      }
    }
    return result;
  }

  private async buildDetail(
    opportunity: VolunteerOpportunity,
    viewerId: string,
  ): Promise<OpportunityDetailDTO> {
    const [
      spotsFilled,
      teamRows,
      posterProfile,
      mySignup,
      partnerRefs,
      communityRefs,
    ] = await Promise.all([
      this.spotsFilledFor(opportunity.id),
      this.team.find({ where: { opportunityId: opportunity.id } }),
      opportunity.posterId === null
        ? null
        : this.profiles.findOne({ where: { userId: opportunity.posterId } }),
      this.signups.exists({
        where: {
          opportunityId: opportunity.id,
          userId: viewerId,
          status: In([SignupStatus.Pending, SignupStatus.Accepted]),
        },
      }),
      this.partnerRefsForMany([opportunity.partnerId]),
      this.communityRefsForMany([opportunity.communityId]),
    ]);

    const teamRefs = teamRows.length
      ? await new MemberLookup(this.profiles).byUserIds(
          teamRows.map((t) => t.userId),
        )
      : new Map<string, MemberRef>();
    const team = teamRows
      .map((t) => teamRefs.get(t.userId))
      .filter((ref): ref is MemberRef => !!ref);

    const partner = opportunity.partnerId
      ? (partnerRefs.get(opportunity.partnerId) ?? null)
      : null;
    const community = opportunity.communityId
      ? (communityRefs.get(opportunity.communityId) ?? null)
      : null;

    return toOpportunityDetail(
      opportunity,
      partner,
      community,
      spotsFilled,
      team,
      toMemberRef(posterProfile),
      opportunity.posterId === viewerId,
      mySignup,
    );
  }

  /** Resolves a `partnerSlug` to a `partner_id`, treating an absent or
   * unknown slug identically as `null` (`PartnersService.idBySlug` itself
   * never throws — see its doc comment on why "any status" counts as a
   * match). */
  private async resolvePartnerId(slug?: string): Promise<string | null> {
    if (!slug) return null;
    return this.partnersService.idBySlug(slug);
  }

  /**
   * Batches `partnerId -> {slug,name}` resolution through
   * `PartnersService.refsByIds` (mirrors `spotsFilledForMany`'s "one query
   * for the whole page/id-set" shape), deduping and dropping `null`s first so
   * a page of cards with no partner links never even calls out to Partners.
   */
  private async partnerRefsForMany(
    partnerIds: (string | null)[],
  ): Promise<Map<string, PartnerRef>> {
    const ids = [...new Set(partnerIds.filter((id): id is string => !!id))];
    if (!ids.length) return new Map();
    return this.partnersService.refsByIds(ids);
  }

  /**
   * The applicant-review tier: the poster, or anyone with standing (owner,
   * co-owner, mod) in the community the opportunity is attributed to. Shared
   * by the signups roster and the accept/decline decision so the two can
   * never drift. `action` completes the 403 message ("Only the poster or a
   * community organiser can <action> this opportunity").
   */
  private async assertCanManageApplicants(
    opportunity: VolunteerOpportunity,
    userId: string,
    action: string,
  ): Promise<void> {
    if (opportunity.posterId === userId) return;
    if (
      opportunity.communityId &&
      (await this.communityMembership.isOwnerOrMod(
        opportunity.communityId,
        userId,
      ))
    ) {
      return;
    }
    throw new ForbiddenException(
      `Only the poster or a community organiser can ${action} this opportunity`,
    );
  }

  /** Resolves a `communitySlug` to a `community_id`, asserting the given
   * user owns or moderates that community (see
   * `CommunityMembershipService.assertOwnerOrModBySlug` — unknown slug 404s,
   * non-owner/mod 403s). Attributing an opportunity to a community is
   * speaking for it, so plain membership isn't enough. Absent/empty slug
   * resolves to `null`, same "clears the link" convention as
   * `resolvePartnerId`. */
  private async resolveCommunityId(
    slug: string | undefined,
    userId: string,
  ): Promise<string | null> {
    if (!slug) return null;
    return this.communityMembership.assertOwnerOrModBySlug(slug, userId);
  }

  /** Batches `communityId -> {slug,name}` resolution through
   * `CommunityMembershipService.refsByIds`, mirroring
   * `partnerRefsForMany`. */
  private async communityRefsForMany(
    communityIds: (string | null)[],
  ): Promise<Map<string, CommunityRef>> {
    const ids = [...new Set(communityIds.filter((id): id is string => !!id))];
    if (!ids.length) return new Map();
    return this.communityMembership.refsByIds(ids);
  }

  private async spotsFilledFor(opportunityId: string): Promise<number> {
    return this.signups.count({
      where: { opportunityId, status: SignupStatus.Accepted },
    });
  }

  // Grouped pattern (mirrors `CompaniesService.reviewAggregatesForMany`): one
  // query across the whole page/id-set instead of N+1 per-row counts. Scoped
  // to ACCEPTED signups — a card's "spots filled" must never count pending
  // applications as taking a spot.
  private async spotsFilledForMany(
    opportunityIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>(opportunityIds.map((id) => [id, 0]));
    if (!opportunityIds.length) return result;

    const rows = await this.signups
      .createQueryBuilder('s')
      .select('s.opportunity_id', 'opportunityId')
      .addSelect('COUNT(*)', 'count')
      .where('s.opportunity_id IN (:...ids)', { ids: opportunityIds })
      .andWhere('s.status = :status', { status: SignupStatus.Accepted })
      .groupBy('s.opportunity_id')
      .getRawMany<{ opportunityId: string; count: string }>();

    for (const row of rows) {
      result.set(row.opportunityId, Number(row.count));
    }
    return result;
  }
}

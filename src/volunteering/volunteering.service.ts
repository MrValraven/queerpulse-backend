import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { PartnersService } from '../partners/partners.service';
import { Profile } from '../users/entities/profile.entity';
import {
  OpportunityCardDTO,
  OpportunityDetailDTO,
  PartnerRef,
  toOpportunityCard,
  toOpportunityDetail,
  toVolunteerSignup,
  VolunteerSignupDTO,
} from './opportunity-response';
import { VolunteerOpportunityTeam } from './entities/volunteer-opportunity-team.entity';
import { VolunteerSignup } from './entities/volunteer-signup.entity';
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
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

export interface CreateOpportunityInput {
  org: string;
  // Resolved to `partner_id` via `PartnersService.idBySlug` — see
  // `resolvePartnerId`/`createWithUniqueSlug`. `null` when absent or when the
  // slug doesn't resolve to any partner (any `status` counts as a match; see
  // `PartnersService.idBySlug`).
  partnerSlug?: string;
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
// precedent). `partnerSlug` is NOT in that list: re-linking an opportunity to
// a different (or no) partner org is a legitimate PATCH, unlike a slug or a
// team roster.
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
    // Resolved once, outside the retry loop — it's a read against Partners,
    // not part of the slug-race being retried below.
    const partnerId = await this.resolvePartnerId(dto.partnerSlug);
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
      const [filled, partnerRefs] = await Promise.all([
        this.spotsFilledForMany(rows.map((o) => o.id)),
        this.partnerRefsForMany(rows.map((o) => o.partnerId)),
      ]);
      return rows.map((o) =>
        toOpportunityCard(
          o,
          o.partnerId ? (partnerRefs.get(o.partnerId) ?? null) : null,
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

  // Capacity + uniqueness both enforced inside one transaction with a
  // pessimistic write lock on the opportunity row (mirrors
  // `RsvpService.rsvp`'s row-lock pattern): concurrent signups against the
  // same opportunity serialize on that lock, so the count-then-insert below
  // can't oversell `spotsTotal`. The 23505 catch is a backstop for the
  // (opportunity, user) UNIQUE constraint — a double-submit from the same
  // user racing itself — not the capacity race, which the lock already
  // closes.
  async signup(
    slug: string,
    userId: string,
    dto: CreateSignupInput,
  ): Promise<VolunteerSignupDTO> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const opportunity = await manager.findOne(VolunteerOpportunity, {
        where: { slug },
        lock: { mode: 'pessimistic_write' },
      });
      if (!opportunity) {
        throw new NotFoundException('Opportunity not found');
      }

      const signupRepo = manager.getRepository(VolunteerSignup);
      const count = await signupRepo.count({
        where: { opportunityId: opportunity.id },
      });
      if (count >= opportunity.spotsTotal) {
        throw new ConflictException('This opportunity is at capacity');
      }

      try {
        return await signupRepo.save(
          signupRepo.create({
            opportunityId: opportunity.id,
            userId,
            note: dto.note ?? null,
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
    posterId: string,
  ): Promise<VolunteerSignupDTO[]> {
    const opportunity = await this.loadOr404(slug);
    if (opportunity.posterId !== posterId) {
      throw new ForbiddenException(
        'Only the poster can view signups for this opportunity',
      );
    }

    const rows = await this.signups.find({
      where: { opportunityId: opportunity.id },
      order: { createdAt: 'DESC' },
    });
    if (!rows.length) return [];

    const refs = await new MemberLookup(this.profiles).byUserIds(
      rows.map((s) => s.userId),
    );
    return rows.map((s) => toVolunteerSignup(s, refs.get(s.userId) ?? null));
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
    const [spotsFilled, teamRows, posterProfile, mySignup, partnerRefs] =
      await Promise.all([
        this.spotsFilledFor(opportunity.id),
        this.team.find({ where: { opportunityId: opportunity.id } }),
        this.profiles.findOne({ where: { userId: opportunity.posterId } }),
        this.signups.exists({
          where: { opportunityId: opportunity.id, userId: viewerId },
        }),
        this.partnerRefsForMany([opportunity.partnerId]),
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

    return toOpportunityDetail(
      opportunity,
      partner,
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

  private async spotsFilledFor(opportunityId: string): Promise<number> {
    return this.signups.count({ where: { opportunityId } });
  }

  // Grouped pattern (mirrors `CompaniesService.reviewAggregatesForMany`): one
  // query across the whole page/id-set instead of N+1 per-row counts.
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
      .groupBy('s.opportunity_id')
      .getRawMany<{ opportunityId: string; count: string }>();

    for (const row of rows) {
      result.set(row.opportunityId, Number(row.count));
    }
    return result;
  }
}

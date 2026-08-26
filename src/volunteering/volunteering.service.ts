import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  DataSource,
  FindOptionsWhere,
  In,
  IsNull,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
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
  MyVolunteerContributionDTO,
  VolunteerHoursByCommunityDTO,
  VolunteerHoursByOpportunityDTO,
  VolunteerHoursTotalsDTO,
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
  VOLUNTEER_SESSION_COMPLETED,
  VolunteerSessionCompletedEvent,
} from './volunteering.events';
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

/** `confirmCompletion`'s input. See `CompleteSignupDto` for the validation
 *  that bounds `hours` to a single day at the request boundary. */
export interface CompleteSignupInput {
  attended: boolean;
  hours: number;
}

/** `volunteerHoursTotals`'s window and optional community scope. Both `from`
 *  and `to` are optional; omitting both reports over all time. */
export interface VolunteerHoursQuery {
  from?: Date;
  to?: Date;
  communityId?: string;
}

/** Hard ceiling on one confirmed session, mirroring `CompleteSignupDto`'s
 *  `@Max(24)` and the `CK_volunteer_signups_hours_range` CHECK. Repeated here
 *  so the service refuses an out-of-range value even when a caller bypasses
 *  the request pipe (a future admin console calling the service directly). */
const MAX_SESSION_HOURS = 24;

/** How many rows the per-opportunity / per-community breakdowns return. The
 *  platform totals are exact regardless; only the breakdown lists are cut. */
export const HOURS_BREAKDOWN_LIMIT = 100;

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
    // Fires `VOLUNTEER_SESSION_COMPLETED` once a session is confirmed, which
    // `RecognitionListener` consumes so contribution finally earns XP. Same
    // fire-and-forget, post-commit `emit` idiom as `EVENT_RSVPED` in
    // `RsvpService`; one-way, nothing in recognition calls back into here.
    private readonly eventEmitter: EventEmitter2,
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
   * THE COMPLETION STEP (SUS-05). The poster (or a community organiser
   * standing in for them) attests that an accepted volunteer turned up, and
   * for how long.
   *
   * Four properties, each of them load-bearing:
   *
   *   1. **Only an accepted signup can be completed.** A pending application
   *      is not a session and a declined one never happened. Enforced in the
   *      claiming UPDATE's WHERE clause, not only in the pre-check.
   *   2. **Only the review tier may confirm.** `assertCanManageApplicants` is
   *      the same authority that accepted the applicant in the first place:
   *      the poster, or an owner/co-owner/mod of the community the
   *      opportunity is attributed to. Hours are therefore attested by
   *      someone other than the person who earns recognition for them.
   *   3. **Idempotent.** `AND completed_at IS NULL` in the guarded UPDATE is
   *      what makes it so, exactly as `decideSignup`'s `AND status =
   *      'pending'` closes its own double-decide race. A second confirmation
   *      affects zero rows, 409s, and emits nothing, so nothing downstream
   *      double-counts.
   *   4. **Bounded hours.** Rejected above `MAX_SESSION_HOURS` here as well as
   *      by `CompleteSignupDto` and by the CHECK constraint, so a caller that
   *      skips the request pipe still cannot write a number a funder would be
   *      shown.
   *
   * A no-show (`attended: false`) is recorded with zero hours rather than
   * refused: it closes the signup, stops the poster being asked again, and
   * keeps the platform total honest.
   *
   * NO NOTIFICATION IS SENT TO THE VOLUNTEER. There is no notification type
   * for this and this task did not add one, so no copy anywhere may claim the
   * member will hear about it. What they do get is real: the confirmed
   * session and its hours appear on `GET /volunteering/me/contribution`, and
   * the recognition recompute this emit triggers can raise their level or
   * grant a badge, both of which notify through their own existing channels.
   */
  async confirmCompletion(
    slug: string,
    signupId: string,
    confirmerId: string,
    input: CompleteSignupInput,
  ): Promise<VolunteerSignupDTO> {
    const opportunity = await this.loadOr404(slug);
    await this.assertCanManageApplicants(
      opportunity,
      confirmerId,
      'confirm volunteer sessions for',
    );

    if (
      !Number.isFinite(input.hours) ||
      input.hours < 0 ||
      input.hours > MAX_SESSION_HOURS
    ) {
      throw new BadRequestException(
        `Hours must be between 0 and ${MAX_SESSION_HOURS}`,
      );
    }
    // A no-show contributed no hours, whatever was typed in the box.
    const hours = input.attended ? Math.round(input.hours * 100) / 100 : 0;

    const signup = await this.signups.findOne({
      where: { id: signupId, opportunityId: opportunity.id },
    });
    if (!signup) {
      throw new NotFoundException('Signup not found');
    }
    // NOBODY ATTESTS THEIR OWN HOURS. `signup()` already blocks applying to
    // your own posting, but a community organiser can apply to an opportunity
    // a co-organiser posted for that community and would otherwise pass
    // `assertCanManageApplicants` on their own row. The whole value of the
    // hours total is that someone else stood behind the number.
    if (signup.userId === confirmerId) {
      throw new ForbiddenException(
        'Someone else has to confirm your own volunteer session',
      );
    }
    if (signup.status !== SignupStatus.Accepted) {
      throw new ConflictException(
        'Only an accepted application can be confirmed as a session',
      );
    }
    if (signup.completedAt !== null) {
      throw new ConflictException('This session was already confirmed');
    }

    const completedAt = new Date();
    const claim = await this.signups
      .createQueryBuilder()
      .update(VolunteerSignup)
      .set({
        attended: input.attended,
        hoursContributed: hours,
        completedAt,
        completedById: confirmerId,
      })
      .where('id = :id AND status = :accepted AND completed_at IS NULL', {
        id: signup.id,
        accepted: SignupStatus.Accepted,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('This session was already confirmed');
    }

    signup.attended = input.attended;
    signup.hoursContributed = hours;
    signup.completedAt = completedAt;
    signup.completedById = confirmerId;

    // After the write lands (an emit before it could announce a row that never
    // committed). Fire-and-forget: `RecognitionListener` routes its recompute
    // through `safeRecompute`, so a recognition failure can never break this
    // flow, and nothing here waits on it either.
    this.eventEmitter.emit(VOLUNTEER_SESSION_COMPLETED, {
      signupId: signup.id,
      opportunityId: opportunity.id,
      opportunitySlug: opportunity.slug,
      volunteerId: signup.userId,
      confirmedById: confirmerId,
      attended: input.attended,
      hoursContributed: hours,
      completedAt: completedAt.toISOString(),
    } satisfies VolunteerSessionCompletedEvent);

    const member = await this.memberRefFor(signup.userId);
    return toVolunteerSignup(signup, member);
  }

  /**
   * What the signed-in member has actually contributed, as confirmed by
   * someone else. The only per-member volunteering read that exists, and it
   * only ever answers about the caller themselves.
   *
   * `attended = true` only: a recorded no-show is not a contribution and is
   * not reflected back at the member. `awaitingConfirmationCount` is the
   * accepted signups nobody has confirmed yet, which is what stops the
   * surface reading as "you have done nothing" while a poster is simply
   * behind on their desk.
   */
  async myContribution(userId: string): Promise<MyVolunteerContributionDTO> {
    const [totals, awaitingConfirmationCount] = await Promise.all([
      this.signups
        .createQueryBuilder('signup')
        .select('COUNT(*)', 'sessionCount')
        .addSelect('COALESCE(SUM(signup.hours_contributed), 0)', 'hours')
        .addSelect('MAX(signup.completed_at)', 'lastCompletedAt')
        .where('signup.user_id = :userId', { userId })
        .andWhere('signup.completed_at IS NOT NULL')
        .andWhere('signup.attended = true')
        .getRawOne<{
          sessionCount: string;
          hours: string;
          lastCompletedAt: Date | null;
        }>(),
      this.signups.count({
        where: {
          userId,
          status: SignupStatus.Accepted,
          completedAt: IsNull(),
        },
      }),
    ]);

    return {
      sessionCount: Number(totals?.sessionCount ?? 0),
      hoursContributed: Number(totals?.hours ?? 0),
      lastCompletedAt: totals?.lastCompletedAt
        ? new Date(totals.lastCompletedAt).toISOString()
        : null,
      awaitingConfirmationCount,
    };
  }

  /**
   * THE FUNDER ANSWER: confirmed volunteer hours over a period, platform-wide
   * and split per opportunity and per community.
   *
   * No endpoint calls this yet by design. It is the read an admin oversight
   * console sits on, written now so the console has something real to call
   * rather than inventing a second definition of "a volunteer hour" that
   * would drift from the one recognition rewards. Whoever exposes it must put
   * it behind an `Admin*Controller` with `@Roles(UserRole.Moderator,
   * UserRole.Admin)`.
   *
   * Scope discipline, deliberately: every number here is an aggregate
   * operational count. Sessions, hours and a DISTINCT count of how many
   * people contributed. There is no per-member row, no ranking and no
   * timeline, because "which member volunteered how much" is not an
   * operational count and nobody has asked for it.
   *
   * Only `attended = true` rows count, so a recorded no-show never inflates a
   * number a partner is shown.
   */
  async volunteerHoursTotals(
    query: VolunteerHoursQuery = {},
  ): Promise<VolunteerHoursTotalsDTO> {
    const applyWindow = <T extends SelectQueryBuilder<VolunteerSignup>>(
      qb: T,
    ): T => {
      qb.where('signup.completed_at IS NOT NULL').andWhere(
        'signup.attended = true',
      );
      if (query.from)
        qb.andWhere('signup.completed_at >= :from', {
          from: query.from,
        });
      if (query.to) qb.andWhere('signup.completed_at < :to', { to: query.to });
      if (query.communityId) {
        qb.andWhere('opportunity.community_id = :communityId', {
          communityId: query.communityId,
        });
      }
      return qb;
    };

    const base = () =>
      applyWindow(
        this.signups
          .createQueryBuilder('signup')
          .innerJoin(
            VolunteerOpportunity,
            'opportunity',
            'opportunity.id = signup.opportunity_id',
          ),
      );

    const [totals, byOpportunityRows, byCommunityRows] = await Promise.all([
      base()
        .select('COUNT(*)', 'sessionCount')
        .addSelect('COALESCE(SUM(signup.hours_contributed), 0)', 'hours')
        .addSelect('COUNT(DISTINCT signup.user_id)', 'volunteerCount')
        .getRawOne<{
          sessionCount: string;
          hours: string;
          volunteerCount: string;
        }>(),
      // `.limit()` rather than `.take()`: this is a grouped raw query, where
      // `.take()`'s entity-aware pagination does not apply (the house rule
      // about joined ORDER BY, for the same underlying reason).
      base()
        .select('opportunity.slug', 'opportunitySlug')
        .addSelect('opportunity.role', 'role')
        .addSelect('opportunity.org', 'org')
        .addSelect('COUNT(*)', 'sessionCount')
        .addSelect('COALESCE(SUM(signup.hours_contributed), 0)', 'hours')
        .groupBy('opportunity.slug')
        .addGroupBy('opportunity.role')
        .addGroupBy('opportunity.org')
        .orderBy('COALESCE(SUM(signup.hours_contributed), 0)', 'DESC')
        .limit(HOURS_BREAKDOWN_LIMIT)
        .getRawMany<{
          opportunitySlug: string;
          role: string;
          org: string;
          sessionCount: string;
          hours: string;
        }>(),
      // Opportunities with no community attribution are dropped rather than
      // bucketed under a fake "none" community; the platform total above
      // already covers them.
      base()
        .andWhere('opportunity.community_id IS NOT NULL')
        .select('opportunity.community_id', 'communityId')
        .addSelect('COUNT(*)', 'sessionCount')
        .addSelect('COALESCE(SUM(signup.hours_contributed), 0)', 'hours')
        .groupBy('opportunity.community_id')
        .orderBy('COALESCE(SUM(signup.hours_contributed), 0)', 'DESC')
        .limit(HOURS_BREAKDOWN_LIMIT)
        .getRawMany<{
          communityId: string;
          sessionCount: string;
          hours: string;
        }>(),
    ]);

    const byOpportunity: VolunteerHoursByOpportunityDTO[] =
      byOpportunityRows.map((row) => ({
        opportunitySlug: row.opportunitySlug,
        role: row.role,
        org: row.org,
        sessionCount: Number(row.sessionCount),
        hoursContributed: Number(row.hours),
      }));

    const byCommunity: VolunteerHoursByCommunityDTO[] = byCommunityRows.map(
      (row) => ({
        communityId: row.communityId,
        sessionCount: Number(row.sessionCount),
        hoursContributed: Number(row.hours),
      }),
    );

    return {
      from: query.from ? query.from.toISOString() : null,
      to: query.to ? query.to.toISOString() : null,
      sessionCount: Number(totals?.sessionCount ?? 0),
      hoursContributed: Number(totals?.hours ?? 0),
      volunteerCount: Number(totals?.volunteerCount ?? 0),
      byOpportunity,
      byCommunity,
    };
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

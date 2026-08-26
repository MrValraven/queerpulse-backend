import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { DataSource, In, Repository } from 'typeorm';
import { CreateMembershipJoinRequestDto } from './dto/create-join-request.dto';
import { Invite } from './entities/invite.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { InvitesService } from './invites.service';
import { computeBatchFlags } from './join-request-flags';
import {
  JoinRequestView,
  SubmittedJoinRequestView,
  toJoinRequestView,
  toSubmittedJoinRequestView,
} from './join-request-response';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';

const MIN_AGE_YEARS = 18;

/**
 * Whole years elapsed between `dob` and `now`, calendar-correct (this year's
 * birthday has to have actually passed). Returns null for an unparseable or
 * future date.
 */
function ageInYears(dob: string, now: Date): number | null {
  const born = new Date(dob);
  if (Number.isNaN(born.getTime()) || born.getTime() > now.getTime()) {
    return null;
  }
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - born.getUTCMonth();
  if (
    monthDelta < 0 ||
    (monthDelta === 0 && now.getUTCDate() < born.getUTCDate())
  ) {
    age--;
  }
  return age;
}

@Injectable()
export class JoinRequestsService {
  private readonly logger = new Logger(JoinRequestsService.name);

  constructor(
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
    private readonly invitesService: InvitesService,
    private readonly dataSource: DataSource,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  /**
   * PUBLIC submission — there is no user and no session behind this. Identity
   * is just the email the applicant typed; it is not verified here, and it does
   * not need to be, because approval only ever mints an invite BOUND to that
   * address. An address the applicant does not control yields an invite they
   * cannot redeem.
   */
  async submit(dto: CreateMembershipJoinRequestDto): Promise<SubmittedJoinRequestView> {
    // Join-request kill switch. First statement in the method, before any
    // query: this endpoint is the unauthenticated one, so it is where a spam
    // flood lands, and a rejected submission should not still cost a
    // duplicate-check round trip.
    //
    // 403 rather than the lockdown's 503 — the submission is genuinely
    // refused, not deferred, and the applicant is not being asked to retry in
    // a minute.
    const settings = await this.platformSettings.get();
    if (!settings.joinRequestsEnabled) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'JOIN_REQUESTS_CLOSED',
        // `||`, not `??`: an admin who clears the message textarea sends `''`,
        // and a blank rejection tells the applicant nothing.
        message:
          settings.registrationClosedMessage ||
          'We are not accepting new invite requests right now',
      });
    }

    // Normalised once, here, so the stored value always matches what
    // `lower(email)` in UQ_join_requests_pending_email indexes.
    const email = dto.email.trim().toLowerCase();

    // 18+ gate. The `ageAttested: true` checkbox is enforced by the DTO
    // (@Equals(true)); a DOB, when the frontend collects one, is the stronger
    // signal and is checked here. There is no pre-existing DOB logic anywhere
    // in the codebase to mirror — `AuthService.validateOrCreateGoogleUser` and
    // `AddAgeAttestation1782800690000` only ever model the attestation
    // checkbox — so this implements the contract's rule directly.
    if (dto.dateOfBirth) {
      const age = ageInYears(dto.dateOfBirth, new Date());
      if (age === null || age < MIN_AGE_YEARS) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: 'UNDER_18',
          message: 'You must be 18 or older to join',
        });
      }
    }

    // Reapplication cooldown (E1/P6): a declined applicant can try again, but
    // not immediately — 30 days gives a reviewer's "no" real weight instead
    // of inviting an instant resubmission loop. Checked before the
    // duplicate-pending pre-check below: for a returning applicant, the
    // cooldown is the more specific and more informative rejection reason.
    const REAPPLICATION_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const lastDeclined = await this.joinRequests
      .createQueryBuilder('jr')
      .where('lower(jr.email) = :email', { email })
      .andWhere('jr.status = :status', {
        status: PlatformJoinRequestStatus.Declined,
      })
      .orderBy('jr.reviewedAt', 'DESC')
      .getOne();
    if (
      lastDeclined?.reviewedAt &&
      Date.now() - lastDeclined.reviewedAt.getTime() < REAPPLICATION_COOLDOWN_MS
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'REAPPLICATION_COOLDOWN',
        message:
          'A previous request from this email was recently reviewed. Please wait before submitting again.',
      });
    }

    // Pre-check for the friendly 409. Case-insensitive to match the index — a
    // plain `where: { email }` would miss a differently-cased open request.
    const existing = await this.joinRequests
      .createQueryBuilder('jr')
      .where('lower(jr.email) = :email', { email })
      .andWhere('jr.status = :status', {
        status: PlatformJoinRequestStatus.Pending,
      })
      .getOne();
    if (existing) {
      throw new ConflictException(
        'An invite request for this email is already awaiting review',
      );
    }

    const mutualMemberEmail =
      dto.mutualMemberEmail?.trim().toLowerCase() || null;

    // Resolve the claimed reference against a real, ACTIVE member at submit
    // time (P9), so a reviewer sees a checkable corroboration link instead
    // of trusting an unverified string. `User.email` is `select: false` —
    // still filterable in a WHERE, we just never read it back (only `id`,
    // which is always selected, is needed here). Filtering to Active only: a
    // reference to a suspended/deactivated account shouldn't read as
    // corroboration.
    let referenceUserId: string | null = null;
    if (mutualMemberEmail) {
      const referenced = await this.dataSource.getRepository(User).findOne({
        where: { email: mutualMemberEmail, status: UserStatus.Active },
      });
      referenceUserId = referenced?.id ?? null;
    }

    const request = this.joinRequests.create({
      name: dto.name.trim(),
      email,
      city: dto.city?.trim() || null,
      message: dto.message,
      mutualMemberEmail,
      referenceUserId,
      status: PlatformJoinRequestStatus.Pending,
      ageAttestedAt: new Date(),
      termsVersion: dto.termsVersion,
      // Trimmed to null so a stray `''` from the frontend reads as "no source"
      // rather than an empty attribution the queue would have to special-case.
      source: dto.source?.trim() || null,
    });
    try {
      return toSubmittedJoinRequestView(await this.joinRequests.save(request));
    } catch (err) {
      // The pre-check above races with a concurrent submit; the partial unique
      // index UQ_join_requests_pending_email is the real backstop. Map 23505 to
      // a 409 instead of a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An invite request for this email is already awaiting review',
        );
      }
      throw err;
    }
  }

  async list(
    status?: PlatformJoinRequestStatus,
    options: {
      source?: string;
      cursor?: string;
      limit?: number;
      sort?: 'oldest' | 'newest';
    } = {},
  ): Promise<JoinRequestView[]> {
    const sort = options.sort ?? 'oldest';
    const take = options.limit ?? DEFAULT_LIST_LIMIT;

    const qb = this.joinRequests.createQueryBuilder('jr');
    if (status) qb.andWhere('jr.status = :status', { status });
    if (options.source) {
      qb.andWhere('jr.source = :source', { source: options.source });
    }
    if (options.cursor) {
      const op = sort === 'oldest' ? '>' : '<';
      qb.andWhere(`jr.createdAt ${op} :cursor`, { cursor: options.cursor });
    }
    qb.orderBy('jr.createdAt', sort === 'oldest' ? 'ASC' : 'DESC').take(take);

    const requests = await qb.getMany();
    // One extra query for the whole page rather than N+1 (or a join that would
    // drag the full Invite entity into the view mapper).
    const inviteIds = requests
      .map((r) => r.inviteId)
      .filter((id): id is string => id !== null);
    const codeById = new Map<string, string>();
    if (inviteIds.length > 0) {
      const invites = await this.dataSource.getRepository(Invite).find({
        where: { id: In(inviteIds) },
        select: { id: true, code: true },
      });
      for (const invite of invites) {
        codeById.set(invite.id, invite.code);
      }
    }

    // Batch-resolve any reference member (P9) to a display name/slug via
    // `Profile` — not `User`, where the name and slug don't live. Same ad
    // hoc `getRepository` idiom as the invite-code lookup above: one extra
    // query for the whole page, not N+1.
    const referenceUserIds = requests
      .map((r) => r.referenceUserId)
      .filter((id): id is string => id !== null);
    const referenceById = new Map<string, { name: string; slug: string }>();
    if (referenceUserIds.length > 0) {
      const profiles = await this.dataSource.getRepository(Profile).find({
        where: { userId: In(referenceUserIds) },
        select: { userId: true, firstName: true, lastName: true, slug: true },
      });
      for (const profile of profiles) {
        referenceById.set(profile.userId, {
          name: `${profile.firstName} ${profile.lastName}`.trim(),
          slug: profile.slug,
        });
      }
    }

    // Confidence-tiered triage flags (E4), computed from the batch alone —
    // no extra query, since duplicate-message and source-burst are both
    // about patterns within the page a reviewer is currently looking at.
    const flagsById = computeBatchFlags(
      requests.map((r) => ({
        id: r.id,
        email: r.email,
        message: r.message,
        source: r.source,
        createdAt: r.createdAt,
      })),
    );

    // One extra query for the whole page: how many DECLINED requests exist
    // for each email in this batch, regardless of how far back — richer than
    // a boolean "was this ever declined" flag, so a reviewer sees "declined
    // twice before" rather than a bare warning icon.
    const emails = [...new Set(requests.map((r) => r.email.toLowerCase()))];
    const priorDeclineCounts = new Map<string, number>();
    if (emails.length > 0) {
      const rows = await this.joinRequests
        .createQueryBuilder('jr')
        .select('lower(jr.email)', 'email')
        .addSelect('COUNT(*)', 'count')
        .where('lower(jr.email) IN (:...emails)', { emails })
        .andWhere('jr.status = :status', {
          status: PlatformJoinRequestStatus.Declined,
        })
        .groupBy('lower(jr.email)')
        .getRawMany<{ email: string; count: string }>();
      for (const row of rows) {
        priorDeclineCounts.set(row.email, Number(row.count));
      }
    }

    return requests.map((r) => {
      const reference = r.referenceUserId
        ? referenceById.get(r.referenceUserId)
        : undefined;
      return toJoinRequestView(
        r,
        r.inviteId ? (codeById.get(r.inviteId) ?? null) : null,
        flagsById.get(r.id) ?? [],
        priorDeclineCounts.get(r.email.toLowerCase()) ?? 0,
        reference?.name ?? null,
        reference?.slug ?? null,
      );
    });
  }

  async review(
    id: string,
    reviewerId: string,
    status:
      | PlatformJoinRequestStatus.Approved
      | PlatformJoinRequestStatus.Declined
      | PlatformJoinRequestStatus.Waitlisted,
    // Reason key a reviewer picked when declining (e.g. `spam_pattern`).
    // Required for a decline: defense at the service layer, not just relying
    // on the frontend always sending it.
    declineReason?: string,
  ): Promise<JoinRequestView> {
    if (
      status === PlatformJoinRequestStatus.Declined &&
      !declineReason?.trim()
    ) {
      throw new BadRequestException('A decline reason is required');
    }

    // The claim and the invite minting run in one transaction on the same
    // manager: if minting fails the review rolls back, so there is no
    // "approved but no invite" stuck state for an applicant who has no other
    // way in.
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PlatformJoinRequest);
      const current = await repo.findOne({ where: { id } });
      if (!current) {
        throw new NotFoundException('Join request not found');
      }
      // Pending AND Waitlisted are both open states a review can act on.
      // Approved/Declined are terminal.
      const openStates: PlatformJoinRequestStatus[] = [
        PlatformJoinRequestStatus.Pending,
        PlatformJoinRequestStatus.Waitlisted,
      ];
      if (!openStates.includes(current.status)) {
        throw new ConflictException('Join request has already been reviewed');
      }
      const reviewedAt = new Date();

      // Approving mints the invite BEFORE the claim, so `invite_id` lands in
      // the same UPDATE as the status flip.
      let inviteCode: string | null = null;
      let inviteId: string | null = null;
      if (status === PlatformJoinRequestStatus.Approved) {
        // The approving admin is recorded as the inviter: `invites.inviter_id`
        // is NOT NULL with an FK to `users` (AddMembership1782691400000), so it
        // needs a real member, and the admin is the one actually vouching for
        // this person by approving them. It also keeps
        // `InvitesService.validateInviteForSignup`'s "inviter must be an active
        // member" check satisfiable at redemption time.
        const invite = await this.invitesService.createInviteForApproval(
          manager,
          reviewerId,
          current.email,
        );
        inviteCode = invite.code;
        inviteId = invite.id;
      }

      // Only meaningful when declining; null otherwise (the pre-flight check
      // above already refused a Declined status without a reason).
      const resolvedDeclineReason =
        status === PlatformJoinRequestStatus.Declined
          ? (declineReason?.trim() ?? null)
          : null;

      // Conditional claim: only a reviewer who flips it out of an open state
      // wins; a concurrent reviewer sees affected === 0 and is rejected.
      const claim = await repo.update(
        { id, status: In(openStates) },
        {
          status,
          reviewedBy: reviewerId,
          reviewedAt,
          inviteId,
          declineReason: resolvedDeclineReason,
        },
      );
      if (claim.affected !== 1) {
        throw new ConflictException('Join request has already been reviewed');
      }
      current.status = status;
      current.reviewedBy = reviewerId;
      current.reviewedAt = reviewedAt;
      current.inviteId = inviteId;
      current.declineReason = resolvedDeclineReason;
      return toJoinRequestView(current, inviteCode);
    });
  }

  /**
   * Applies one review decision to many join requests in a single call, by
   * calling `review()` once per id. Mirrors
   * `VerificationService.bulkDecide`'s per-item pattern (batch size capped at
   * the DTO layer via `JOIN_REQUEST_BULK_ACTION_CAP`): a failure on one id
   * (not found, already reviewed, concurrently claimed, missing decline
   * reason) lands that id in `failed`, and every other id is still attempted.
   *
   * ONLY an `HttpException` message reaches `failed[].reason`. Those are our
   * own deliberate, reviewer-facing sentences. Anything else is an internal
   * failure whose message is not written for a human reader: a
   * `QueryFailedError`, for instance, carries the Postgres error text plus the
   * offending constraint and table name, and `createInviteForApproval` has no
   * code-collision retry, so a 23505 is a live possibility here. Those are
   * logged with their stack and reported as a flat "Internal error".
   *
   * Deliberately sequential, not `Promise.all` — each `review()` call is its
   * own transaction against a shared table, and running many of them
   * concurrently against the same rows is exactly the kind of contention the
   * conditional-claim mechanism exists to survive, but there's no reason to
   * manufacture that contention against a batch the caller selected together.
   * Sequential also keeps `failed[].reason` deterministic and easy to reason
   * about.
   */
  async bulkReview(
    ids: string[],
    reviewerId: string,
    status:
      | PlatformJoinRequestStatus.Approved
      | PlatformJoinRequestStatus.Declined
      | PlatformJoinRequestStatus.Waitlisted,
    declineReason?: string,
  ): Promise<{
    succeeded: string[];
    failed: { id: string; reason: string }[];
  }> {
    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const id of ids) {
      try {
        await this.review(id, reviewerId, status, declineReason);
        succeeded.push(id);
      } catch (err) {
        if (err instanceof HttpException) {
          failed.push({ id, reason: err.message });
          continue;
        }
        this.logger.error(
          `Bulk review failed for join request ${id}: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        failed.push({ id, reason: 'Internal error' });
      }
    }
    return { succeeded, failed };
  }

  /**
   * A random sample of already-decided requests (approved or declined), for
   * the periodic peer-review quality-sampling pass described in the rubric
   * doc (P8/E8) — a reviewer re-judges a small, random slice of past
   * decisions to check the queue's bar is being applied consistently.
   *
   * No flags/prior-decline-count on sampled rows: those signals exist to
   * triage *pending* requests, not to re-triage a decision that has already
   * been made. `toJoinRequestView` is called with just the invite code, same
   * as `review()`'s single-row call, so those fields default to `[]`/`0`.
   */
  async sample(n: number): Promise<JoinRequestView[]> {
    const requests = await this.joinRequests
      .createQueryBuilder('jr')
      .where('jr.status IN (:...statuses)', {
        statuses: [
          PlatformJoinRequestStatus.Approved,
          PlatformJoinRequestStatus.Declined,
        ],
      })
      .orderBy('RANDOM()')
      .limit(n)
      .getMany();

    const inviteIds = requests
      .map((r) => r.inviteId)
      .filter((id): id is string => id !== null);
    const codeById = new Map<string, string>();
    if (inviteIds.length > 0) {
      const invites = await this.dataSource.getRepository(Invite).find({
        where: { id: In(inviteIds) },
        select: { id: true, code: true },
      });
      for (const invite of invites) {
        codeById.set(invite.id, invite.code);
      }
    }
    return requests.map((r) =>
      toJoinRequestView(
        r,
        r.inviteId ? (codeById.get(r.inviteId) ?? null) : null,
      ),
    );
  }
}

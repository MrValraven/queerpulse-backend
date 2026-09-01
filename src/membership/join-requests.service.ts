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
import { createHash, randomBytes } from 'node:crypto';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { MemberLookup, MemberRef } from '../common/member-ref';
import {
  optionalQueueAssigneeName,
  setQueueAssignment,
} from '../common/queue-assignment';
import { joinRequestDueAt } from './join-request-sla';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { CreateMembershipJoinRequestDto } from './dto/create-join-request.dto';
import { Invite } from './entities/invite.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from './entities/join-request.entity';
import { resolveInviteStatus } from './invite-response';
import { InvitesService } from './invites.service';
import { computeBatchFlags } from './join-request-flags';
import {
  JoinRequestInviteRef,
  JoinRequestView,
  PublicJoinRequestStatusView,
  SubmittedJoinRequestView,
  toJoinRequestView,
  toPublicJoinRequestStatusView,
  toSubmittedJoinRequestView,
} from './join-request-response';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';

const MIN_AGE_YEARS = 18;

/**
 * Entropy behind the applicant's status token. 32 bytes is 256 bits, the same
 * budget the CSRF secret and the listing-draft claim token use, and it is
 * rendered base64url so the token can sit in a query string, a bookmark or a
 * pasted message without escaping.
 */
const STATUS_TOKEN_BYTES = 32;

/**
 * PRD-02. How many times an applicant may revive their OWN lapsed approval
 * invite from the status page.
 *
 * The status token is a bearer credential with nothing behind it, so an
 * approval that could be renewed from it without limit would stay redeemable
 * for as long as the token existed anywhere. Three is enough to survive the
 * realistic failure (came back late, missed the window, tried again from
 * another device) without turning one approval into a permanent open door. A
 * moderator's `POST /admin/join-requests/:id/invite/reissue` is not counted
 * and is not capped: a human is making that call.
 */
const MAX_SELF_SERVE_INVITE_REFRESHES = 3;

/**
 * The stored form of a status token. Sha256 hex, matching
 * `AuthService.hashToken` and `AccountService`'s deletion tokens: the column
 * holds this, the applicant holds the plaintext, and the two only ever meet
 * inside a lookup.
 */
function hashStatusToken(statusToken: string): string {
  return createHash('sha256').update(statusToken).digest('hex');
}

/**
 * PRD-14. The body of the 409 a re-submission gets when this email already has
 * an open request.
 *
 * A `code` rides along so the frontend can render the way BACK to that request
 * (paste the reference code, or sign in with the Google account for this
 * address) instead of a bare "you already asked" that ends the journey there.
 * Same shape as the `JOIN_REQUESTS_CLOSED` / `UNDER_18` rejections above it, so
 * the client has one way of reading a typed refusal on this route.
 *
 * THE DISCLOSURE HERE IS UNCHANGED, deliberately. This route already answered
 * 409 for an open request and 201 for a new one, and that difference is what an
 * enumeration attempt reads; adding a machine-readable label to the refusal
 * tells a caller nothing the status code did not. The recovery path this label
 * points at is the one that had to be built enumeration-proof, and it is:
 * proving control of the address is the entry condition, not a claim about it.
 */
function duplicateJoinRequestBody(): {
  statusCode: number;
  error: string;
  code: string;
  message: string;
} {
  return {
    statusCode: 409,
    error: 'Conflict',
    code: 'JOIN_REQUEST_PENDING',
    message: 'An invite request for this email is already awaiting review',
  };
}

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
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  /**
   * PUBLIC submission — there is no user and no session behind this. Identity
   * is just the email the applicant typed; it is not verified here, and it does
   * not need to be, because approval only ever mints an invite BOUND to that
   * address. An address the applicant does not control yields an invite they
   * cannot redeem.
   */
  async submit(
    dto: CreateMembershipJoinRequestDto,
  ): Promise<SubmittedJoinRequestView> {
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
      throw new ConflictException(duplicateJoinRequestBody());
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

    // The applicant's own status credential (ACQ-01). Minted here because this
    // response is the only delivery channel that will ever exist for it: the
    // platform sends no email, so a token generated any later than the 201
    // could never reach the person who needs it. Only the hash is persisted.
    const statusToken = randomBytes(STATUS_TOKEN_BYTES).toString('base64url');

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
      // OPS-04. Stamped once, here, from the single window constant in
      // `join-request-sla.ts` — the same shape `ReportsService.create`
      // computes `slaDueAt` in. Computed from `new Date()` rather than the
      // row's own `created_at` (which the database writes a moment later);
      // the two differ by less than the time it takes to insert.
      dueAt: joinRequestDueAt(new Date()),
      // Trimmed to null so a stray `''` from the frontend reads as "no source"
      // rather than an empty attribution the queue would have to special-case.
      source: dto.source?.trim() || null,
      statusTokenHash: hashStatusToken(statusToken),
    });
    try {
      const savedRequest = await this.joinRequests.save(request);
      // Tell whoever is on the join-request rota that somebody is waiting.
      // Awaited rather than fired and forgotten so a slow bell shows up in
      // this request's own latency instead of as an unhandled rejection, and
      // safe to await because `announce` catches everything: a notification
      // failure can never fail an applicant's submission.
      await this.adminQueueNotifications.announce(
        AdminQueueKey.InviteRequests,
        savedRequest.id,
      );
      return toSubmittedJoinRequestView(savedRequest, statusToken);
    } catch (err) {
      // The pre-check above races with a concurrent submit; the partial unique
      // index UQ_join_requests_pending_email is the real backstop. Map 23505 to
      // a 409 instead of a 500.
      if (isUniqueViolation(err)) {
        throw new ConflictException(duplicateJoinRequestBody());
      }
      throw err;
    }
  }

  /**
   * PUBLIC status lookup for the applicant's own request (ACQ-01). The token
   * the caller holds is the whole credential — there is no session behind this
   * — so the answer is deliberately the narrowest thing that closes the loop:
   * the outcome, when it was made, why it was declined, and the invite an
   * approval minted. Never the submitted message, never the reviewer, never
   * another row.
   *
   * Returns `null` for EVERY failure mode (a token that matches nothing, a
   * token that is well-formed but was never issued), so the controller can
   * answer with one indistinguishable 404. The card-verification route makes
   * the same call for the same reason: confirming that a token merely exists
   * would turn this into an oracle for guessing them.
   *
   * PRD-02: THIS READ IS ALSO A WRITE, and that is the fix, not a side
   * effect. Approval mints an email-pinned invite that nothing delivers, so
   * this lookup is the only moment the applicant is ever told it exists. The
   * FIRST such moment latches `approval_seen_at` and starts the invite's short
   * redemption window from there, so the deadline the applicant is shown is
   * one that began when they were told about it. Before this, the window ran
   * from a reviewer's click the applicant never saw, and the sweeper routinely
   * reclaimed the invite before they next opened the page.
   */
  async getPublicStatus(
    statusToken: string,
  ): Promise<PublicJoinRequestStatusView | null> {
    // Looked up BY HASH: the plaintext is never stored, so this is the only
    // way the token can resolve, and the unique index makes it at most one row.
    const request = await this.joinRequests.findOne({
      where: { statusTokenHash: hashStatusToken(statusToken) },
    });
    if (!request) {
      return null;
    }
    return toPublicJoinRequestStatusView(
      request,
      await this.applicantInviteRef(request),
    );
  }

  /**
   * The approval invite as the APPLICANT is allowed to see it: its code, its
   * live status and its deadline. Null for a request that never minted one
   * (still pending, declined, or an approval whose invite row was purged).
   *
   * `resolveInviteStatus` is the same lazily-computed expiry/revocation/used
   * check the invite landing page and the member's own invite list run, so a
   * lapsed-but-unswept row never reports itself valid here either.
   *
   * Starts the redemption window on the first read that finds a still-valid
   * invite the applicant has not seen (see `getPublicStatus`). The latch is a
   * conditional `approval_seen_at IS NULL` UPDATE, so of two concurrent
   * reloads exactly one moves the deadline. The loser re-reads the invite
   * before answering: the expiry it fetched a moment earlier is the shelf
   * date the winner has since replaced, and reporting that would show the
   * applicant a deadline that is not theirs.
   */
  private async applicantInviteRef(
    request: PlatformJoinRequest,
  ): Promise<JoinRequestInviteRef | null> {
    if (
      request.status !== PlatformJoinRequestStatus.Approved ||
      !request.inviteId
    ) {
      return null;
    }
    const invites = this.dataSource.getRepository(Invite);
    const invite = await invites.findOne({ where: { id: request.inviteId } });
    if (!invite) {
      return null;
    }
    const now = new Date();
    const status = resolveInviteStatus(invite, now);
    let expiresAt = invite.expiresAt;

    if (status === 'valid' && !request.approvalSeenAt) {
      const latch = await this.joinRequests.update(
        { id: request.id, approvalSeenAt: IsNull() },
        { approvalSeenAt: now },
      );
      if (latch.affected === 1) {
        request.approvalSeenAt = now;
        expiresAt = await this.invitesService.startApprovalRedemptionWindow(
          invite.id,
          now,
        );
      } else {
        // A concurrent read won the latch and moved the deadline a moment ago.
        // Re-read rather than report the stale shelf date we fetched above.
        const current = await invites.findOne({ where: { id: invite.id } });
        expiresAt = current?.expiresAt ?? expiresAt;
      }
    }

    return { code: invite.code, status, expiresAt };
  }

  /**
   * PRD-02. The applicant reviving their OWN lapsed approval invite, from the
   * status page, with nothing but the token they already hold.
   *
   * This is the end of the dead end. An approval invite that lapsed used to be
   * terminal for the applicant: the page said the invite was gone, no route
   * re-minted one, and the only remaining path was a moderator noticing. With
   * the redemption window now starting when the applicant reads the code, a
   * lapse means they genuinely had their seven days and let them pass, which is
   * a normal thing to do and should cost a click to undo.
   *
   * WHAT IT REFUSES, and why each refusal is not an oracle: every outcome here
   * is reachable only by a caller who already resolved the token, so nothing
   * below distinguishes anything for someone who has not. A token that does not
   * resolve returns `null` and the controller answers the same 404 the read
   * does.
   *
   *  - `used`: an account exists on this invite. Refreshing would re-open a
   *    redeemed invitation, which is exactly what `refreshExpiredInvite`
   *    refuses for members and must refuse here.
   *  - `revoked`: a moderator's deliberate act, and not the applicant's to
   *    undo.
   *  - `valid`: nothing to do. Returns the current view rather than an error:
   *    the page that asked will now render the live code, which is what the
   *    applicant wanted.
   *  - the cap, `MAX_SELF_SERVE_INVITE_REFRESHES`. The token is a bearer
   *    credential; an approval must not be renewable from it forever.
   */
  async refreshApprovalInvite(
    statusToken: string,
  ): Promise<PublicJoinRequestStatusView | null> {
    const request = await this.joinRequests.findOne({
      where: { statusTokenHash: hashStatusToken(statusToken) },
    });
    if (!request) {
      return null;
    }
    const invite = await this.applicantInviteRef(request);
    if (!invite) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INVITE_REFRESH_UNAVAILABLE',
        message: 'There is no invite on this request to refresh.',
      });
    }
    if (invite.status === 'valid') {
      return toPublicJoinRequestStatusView(request, invite);
    }
    if (invite.status === 'used') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INVITE_ALREADY_USED',
        message: 'An account has already been created with this invite.',
      });
    }
    if (invite.status === 'revoked') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INVITE_REVOKED',
        message: 'This invite is no longer available.',
      });
    }
    if (request.inviteRefreshCount >= MAX_SELF_SERVE_INVITE_REFRESHES) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INVITE_REFRESH_LIMIT',
        message: 'This invite has been refreshed as many times as it can be.',
      });
    }

    // Conditional on the count we just read, so two clicks in flight together
    // cannot each spend a slot and hand out two windows. The loser reports the
    // cap, which is the truthful answer for it.
    const claim = await this.joinRequests.update(
      { id: request.id, inviteRefreshCount: request.inviteRefreshCount },
      { inviteRefreshCount: request.inviteRefreshCount + 1 },
    );
    if (claim.affected !== 1) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'INVITE_REFRESH_LIMIT',
        message: 'This invite has been refreshed as many times as it can be.',
      });
    }
    request.inviteRefreshCount += 1;

    // `reissueApprovalInvite` re-runs the same expired/used/revoked guards on
    // the row itself, so a redemption that landed between our read and here
    // surfaces as its 409 rather than a silently re-opened invite.
    const refreshed = await this.invitesService.reissueApprovalInvite(
      request.inviteId as string,
    );
    return toPublicJoinRequestStatusView(request, {
      code: refreshed.code,
      status: resolveInviteStatus(refreshed, new Date()),
      expiresAt: refreshed.expiresAt,
    });
  }

  /**
   * PRD-14. Hands back a FRESH status token for the most recent request from
   * an address whose owner has already been PROVEN, by the caller, to be the
   * person asking.
   *
   * THE ENTRY CONDITION IS THE WHOLE SECURITY MODEL. There is no channel that
   * can deliver a re-issued token to an applicant: QueerPulse sends no email,
   * and an applicant has no account, so no in-app notification reaches them
   * either. A recovery route keyed on a TYPED email would therefore have to
   * answer the typist directly, which on an invite-gated platform for this
   * audience means answering "has this person applied?" to anyone who asks.
   * That route does not exist and must never be built.
   *
   * What does exist is Google sign-in, which already proves control of an
   * address (`email_verified` is checked in `GoogleStrategy`, and
   * `AuthService` rejects an unverified one outright) without sending
   * anything. So this method takes an ALREADY-VERIFIED address and is
   * deliberately not reachable from any controller in this module.
   *
   * CALLER CONTRACT, and it is not optional: the caller must have authenticated
   * the address it passes. The only intended caller is the Google callback's
   * `invite_required` branch, where an applicant who lost their token signs in
   * with the address they applied under and is carried to their own status page
   * instead of a "you need an invite" notice.
   *
   * ROTATES rather than recovers, because it must: only the SHA-256 hash is
   * stored, so the old plaintext is unrecoverable by construction. The previous
   * token stops working the moment this returns, which is the correct
   * behaviour for a recovery anyway.
   *
   * Returns `null` when the address has never applied. Callers must render that
   * identically to their existing "no". See the Google callback, where it
   * falls through to exactly the notice it showed before.
   */
  async recoverStatusTokenForVerifiedEmail(
    verifiedEmail: string,
  ): Promise<string | null> {
    const email = verifiedEmail.trim().toLowerCase();
    if (!email) {
      return null;
    }
    // The MOST RECENT request, whatever its status. A declined applicant is
    // entitled to read their own decline, and a re-application after the
    // cooldown is the row they are waiting on now.
    const request = await this.joinRequests
      .createQueryBuilder('jr')
      .where('lower(jr.email) = :email', { email })
      .orderBy('jr.createdAt', 'DESC')
      .getOne();
    if (!request) {
      return null;
    }
    const statusToken = randomBytes(STATUS_TOKEN_BYTES).toString('base64url');
    await this.joinRequests.update(
      { id: request.id },
      { statusTokenHash: hashStatusToken(statusToken) },
    );
    this.logger.log(
      `Re-issued the status token on join request ${request.id} to a verified address`,
    );
    return statusToken;
  }

  async list(
    status?: PlatformJoinRequestStatus,
    options: {
      source?: string;
      cursor?: string;
      limit?: number;
      sort?: 'oldest' | 'newest';
      /**
       * OPS-04's "Assigned to me" filter. A user id narrows the page to that
       * reviewer's claimed requests; `'unassigned'` narrows to the rows nobody
       * has picked up. Server-side, not a client-side filter over one page:
       * the queue is keyset-paginated, so filtering after the fetch would hide
       * claimed rows that simply had not loaded yet.
       */
      assignedTo?: string;
    } = {},
  ): Promise<JoinRequestView[]> {
    const sort = options.sort ?? 'oldest';
    const take = options.limit ?? DEFAULT_LIST_LIMIT;

    const qb = this.joinRequests.createQueryBuilder('jr');
    if (status) qb.andWhere('jr.status = :status', { status });
    if (options.source) {
      qb.andWhere('jr.source = :source', { source: options.source });
    }
    if (options.assignedTo === 'unassigned') {
      qb.andWhere('jr.assignedStaffId IS NULL');
    } else if (options.assignedTo) {
      qb.andWhere('jr.assignedStaffId = :assignedTo', {
        assignedTo: options.assignedTo,
      });
    }
    if (options.cursor) {
      const op = sort === 'oldest' ? '>' : '<';
      qb.andWhere(`jr.createdAt ${op} :cursor`, { cursor: options.cursor });
    }
    qb.orderBy('jr.createdAt', sort === 'oldest' ? 'ASC' : 'DESC').take(take);

    const requests = await qb.getMany();
    // One extra query for the whole page rather than N+1 (or a join that would
    // drag the full Invite entity into the view mapper). Status and expiry ride
    // along with the code: the decided tab has to say whether the link it is
    // offering still works, and an approval invite lapses after 7 days.
    const inviteRefById = await this.loadInviteRefs(requests);

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

    // OPS-04: one batched profile lookup for every reviewer holding a row on
    // this page, so the queue can print "Claimed by Ana Reis" without a query
    // per row. The DECIDING reviewers ride along in the SAME lookup, so naming
    // who made each past call costs this page nothing extra.
    const staffRefs = await this.staffRefs([
      ...requests.map((r) => r.assignedStaffId),
      ...requests.map((r) => r.reviewedBy),
    ]);

    return requests.map((r) => {
      const reference = r.referenceUserId
        ? referenceById.get(r.referenceUserId)
        : undefined;
      return toJoinRequestView(
        r,
        r.inviteId ? (inviteRefById.get(r.inviteId) ?? null) : null,
        flagsById.get(r.id) ?? [],
        priorDeclineCounts.get(r.email.toLowerCase()) ?? 0,
        reference?.name ?? null,
        reference?.slug ?? null,
        optionalQueueAssigneeName(r.assignedStaffId, staffRefs),
        optionalQueueAssigneeName(r.reviewedBy, staffRefs),
      );
    });
  }

  /**
   * Claim or release one invite request (OPS-04) — the write behind the
   * queue's "Assigned to me" filter.
   *
   * Mirrors `ModerationService.setAssignment` exactly, including the property
   * that makes it safe under two reviewers pressing Claim at once: the write
   * is a conditional UPDATE guarded on the assignment this caller read, so the
   * loser gets a 409 rather than silently taking the row. Additionally guarded
   * on the request still being OPEN, so a decided applicant cannot be claimed
   * by a stale queue.
   *
   * Claiming is not deciding: it takes no side, records no review, and can be
   * undone by releasing.
   */
  async setAssignment(
    id: string,
    actorId: string,
    actorRole: string,
    assign: boolean,
  ): Promise<JoinRequestView> {
    const request = await this.joinRequests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Join request not found');

    await setQueueAssignment({
      repository: this.joinRequests,
      id,
      currentAssigneeId: request.assignedStaffId,
      actorId,
      // `actorRole` is a JWT claim, typed `string` on `CurrentUserData` — the
      // widening says so rather than implying the two are the same enum.
      isAdmin: actorRole === (UserRole.Admin as string),
      assign,
      rowLabel: 'invite request',
      claimableStatuses: {
        column: 'status',
        values: [
          PlatformJoinRequestStatus.Pending,
          PlatformJoinRequestStatus.Waitlisted,
        ],
      },
    });

    return this.viewOfOne(id);
  }

  /** Re-reads one request and maps it with its assignee resolved. Used by
   *  `setAssignment`, which changes only the assignee fields, so none of
   *  `list`'s batch-derived context (flags, prior declines) applies. */
  private async viewOfOne(id: string): Promise<JoinRequestView> {
    const saved = await this.joinRequests.findOne({ where: { id } });
    if (!saved) throw new NotFoundException('Join request not found');
    const inviteRefById = await this.loadInviteRefs([saved]);
    const staffRefs = await this.staffRefs([
      saved.assignedStaffId,
      saved.reviewedBy,
    ]);
    return toJoinRequestView(
      saved,
      saved.inviteId ? (inviteRefById.get(saved.inviteId) ?? null) : null,
      [],
      0,
      null,
      null,
      optionalQueueAssigneeName(saved.assignedStaffId, staffRefs),
      optionalQueueAssigneeName(saved.reviewedBy, staffRefs),
    );
  }

  /**
   * Batched userId -> profile ref for the staff attached to a set of rows:
   * whoever is HOLDING each row and whoever DECIDED it, resolved together in
   * ONE query because they are the same population and a page needs both.
   * Skips the query entirely when the set is empty (a page of unclaimed,
   * undecided requests), and de-duplicates, so one reviewer across fifty rows
   * is looked up once.
   */
  private async staffRefs(
    staffUserIds: (string | null)[],
  ): Promise<Map<string, MemberRef>> {
    const ids = [
      ...new Set(staffUserIds.filter((id): id is string => id !== null)),
    ];
    if (!ids.length) return new Map<string, MemberRef>();
    return new MemberLookup(this.dataSource.getRepository(Profile)).byUserIds(
      ids,
    );
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
      let inviteRef: JoinRequestInviteRef | null = null;
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
        // Freshly minted inside this transaction, so it is 'valid' by
        // construction — no `resolveInviteStatus` round trip needed.
        inviteRef = {
          code: invite.code,
          status: 'valid',
          expiresAt: invite.expiresAt,
        };
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
      return toJoinRequestView(current, inviteRef);
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
   * been made, so those fields default to `[]`/`0`.
   *
   * The DECIDING reviewer IS resolved to a name here, and it is the one thing
   * this surface cannot work without: reading a run of decisions for a
   * consistent bar means knowing which of them were read by the same person.
   * It costs ONE batched profile lookup for the whole draw (up to 50 rows),
   * never one per row, so the endpoint issues at most three queries: the
   * sampled rows, their invites, and this.
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

    const inviteRefById = await this.loadInviteRefs(requests);
    // A decided row can still carry the claim it was worked under, so both
    // staff ids go into the one lookup rather than resolving the reviewer and
    // leaving the holder as a bare uuid.
    const staffRefs = await this.staffRefs([
      ...requests.map((r) => r.reviewedBy),
      ...requests.map((r) => r.assignedStaffId),
    ]);
    return requests.map((r) =>
      toJoinRequestView(
        r,
        r.inviteId ? (inviteRefById.get(r.inviteId) ?? null) : null,
        [],
        0,
        null,
        null,
        optionalQueueAssigneeName(r.assignedStaffId, staffRefs),
        optionalQueueAssigneeName(r.reviewedBy, staffRefs),
      ),
    );
  }

  /**
   * Resolve every approval-minted invite referenced by a batch of requests, in
   * ONE query for the whole page — never one per row, and never a join that
   * would drag the full `Invite` entity into the view mapper.
   *
   * The status is computed here with `resolveInviteStatus`, the same lazily
   * evaluated check the invite landing page and the member's own invite list
   * use, so a row still stored `pending` but past its `expires_at` reports
   * itself expired to the review queue exactly as it would to the applicant.
   */
  private async loadInviteRefs(
    requests: PlatformJoinRequest[],
  ): Promise<Map<string, JoinRequestInviteRef>> {
    const inviteIds = requests
      .map((request) => request.inviteId)
      .filter((id): id is string => id !== null);
    const refById = new Map<string, JoinRequestInviteRef>();
    if (inviteIds.length === 0) {
      return refById;
    }
    const now = new Date();
    const invites = await this.dataSource.getRepository(Invite).find({
      where: { id: In(inviteIds) },
      select: { id: true, code: true, status: true, expiresAt: true },
    });
    for (const invite of invites) {
      refById.set(invite.id, {
        code: invite.code,
        status: resolveInviteStatus(invite, now),
        expiresAt: invite.expiresAt,
      });
    }
    return refById;
  }

  /**
   * Re-mint the lapsed invite an approval already handed out, addressed by the
   * JOIN REQUEST rather than by the invite code — `POST
   * /admin/join-requests/:id/invite/reissue`.
   *
   * QueerPulse delivers no email, so the reviewer carrying the link over by
   * hand is the invite's only route to the applicant. When that link lapses
   * (7 days) the applicant is stranded, and the member-facing
   * `POST /invites/:code/resend` cannot help: it is scoped to
   * `{ code, inviterId }`, and the inviter on an approval invite is whichever
   * reviewer happened to approve it — so anyone else picking the case up gets a
   * 404. This route is that missing lever, guarded exactly like the rest of the
   * review queue (moderator or admin) and reachable only through a request the
   * queue already shows.
   *
   * Answers, mirroring the member route so the frontend can share one error map:
   *  - 404 when the id is unknown, or the request never minted an invite (not
   *    approved, or approved before invites were recorded) — one answer for
   *    both, so this cannot be used to probe which requests exist;
   *  - 409 when the invite was accepted or revoked, or is still valid; only an
   *    expired invite can be reissued.
   *
   * Returns the request's full queue view with the refreshed invite on it, so
   * the caller can patch the row in place instead of refetching the tab.
   */
  async reissueInvite(
    id: string,
    reviewerId: string,
  ): Promise<JoinRequestView> {
    const request = await this.joinRequests.findOne({ where: { id } });
    if (
      !request ||
      request.status !== PlatformJoinRequestStatus.Approved ||
      !request.inviteId
    ) {
      throw new NotFoundException('No invite to reissue for this request');
    }
    const invite = await this.invitesService.reissueApprovalInvite(
      request.inviteId,
    );
    this.logger.log(
      `Reviewer ${reviewerId} reissued the approval invite on join request ${id}`,
    );
    // The caller patches a decided row in place with this, so the reviewer's
    // name has to survive the patch or reissuing an invite would blank out who
    // decided the request. One batched lookup for the single row.
    const staffRefs = await this.staffRefs([
      request.reviewedBy,
      request.assignedStaffId,
    ]);
    return toJoinRequestView(
      request,
      {
        code: invite.code,
        status: resolveInviteStatus(invite, new Date()),
        expiresAt: invite.expiresAt,
      },
      [],
      0,
      null,
      null,
      optionalQueueAssigneeName(request.assignedStaffId, staffRefs),
      optionalQueueAssigneeName(request.reviewedBy, staffRefs),
    );
  }
}

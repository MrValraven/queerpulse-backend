import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { Invite } from './entities/invite.entity';
import { JoinRequest, JoinRequestStatus } from './entities/join-request.entity';
import { InvitesService } from './invites.service';
import {
  JoinRequestView,
  SubmittedJoinRequestView,
  toJoinRequestView,
  toSubmittedJoinRequestView,
} from './join-request-response';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';

const MIN_AGE_YEARS = 18;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
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
  constructor(
    @InjectRepository(JoinRequest)
    private readonly joinRequests: Repository<JoinRequest>,
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
  async submit(dto: CreateJoinRequestDto): Promise<SubmittedJoinRequestView> {
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

    // Pre-check for the friendly 409. Case-insensitive to match the index — a
    // plain `where: { email }` would miss a differently-cased open request.
    const existing = await this.joinRequests
      .createQueryBuilder('jr')
      .where('lower(jr.email) = :email', { email })
      .andWhere('jr.status = :status', { status: JoinRequestStatus.Pending })
      .getOne();
    if (existing) {
      throw new ConflictException(
        'An invite request for this email is already awaiting review',
      );
    }

    const request = this.joinRequests.create({
      name: dto.name.trim(),
      email,
      city: dto.city?.trim() || null,
      message: dto.message,
      status: JoinRequestStatus.Pending,
      ageAttestedAt: new Date(),
      termsVersion: dto.termsVersion,
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

  async list(status?: JoinRequestStatus): Promise<JoinRequestView[]> {
    const requests = await this.joinRequests.find({
      where: status ? { status } : {},
      order: { createdAt: 'ASC' },
    });
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
    return requests.map((r) =>
      toJoinRequestView(
        r,
        r.inviteId ? (codeById.get(r.inviteId) ?? null) : null,
      ),
    );
  }

  async review(
    id: string,
    reviewerId: string,
    status: JoinRequestStatus.Approved | JoinRequestStatus.Declined,
  ): Promise<JoinRequestView> {
    // The claim and the invite minting run in one transaction on the same
    // manager: if minting fails the review rolls back, so there is no
    // "approved but no invite" stuck state for an applicant who has no other
    // way in.
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(JoinRequest);
      const current = await repo.findOne({ where: { id } });
      if (!current) {
        throw new NotFoundException('Join request not found');
      }
      if (current.status !== JoinRequestStatus.Pending) {
        throw new ConflictException('Join request has already been reviewed');
      }
      const reviewedAt = new Date();

      // Approving mints the invite BEFORE the claim, so `invite_id` lands in
      // the same UPDATE as the status flip.
      let inviteCode: string | null = null;
      let inviteId: string | null = null;
      if (status === JoinRequestStatus.Approved) {
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

      // Conditional claim: only the reviewer who flips it out of pending wins;
      // a concurrent reviewer sees affected === 0 and is rejected.
      const claim = await repo.update(
        { id, status: JoinRequestStatus.Pending },
        { status, reviewedBy: reviewerId, reviewedAt, inviteId },
      );
      if (claim.affected !== 1) {
        throw new ConflictException('Join request has already been reviewed');
      }
      current.status = status;
      current.reviewedBy = reviewerId;
      current.reviewedAt = reviewedAt;
      current.inviteId = inviteId;
      return toJoinRequestView(current, inviteCode);
    });
  }
}

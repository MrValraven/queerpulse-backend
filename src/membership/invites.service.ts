import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  MoreThanOrEqual,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { SignupRejectedError } from '../auth/errors/signup-rejected.error';
import { Invite, InviteStatus } from './entities/invite.entity';
import {
  MyInviteView,
  PublicInviteStatus,
  PublicInviteView,
  resolveInviteStatus,
  toMyInviteView,
  toPublicInviteView,
} from './invite-response';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Code groups are drawn from an unambiguous uppercase alphabet (no I/O/0/1) so
// codes are easy to read aloud and copy from a link preview. 32 symbols.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Bounds the otherwise-unbounded "my invites" list read.
const DEFAULT_PAGE_SIZE = 20;

// Whole-operation retries if a freshly-minted code collides on insert (23505).
const MAX_CODE_ATTEMPTS = 5;

export interface PageParams {
  limit?: number;
  offset?: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err.driverError as { code?: string })?.code === '23505'
  );
}

// The minimal payload returned by POST /invites. The frontend derives the share
// URL https://queerpulse.com/invite/<code> from `code`.
export interface CreatedInviteView {
  code: string;
  expiresAt: Date;
  status: PublicInviteStatus;
}

@Injectable()
export class InvitesService {
  constructor(
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async createInvite(
    inviterId: string,
    opts: {
      email?: string | null;
      note?: string | null;
      vouch?: string | null;
    } = {},
  ): Promise<CreatedInviteView> {
    // Empty or whitespace-only notes/vouch are stored as null, not "".
    const trimmedNote = opts.note?.trim();
    const note = trimmedNote ? trimmedNote : null;
    const trimmedVouch = opts.vouch?.trim();
    const vouch = trimmedVouch ? trimmedVouch : null;
    const email = opts.email ?? null;
    const fields = { email, note, vouch, skipQuota: false, personal: true };

    for (let attempt = 1; ; attempt++) {
      const code = await this.generateUniqueCode();
      try {
        const saved = await this.dataSource.transaction((manager) =>
          this.mintInvite(manager, inviterId, code, fields),
        );
        return this.toCreatedView(saved);
      } catch (err) {
        // A code collision is astronomically unlikely, but the pre-check races
        // with concurrent inserts; retry with a fresh code before surfacing.
        if (isUniqueViolation(err) && attempt < MAX_CODE_ATTEMPTS) {
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Mints the invite that a join-request approval hands to the applicant, in
   * the CALLER'S transaction so the approval and the invite commit or roll back
   * together (no "approved but no invite" stuck state). Returns the id as well
   * as the code because the caller records it on `join_requests.invite_id`.
   *
   * Also used by `GenesisService` for the one-time founder bootstrap invite,
   * which needs identical semantics (quota-exempt, email-pinned, minted in the
   * caller's transaction). No behaviour here is genesis-specific.
   *
   * Two deliberate differences from `createInvite`:
   *
   * 1. The monthly quota is skipped. This is not the admin spending a personal
   *    invite, and with `INVITE_MONTHLY_QUOTA` defaulting to 1 an admin would
   *    otherwise be unable to clear the queue past their first approval of the
   *    month.
   * 2. There is no code-collision retry loop. A 23505 inside someone else's
   *    transaction has already aborted it, so retrying would just issue
   *    statements against a poisoned transaction. `generateUniqueCode` has
   *    already checked the code is free, so a collision here means a concurrent
   *    insert of the same 8-symbol code drawn from a 32-symbol alphabet; it
   *    surfaces as a 500 with the approval rolled back, and the admin retries.
   */
  async createInviteForApproval(
    manager: EntityManager,
    inviterId: string,
    email: string,
  ): Promise<{ id: string; code: string }> {
    const saved = await this.mintInvite(
      manager,
      inviterId,
      await this.generateUniqueCode(),
      // personal: false — an approval/bootstrap invite is not the inviter's
      // personal endorsement, so redeeming it must not auto-vouch them.
      { email, note: null, vouch: null, skipQuota: true, personal: false },
    );
    return { id: saved.id, code: saved.code };
  }

  private async mintInvite(
    manager: EntityManager,
    inviterId: string,
    code: string,
    fields: {
      email: string | null;
      note: string | null;
      vouch: string | null;
      skipQuota: boolean;
      personal: boolean;
    },
  ): Promise<Invite> {
    // Quota check + insert run under a per-inviter row lock so parallel
    // POST /invites requests serialize and can't each pass the check and
    // blow past the monthly limit.
    if (!fields.skipQuota) {
      await this.assertWithinMonthlyQuota(manager, inviterId);
    }
    const invite = manager.create(Invite, {
      inviterId,
      code,
      email: fields.email,
      note: fields.note,
      vouch: fields.vouch,
      personal: fields.personal,
      status: InviteStatus.Pending,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
    return manager.save(invite);
  }

  private toCreatedView(saved: Invite): CreatedInviteView {
    return {
      code: saved.code,
      expiresAt: saved.expiresAt as Date,
      status: resolveInviteStatus(saved, new Date()),
    };
  }

  // Public, unauthenticated read powering the recipient's invite landing page.
  // Returns only limited, non-sensitive fields (see toPublicInviteView).
  async resolveInvite(code: string): Promise<PublicInviteView> {
    const invite = await this.invites.findOne({ where: { code } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    const [inviter, memberCount] = await Promise.all([
      this.usersService.findByIdWithProfile(invite.inviterId),
      this.usersService.countActiveMembers(),
    ]);
    return toPublicInviteView(invite, inviter, memberCount, new Date());
  }

  // Returns a mapped view (never raw entities): whitelisted fields only, plus a
  // freshly-computed status so a not-yet-swept expiry reads as 'expired'.
  async listMyInvites(
    inviterId: string,
    page?: PageParams,
  ): Promise<MyInviteView[]> {
    const invites = await this.invites.find({
      where: { inviterId },
      order: { createdAt: 'DESC' },
      take: page?.limit ?? DEFAULT_PAGE_SIZE,
      skip: page?.offset ?? 0,
    });
    const now = new Date();
    return invites.map((invite) => toMyInviteView(invite, now));
  }

  /**
   * Validate an invite for a *new* Google sign-up, inside the caller's
   * transaction. Returns the inviteId + inviterId so the caller can create the
   * member (with invitedBy) and then claim the invite. Does NOT claim here —
   * the claim needs the new user's id for acceptedBy (see claimInvite).
   *
   * Also returns `personal` and `vouch` so the caller can auto-vouch the
   * inviter for the new member on personal invites, carrying the inviter's
   * "why I'm inviting you" note onto the vouch.
   */
  async validateInviteForSignup(
    manager: EntityManager,
    code: string,
    email: string,
  ): Promise<{
    inviteId: string;
    inviterId: string;
    personal: boolean;
    vouch: string | null;
  }> {
    const repo = manager.getRepository(Invite);
    const invite = await repo.findOne({ where: { code } });
    if (!invite || invite.status !== InviteStatus.Pending) {
      throw new SignupRejectedError('invite_invalid');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      // Persist the Expired marking on the non-transactional repo so it
      // survives the rollback triggered by the throw below (the caller runs
      // this inside a transaction it will roll back).
      // Conditional on status so we only expire a still-pending invite.
      await this.invites.update(
        { id: invite.id, status: InviteStatus.Pending },
        { status: InviteStatus.Expired },
      );
      throw new SignupRejectedError('invite_invalid');
    }
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      throw new SignupRejectedError('invite_invalid');
    }
    const inviter = await this.usersService.findById(invite.inviterId);
    if (!inviter || inviter.status !== UserStatus.Active) {
      throw new SignupRejectedError('invite_invalid');
    }
    return {
      inviteId: invite.id,
      inviterId: invite.inviterId,
      personal: invite.personal,
      vouch: invite.vouch,
    };
  }

  /**
   * Atomically claim a pending invite for the newly-created member. The
   * conditional update is the single-consume guard: a concurrent sign-up that
   * loses the race sees affected === 0 and is rejected instead of double-consuming.
   */
  async claimInvite(
    manager: EntityManager,
    inviteId: string,
    acceptedBy: string,
  ): Promise<void> {
    const claim = await manager
      .getRepository(Invite)
      .update(
        { id: inviteId, status: InviteStatus.Pending },
        { status: InviteStatus.Accepted, acceptedBy, usedAt: new Date() },
      );
    if (claim.affected !== 1) {
      throw new SignupRejectedError('invite_invalid');
    }
  }

  // Enforces "N invites per calendar month". Counts every invite the member
  // created since the start of the current UTC month regardless of status, so
  // revoking or letting one expire can't reclaim a slot. Runs inside the
  // caller's transaction and takes a write lock on the inviter row so parallel
  // POST /invites requests serialize through the check.
  private async assertWithinMonthlyQuota(
    manager: EntityManager,
    inviterId: string,
  ): Promise<void> {
    // Lock the inviter's row for the duration of the transaction. Per-user
    // override wins; NULL (or a missing user) falls back to the global default
    // configured via INVITE_MONTHLY_QUOTA (itself defaulting to 1).
    const inviter = await manager.getRepository(User).findOne({
      where: { id: inviterId },
      lock: { mode: 'pessimistic_write' },
    });
    const limit =
      inviter?.inviteMonthlyQuota ??
      this.config.get<number>('app.inviteMonthlyQuota', 1);
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const used = await manager.count(Invite, {
      where: { inviterId, createdAt: MoreThanOrEqual(monthStart) },
    });
    if (used >= limit) {
      throw new ForbiddenException(
        'Monthly invite limit reached. Try again next month.',
      );
    }
  }

  private generateCode(): string {
    const group = (): string => {
      const bytes = randomBytes(4);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      }
      return out;
    };
    return `QP-${group()}-${group()}`;
  }

  private async generateUniqueCode(): Promise<string> {
    let code = this.generateCode();
    while (await this.invites.exists({ where: { code } })) {
      code = this.generateCode();
    }
    return code;
  }
}

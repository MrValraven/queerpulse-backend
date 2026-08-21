import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { randomBytes } from 'node:crypto';
import {
  DataSource,
  EntityManager,
  In,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  EmailSuppression,
  hashSuppressedEmail,
} from '../account/entities/email-suppression.entity';
import { SignupRejectedError } from '../auth/errors/signup-rejected.error';
import { Invite, InviteStatus } from './entities/invite.entity';
import {
  InviteQuotaView,
  MyInviteView,
  PublicInviteStatus,
  PublicInviteView,
  resolveInviteStatus,
  toInviteQuotaView,
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

// Start of the current UTC calendar month — the lower bound of the "invites
// used this month" count. UTC (not local) so the reset instant is deterministic
// across deploy regions.
function currentMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Start of the NEXT UTC calendar month — when the allowance resets. Month index
// 12 rolls the year over correctly via Date.UTC normalization (Dec → next Jan).
function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface PageParams {
  limit?: number;
  offset?: number;
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
    // Fail fast on an invite pinned to an erasure-suppressed address. That
    // address deleted their account and can never sign up again (signup rejects
    // it with `account_suppressed`), so this is a dead invite — reject it at
    // mint time rather than letting the member spend a quota slot on a link that
    // can never be redeemed. Only the personal-invite path checks this; the
    // admin approval / genesis mint (createInviteForApproval) is exempt.
    if (email && (await this.isEmailSuppressed(email))) {
      throw new ConflictException(
        'That email address can’t be invited — its owner has left the platform.',
      );
    }
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
   *    invite, and with `INVITE_MONTHLY_QUOTA` defaulting to 5 an admin would
   *    otherwise be unable to clear the queue past their first few approvals of
   *    the month.
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
  // freshly-computed status so a not-yet-swept expiry reads as 'expired'. For
  // any 'used' invite the redeemer (acceptedBy) is batch-loaded WITH profile in
  // a single query — never per-row — and mapped to public fields only.
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
    // Collect the redeemer ids for accepted invites and resolve them in one
    // `IN (...)` query, then index by id so the map below is O(1) per row.
    const acceptedByIds = Array.from(
      new Set(
        invites
          .filter((invite) => invite.status === InviteStatus.Accepted)
          .map((invite) => invite.acceptedBy)
          .filter((id): id is string => id !== null),
      ),
    );
    const acceptedByUsers =
      await this.usersService.findByIdsWithProfile(acceptedByIds);
    const usersById = new Map(acceptedByUsers.map((user) => [user.id, user]));
    return invites.map((invite) =>
      toMyInviteView(
        invite,
        now,
        invite.acceptedBy ? usersById.get(invite.acceptedBy) : null,
      ),
    );
  }

  /**
   * Cancel one of the inviter's own still-pending invites, addressed by its
   * `code` (the identifier the inviter's own invite list, `listMyInvites`,
   * exposes — that view deliberately omits internal ids). Sets the status to
   * `Revoked` so the shared link stops working: a Revoked invite fails
   * `validateInviteForSignup`'s `status !== Pending` check at redemption, and
   * the recipient's landing page resolves it as 'revoked'.
   *
   * Ownership + terminal-state guards, all returning a mapped view (never the
   * raw entity):
   *  - 404 if no invite with that code exists;
   *  - 403 if the invite belongs to another member (never act on, or confirm
   *    the existence of, another member's invite);
   *  - 409 if it was already accepted (redeemed — nothing to cancel) or is
   *    already expired (a terminal state a revoke can't meaningfully change);
   *  - already-revoked is an idempotent no-op: returns the current view.
   *
   * The write is a conditional `status = Pending` update (mirroring
   * `claimInvite`'s single-consume guard) so a redemption racing the revoke
   * can't both win — the loser sees `affected === 0` and re-reads the true
   * terminal state to report.
   */
  async revokeInvite(inviterId: string, code: string): Promise<MyInviteView> {
    const now = new Date();
    const invite = await this.invites.findOne({ where: { code } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.inviterId !== inviterId) {
      throw new ForbiddenException('This invite belongs to another member.');
    }
    if (invite.status === InviteStatus.Accepted) {
      throw new ConflictException(
        'This invite has already been accepted and can’t be revoked.',
      );
    }
    if (invite.status === InviteStatus.Revoked) {
      // Idempotent: revoking an already-revoked invite is a no-op.
      return toMyInviteView(invite, now);
    }
    if (invite.status === InviteStatus.Expired) {
      throw new ConflictException(
        'This invite has already expired, so there’s nothing to revoke.',
      );
    }

    const result = await this.invites.update(
      { id: invite.id, inviterId, status: InviteStatus.Pending },
      { status: InviteStatus.Revoked },
    );
    if (result.affected !== 1) {
      // Lost a race with a redemption (or a concurrent revoke) that flipped the
      // status out from under us — re-read to report the real terminal state.
      const current = await this.invites.findOne({ where: { id: invite.id } });
      if (!current) {
        throw new NotFoundException('Invite not found');
      }
      if (current.status === InviteStatus.Revoked) {
        return toMyInviteView(current, now);
      }
      if (current.status === InviteStatus.Accepted) {
        throw new ConflictException(
          'This invite has already been accepted and can’t be revoked.',
        );
      }
      throw new ConflictException('Only a pending invite can be revoked.');
    }

    const revoked = await this.invites.findOne({ where: { id: invite.id } });
    // The conditional update just succeeded, so the row is present; the
    // non-null assertion documents that invariant for the type checker. A
    // revoked invite is never 'used', so acceptedBy is always null here.
    return toMyInviteView(revoked!, now);
  }

  /**
   * Re-mint one of the inviter's OWN invites that has lapsed, addressed by its
   * `code`. Refreshes the SAME row — resets `expires_at` to now + INVITE_TTL and
   * flips the status back to Pending — so the original share link works again.
   *
   * Deliberately quota-NEUTRAL: this is the same invitation, not a new one. The
   * monthly quota counts every invite created since the UTC month start
   * regardless of status (see `assertWithinMonthlyQuota`), and this reuses the
   * existing row (createdAt unchanged), so no new slot is consumed and none is
   * reclaimed — it stays counted exactly once, in the month it was first minted.
   *
   * Only an EXPIRED invite is resendable. Guards, all returning a mapped view:
   *  - 404 if no invite with that code exists;
   *  - 403 if it belongs to another member;
   *  - 409 if it was accepted (redeemed — resending would re-open a used invite),
   *    revoked (a revoke is deliberate and stays revoked), or still valid
   *    (nothing to resend yet).
   *
   * The write is a conditional update guarded on the row still being resendable
   * (status IN pending/expired). A pending row can be past its `expires_at` but
   * not yet swept — it resolves to 'expired' and is resendable; a redemption
   * racing the resend flips it to Accepted, the loser sees `affected === 0` and
   * re-reads the true terminal state to report (mirrors `revokeInvite`).
   */
  async resendInvite(inviterId: string, code: string): Promise<MyInviteView> {
    const now = new Date();
    const invite = await this.invites.findOne({ where: { code } });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.inviterId !== inviterId) {
      throw new ForbiddenException('This invite belongs to another member.');
    }
    const status = resolveInviteStatus(invite, now);
    if (status === 'used') {
      throw new ConflictException(
        'This invite has already been accepted, so it can’t be resent.',
      );
    }
    if (status === 'revoked') {
      throw new ConflictException(
        'This invite was revoked. Create a new invite instead.',
      );
    }
    if (status !== 'expired') {
      // Still valid — the existing link works, nothing to resend.
      throw new ConflictException(
        'This invite is still active, so there’s nothing to resend.',
      );
    }

    const refreshedExpiry = new Date(now.getTime() + INVITE_TTL_MS);
    const result = await this.invites.update(
      // Resendable == not yet in a terminal accepted/revoked state. A lazily
      // unexpired row is still `Pending` in the DB; a swept one is `Expired`.
      {
        id: invite.id,
        inviterId,
        status: In([InviteStatus.Pending, InviteStatus.Expired]),
      },
      { status: InviteStatus.Pending, expiresAt: refreshedExpiry },
    );
    if (result.affected !== 1) {
      // Lost a race with a redemption that claimed the invite between our read
      // and the update — re-read to report the real terminal state.
      const current = await this.invites.findOne({ where: { id: invite.id } });
      if (!current) {
        throw new NotFoundException('Invite not found');
      }
      if (current.status === InviteStatus.Accepted) {
        throw new ConflictException(
          'This invite has already been accepted, so it can’t be resent.',
        );
      }
      throw new ConflictException(
        'This invite could not be resent. Please try again.',
      );
    }

    const resent = await this.invites.findOne({ where: { id: invite.id } });
    // Just-refreshed to Pending with a future expiry, so it resolves to 'valid'
    // and is never 'used' — acceptedBy is null.
    return toMyInviteView(resent!, now);
  }

  // Read-only quota snapshot for the compose page's "N invites available this
  // month" panel. Deliberately takes NO row lock (unlike enforcement) — a stale
  // read here at worst shows a number one off for a moment, and the real POST
  // still serializes through the locked check. Reuses resolveMonthlyLimit +
  // currentMonthStart so the displayed number matches the enforced one.
  async getQuota(inviterId: string): Promise<InviteQuotaView> {
    const now = new Date();
    const [inviter, used, memberCount] = await Promise.all([
      this.usersService.findById(inviterId),
      this.invites.count({
        where: { inviterId, createdAt: MoreThanOrEqual(currentMonthStart(now)) },
      }),
      this.usersService.countActiveMembers(),
    ]);
    const limit = this.resolveMonthlyLimit(inviter);
    return toInviteQuotaView(limit, used, nextMonthStart(now), memberCount);
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
      // Distinct reason: the invite was pinned to a different address than the
      // one this Google account signs in with (see SignupRejectedError).
      throw new SignupRejectedError('invite_email_mismatch');
    }
    const inviter = await this.usersService.findById(invite.inviterId);
    if (!inviter || inviter.status !== UserStatus.Active) {
      // Distinct reason: the code is well-formed and unredeemed, but the member
      // who sent it is no longer active, so redeeming it can't create the
      // inviter→member vouch/connection the invite promises.
      throw new SignupRejectedError('invite_inviter_inactive');
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

  // Per-user override wins; NULL (or a missing user) falls back to the global
  // default configured via INVITE_MONTHLY_QUOTA. Shared by the enforcement path
  // (assertWithinMonthlyQuota) and the read path (getQuota) so they never drift.
  private resolveMonthlyLimit(inviter: User | null): number {
    return (
      inviter?.inviteMonthlyQuota ??
      this.config.get<number>('app.inviteMonthlyQuota', 5)
    );
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
    // configured via INVITE_MONTHLY_QUOTA (itself defaulting to 5).
    const inviter = await manager.getRepository(User).findOne({
      where: { id: inviterId },
      lock: { mode: 'pessimistic_write' },
    });
    const limit = this.resolveMonthlyLimit(inviter);
    const now = new Date();
    const monthStart = currentMonthStart(now);
    const used = await manager.count(Invite, {
      where: { inviterId, createdAt: MoreThanOrEqual(monthStart) },
    });
    if (used >= limit) {
      throw new ForbiddenException(
        'Monthly invite limit reached. Try again next month.',
      );
    }
  }

  // Reuses the erasure suppression list — the same check `AuthService` runs at
  // signup — so an invite to an address that deleted its account fails at mint
  // instead of at redemption. Reads the repo off the DataSource (the entity is
  // registered by AccountModule/AuthModule and autoloaded) rather than taking a
  // new constructor dependency. Only ever called with a non-empty email.
  private async isEmailSuppressed(email: string): Promise<boolean> {
    const hit = await this.dataSource.getRepository(EmailSuppression).findOne({
      where: { emailHash: hashSuppressedEmail(email) },
    });
    return hit !== null;
  }

  private generateCode(): string {
    const group = (): string => {
      const bytes = randomBytes(4);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        const byteValue = bytes[i];
        if (byteValue === undefined) continue;
        out += CODE_ALPHABET[byteValue % CODE_ALPHABET.length] ?? '';
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

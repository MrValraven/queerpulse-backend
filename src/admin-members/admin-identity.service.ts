import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Not, Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import {
  IdentityRelinkCandidate,
  IdentityRelinkCandidateStatus,
} from '../auth/entities/identity-relink-candidate.entity';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import {
  DeletionRequest,
  DeletionRequestStatus,
} from '../account/entities/deletion-request.entity';
import {
  EmailSuppression,
  hashSuppressedEmail,
} from '../account/entities/email-suppression.entity';
import { isUniqueViolation } from '../common/db-errors';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import {
  EmailSuppressionLiftedDTO,
  EmailSuppressionLookupDTO,
  googleIdTail,
  MemberAccountRecoveryDTO,
  ReactivatedMemberDTO,
  RelinkDecisionDTO,
  toRelinkCandidate,
} from './admin-identity-response';

/**
 * How much of the suppression hash the console and the audit trail quote.
 *
 * Enough to name one row in a ticket, far too little to be a lookup key for
 * anybody who does not already hold the address. The table stores a hash
 * precisely so that "who has ever left" is not bulk-readable, and printing the
 * whole digest into an audit feed every moderator can read would give that back.
 */
const SUPPRESSION_HASH_PREFIX_LENGTH = 12;

/** Cap on how much candidate history one member's panel returns. Pending rows
 *  are what the operator acts on; the decided tail is context. */
const CANDIDATE_HISTORY_LIMIT = 20;

/**
 * The three admin levers that stop an accident from stranding somebody
 * permanently (PRD-06, PRD-11, PRD-13).
 *
 * Each of the three undoes a state the platform entered ON PURPOSE, and each
 * previously had exactly one remedy: a hand-written statement against the
 * production database. That is a bad remedy for the obvious reason (no review,
 * no trail, no undo) and for a subtler one: it is available to whoever holds
 * database credentials, which is a different and usually larger set of people
 * than "admins", and it leaves no record that distinguishes a rescue from a
 * theft. Every lever here writes a `mod_audit_logs` row in the same transaction
 * as its effect, so the trail can never disagree with the state.
 *
 * Kept out of `AdminMembersService` deliberately. That service is the member
 * console's read model plus role management; these are account-recovery
 * operations with their own guardrails, their own entities and a much sharper
 * blast radius, and mixing them would bury that.
 */
@Injectable()
export class AdminIdentityService {
  private readonly logger = new Logger(AdminIdentityService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(IdentityRelinkCandidate)
    private readonly relinkCandidates: Repository<IdentityRelinkCandidate>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    @InjectRepository(EmailSuppression)
    private readonly emailSuppressions: Repository<EmailSuppression>,
    @InjectRepository(AccountDeactivation)
    private readonly deactivations: Repository<AccountDeactivation>,
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    // For `revokeAllForUser` after a re-link. `AuthModule` exports `AuthService`
    // and reaches nothing in this module, so this edge closes no cycle.
    private readonly auth: AuthService,
  ) {}

  /* ── PRD-06: re-link a Google identity ─────────────────────────────────── */

  /**
   * The member console's account-recovery panel, in one read: every Google
   * identity that has presented this account's verified address, whether the
   * re-link lever is open, and whether this member is one of the stranded
   * `Deactivated` accounts PRD-11 describes.
   *
   * Both levers answer here rather than from two endpoints because an operator
   * opening a locked-out member's drawer does not yet know which situation they
   * are in, and because `reactivation.isApplicable` is the only way the console
   * can learn the member is deactivated: the member detail DTO carries no
   * account status.
   */
  async getAccountRecovery(
    actorUserId: string,
    memberId: string,
  ): Promise<MemberAccountRecoveryDTO> {
    const profile = await this.requireProfile(memberId);
    const target = await this.requireUser(memberId);
    const blockedReason = await this.relinkBlockedReason(actorUserId, target);
    const reactivationBlockedReason =
      await this.reactivationBlockedReason(target);

    const candidates = await this.relinkCandidates
      .createQueryBuilder('candidate')
      // `google_id` is `select: false` on the entity (it is auth PII), so the
      // read has to opt back in. `toRelinkCandidate` then publishes only the
      // last six characters.
      .addSelect('candidate.googleId')
      .where('candidate.userId = :memberId', { memberId })
      .orderBy('candidate.lastSeenAt', 'DESC')
      .limit(CANDIDATE_HISTORY_LIMIT)
      .getMany();

    // Pending first whatever their age, because those are the only rows the
    // operator can act on; decided rows follow newest-first as context. Done in
    // memory rather than as a SQL `CASE`: the set is already capped at
    // `CANDIDATE_HISTORY_LIMIT`, and a raw ordering expression here would be one
    // more place a status label has to stay spelled correctly.
    const pendingFirst = [
      ...candidates.filter(
        (candidate) =>
          candidate.status === IdentityRelinkCandidateStatus.Pending,
      ),
      ...candidates.filter(
        (candidate) =>
          candidate.status !== IdentityRelinkCandidateStatus.Pending,
      ),
    ];

    return {
      memberId,
      slug: profile.slug,
      relink: {
        isAvailable: blockedReason === null,
        blockedReason,
        candidates: pendingFirst.map(toRelinkCandidate),
      },
      reactivation: {
        isApplicable: target.status === UserStatus.Deactivated,
        isAvailable: reactivationBlockedReason === null,
        blockedReason: reactivationBlockedReason,
      },
    };
  }

  /**
   * Re-point this member's account at the Google identity `candidateId` names.
   *
   * THE SAFETY ARGUMENT, in one place, because every part of it is load-bearing:
   *
   *  1. The new identity is never supplied by the operator. It comes from an
   *     `identity_relink_candidates` row, and the only writer of a pending row
   *     is `AuthService.validateOrCreateGoogleUser`, reached after
   *     `GoogleStrategy.validate` has refused anything without
   *     `email_verified: true`. So the identity being linked has already proven
   *     control of THIS account's own email address. An operator who wants to
   *     hand an account to an accomplice would first have to make Google assert
   *     the member's address for the accomplice's subject, which is a loss that
   *     already happened before QueerPulse got involved. `ApplyRelinkDto`
   *     carries no `googleId` field and `forbidNonWhitelisted` refuses one.
   *  2. Staff accounts are refused outright. See {@link relinkBlockedReason}.
   *  3. The write is conditional on the account still holding the `google_id`
   *     this decision was computed against, so concurrent decisions resolve to
   *     one winner rather than overwriting each other.
   *  4. Every session dies, after the commit. A re-link changes who controls
   *     the account; a token minted under the old subject must not outlive it.
   *  5. It is audited with both subjects' tails and the operator's reason.
   */
  async applyRelink(
    actorUserId: string,
    memberId: string,
    candidateId: string,
    reason: string,
  ): Promise<RelinkDecisionDTO> {
    const profile = await this.requireProfile(memberId);
    const decidedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      // Re-check the guardrails INSIDE the transaction against a freshly loaded
      // row. The panel read that produced this button may be minutes old, and
      // the member could have been promoted to moderator since.
      const target = await manager
        .createQueryBuilder(User, 'user')
        .addSelect('user.googleId')
        .where('user.id = :memberId', { memberId })
        .getOne();
      if (!target) throw new NotFoundException('Member not found');
      const blockedReason = await this.relinkBlockedReason(
        actorUserId,
        target,
        manager,
      );
      if (blockedReason) throw new ForbiddenException(blockedReason);

      const candidate = await manager
        .createQueryBuilder(IdentityRelinkCandidate, 'candidate')
        .addSelect('candidate.googleId')
        .where('candidate.id = :candidateId', { candidateId })
        .getOne();
      // Scoped to this member as well as this id: a candidate id belonging to
      // somebody else must read as "not found" here rather than acting on the
      // wrong account.
      if (!candidate || candidate.userId !== memberId) {
        throw new NotFoundException('Sign-in identity candidate not found');
      }
      if (candidate.status !== IdentityRelinkCandidateStatus.Pending) {
        throw new ConflictException(
          'This sign-in identity has already been decided.',
        );
      }

      const previousGoogleId = target.googleId;
      let didRelink: boolean;
      try {
        didRelink = await this.auth.applyGoogleIdRelink(
          manager,
          memberId,
          previousGoogleId,
          candidate.googleId,
        );
      } catch (error) {
        // `users.google_id` is unique. Another account claiming this subject in
        // the meantime is a real conflict rather than a server fault.
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'Another account already signs in with that Google identity.',
          );
        }
        throw error;
      }
      if (!didRelink) {
        throw new ConflictException(
          'This member’s sign-in identity changed while you were deciding. Reload and try again.',
        );
      }

      await manager.update(
        IdentityRelinkCandidate,
        { id: candidateId, status: IdentityRelinkCandidateStatus.Pending },
        {
          status: IdentityRelinkCandidateStatus.Applied,
          decidedByUserId: actorUserId,
          decidedAt,
          decisionNote: reason,
        },
      );
      // Every other identity still knocking on this account is retired. Leaving
      // them pending would keep offering an operator a second way into an
      // account that has just been handed to someone.
      await manager.update(
        IdentityRelinkCandidate,
        {
          userId: memberId,
          status: IdentityRelinkCandidateStatus.Pending,
          id: Not(candidateId),
        },
        { status: IdentityRelinkCandidateStatus.Superseded },
      );

      await this.writeAudit(manager, {
        actorUserId,
        targetUserId: memberId,
        targetName: this.nameOf(profile),
        action: 'sign_in_identity_relinked',
        note: `google …${googleIdTail(previousGoogleId)} → …${googleIdTail(candidate.googleId)} · ${reason}`,
      });
    });

    // AFTER the commit, deliberately. `revokeAllForUser` emits
    // `USER_SESSION_REVOKED`, which other modules act on by dropping live
    // sockets; firing that from inside a transaction that could still roll back
    // would sign someone out of a re-link that never happened.
    await this.auth.revokeAllForUser(memberId);
    this.logger.warn(
      `Sign-in identity re-linked: memberId=${memberId} actorId=${actorUserId} (all sessions revoked)`,
    );

    return {
      memberId,
      candidateId,
      status: 'applied',
      decidedAt: decidedAt.toISOString(),
    };
  }

  /**
   * Refuse a candidate. Recorded rather than deleted: "somebody who is not this
   * member holds a Google account on their address, and an admin looked at it
   * and said no" is a fact worth keeping, and a dismissed row can never return
   * to pending (see `AuthService.recordRelinkCandidate`).
   */
  async dismissRelink(
    actorUserId: string,
    memberId: string,
    candidateId: string,
    reason: string,
  ): Promise<RelinkDecisionDTO> {
    const profile = await this.requireProfile(memberId);
    const decidedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      const candidate = await manager.findOne(IdentityRelinkCandidate, {
        where: { id: candidateId },
      });
      if (!candidate || candidate.userId !== memberId) {
        throw new NotFoundException('Sign-in identity candidate not found');
      }
      if (candidate.status !== IdentityRelinkCandidateStatus.Pending) {
        throw new ConflictException(
          'This sign-in identity has already been decided.',
        );
      }
      await manager.update(
        IdentityRelinkCandidate,
        { id: candidateId, status: IdentityRelinkCandidateStatus.Pending },
        {
          status: IdentityRelinkCandidateStatus.Dismissed,
          decidedByUserId: actorUserId,
          decidedAt,
          decisionNote: reason,
        },
      );
      await this.writeAudit(manager, {
        actorUserId,
        targetUserId: memberId,
        targetName: this.nameOf(profile),
        action: 'sign_in_identity_candidate_dismissed',
        note: reason,
      });
    });

    return {
      memberId,
      candidateId,
      status: 'dismissed',
      decidedAt: decidedAt.toISOString(),
    };
  }

  /**
   * Why the re-link lever is closed for this member, or `null` when it is open.
   *
   * Returns the operator-facing sentence rather than a code, because the whole
   * point of it is to be read. A blocked lever that says nothing gets logged as
   * a bug; a blocked lever that names the way round it gets used.
   *
   * THE STAFF-ACCOUNT REFUSAL is the important one. Re-linking a moderator's or
   * admin's account would hand platform powers to whoever holds the new
   * identity, and a single compromised admin account could use it to take a
   * second staff account and then remove the legitimate one. Refusing outright
   * closes that path without inventing a second-signature mechanism, because
   * the platform ALREADY has the two-person control this case needs: an admin
   * cannot change their own role (`AdminMembersService.updateRole`), so
   * demoting a locked-out moderator is necessarily a different admin's act, and
   * it is audited. Demote, re-link, restore the role. The last admin can never
   * be demoted (the last-admin guard), so the last admin can never be
   * re-linked, which is the correct fail-closed answer: the one account that
   * could hand away the whole platform stays on the database break-glass.
   */
  private async relinkBlockedReason(
    actorUserId: string,
    target: Pick<User, 'id' | 'role' | 'isSystem' | 'status'>,
    manager?: EntityManager,
  ): Promise<string | null> {
    if (target.id === actorUserId) {
      return 'You can’t re-link your own sign-in identity. Ask another admin to do it.';
    }
    if (target.isSystem) {
      return 'The house account’s sign-in identity can’t be re-linked.';
    }
    if (target.role !== UserRole.Member) {
      return 'Re-link is refused on staff accounts, because it would hand moderator or admin powers to whoever holds the new identity. Remove their role first (another admin has to do that, and it is audited), re-link, then restore the role.';
    }
    const staffRoleRepo = manager
      ? manager.getRepository(UserStaffRole)
      : this.staffRoles;
    const hasStaffGrant = await staffRoleRepo.exists({
      where: { userId: target.id },
    });
    if (hasStaffGrant) {
      return 'Re-link is refused while this member holds a staff role, because it would hand that role to whoever holds the new identity. Revoke their staff roles first, re-link, then grant them back.';
    }
    const deletionRepo = manager
      ? manager.getRepository(DeletionRequest)
      : this.deletionRequests;
    const pendingDeletion = await deletionRepo.exists({
      where: [
        { userId: target.id, status: DeletionRequestStatus.Grace },
        { userId: target.id, status: DeletionRequestStatus.Processing },
      ],
    });
    if (pendingDeletion) {
      return 'This member has asked to be erased. Re-linking now would hand an account to someone the platform is under instruction to delete. They cancel the deletion themselves, or it completes.';
    }
    return null;
  }

  /* ── PRD-11: reactivate a stranded member ──────────────────────────────── */

  /**
   * Put back a member left `Deactivated` with no open deactivation row.
   *
   * NARROW ON PURPOSE, and every refusal below preserves a behaviour that was
   * deliberate somewhere else:
   *
   *  - Not `Deactivated` → nothing to do. This is a repair for one specific
   *    inconsistency, never a general "set this account active" writer.
   *  - An OPEN deactivation row → refused, and the operator is told the member
   *    already has the way back that `AuthService.reactivateIfDeactivated`
   *    promises: sign in. Reactivating for them would un-pause an account
   *    somebody chose to pause.
   *  - A deletion request in `grace` or `processing` → refused. This is the
   *    exact case `reactivateIfDeactivated` documents in red: both states share
   *    `status = Deactivated` and they mean opposite things. Cancelling an
   *    erasure from an admin console would be very wrong.
   *  - A live suspension (`suspendedUntil` in the future) → refused. Restoring
   *    `Active` would launder a moderation action, which is the same reason
   *    `AccountEnforcementService.restoreUser` preserves `Deactivated` and the
   *    same reason reactivation restores `previousStatus` rather than a
   *    hardcoded `Active`. Lift the suspension through the moderation surface,
   *    which is audited as a moderation decision and tells the member.
   *
   * What is left after those four is only the stranded case the finding
   * describes: `Deactivated` with no ledger row, no erasure and no sanction, a
   * state the member cannot get out of by signing in and which nothing else can
   * repair.
   */
  async reactivateMember(
    actorUserId: string,
    memberId: string,
    reason: string,
  ): Promise<ReactivatedMemberDTO> {
    const profile = await this.requireProfile(memberId);
    const reactivatedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      const target = await manager.findOne(User, { where: { id: memberId } });
      if (!target) throw new NotFoundException('Member not found');

      // Re-computed here against a freshly loaded row, through the SAME method
      // the panel read uses. One source of truth for the four refusals means
      // the button an operator sees and the answer they get can never disagree.
      const blockedReason = await this.reactivationBlockedReason(
        target,
        manager,
      );
      if (blockedReason) throw new ConflictException(blockedReason);

      // Conditional on the status we just read, so two admins clicking at once
      // produce one reactivation and one 409 rather than two audit rows.
      const result = await manager.update(
        User,
        { id: memberId, status: UserStatus.Deactivated },
        { status: UserStatus.Active },
      );
      if ((result.affected ?? 0) !== 1) {
        throw new ConflictException(
          'This member’s status changed while you were deciding. Reload and try again.',
        );
      }

      await this.writeAudit(manager, {
        actorUserId,
        targetUserId: memberId,
        targetName: this.nameOf(profile),
        action: 'account_reactivated_by_admin',
        note: `${UserStatus.Deactivated} → ${UserStatus.Active} (no open deactivation row) · ${reason}`,
      });
    });

    return {
      memberId,
      slug: profile.slug,
      status: UserStatus.Active,
      reactivatedAt: reactivatedAt.toISOString(),
    };
  }

  /**
   * Why reactivation is refused for this member, or `null` when the stranded
   * case applies. Shared by the panel read and the write.
   *
   * The four refusals are the whole safety story of this lever, and each one
   * preserves a decision that was deliberate somewhere else. See the essay on
   * {@link reactivateMember}.
   */
  private async reactivationBlockedReason(
    target: Pick<User, 'id' | 'status' | 'suspendedUntil'>,
    manager?: EntityManager,
  ): Promise<string | null> {
    if (target.status !== UserStatus.Deactivated) {
      return `This member is ${target.status}. Reactivation only applies to a deactivated account.`;
    }
    const deactivationRepo = manager
      ? manager.getRepository(AccountDeactivation)
      : this.deactivations;
    const hasOpenDeactivation = await deactivationRepo.exists({
      where: { userId: target.id, reactivatedAt: IsNull() },
    });
    if (hasOpenDeactivation) {
      return 'This member paused their own account, and signing in with Google brings them back on its own. Reactivating for them would undo a choice they made.';
    }
    const deletionRepo = manager
      ? manager.getRepository(DeletionRequest)
      : this.deletionRequests;
    const hasPendingDeletion = await deletionRepo.exists({
      where: [
        { userId: target.id, status: DeletionRequestStatus.Grace },
        { userId: target.id, status: DeletionRequestStatus.Processing },
      ],
    });
    if (hasPendingDeletion) {
      return 'This member asked to be erased. Only they can cancel that, from their own account settings.';
    }
    if (target.suspendedUntil && target.suspendedUntil > new Date()) {
      return 'This member is under a live suspension. Lift the suspension through the moderation tools first, so the decision is recorded as a moderation outcome and the member is told.';
    }
    return null;
  }

  /* ── PRD-13: lift an email suppression ─────────────────────────────────── */

  /**
   * Is this address on the erasure suppression list, and since when?
   *
   * A read rather than a side effect, so that lifting is never the way an
   * operator finds out. Answers for an address that is NOT suppressed too:
   * "no row" is the answer to most tickets of this kind, and making the
   * operator infer it from a 404 on the lift would be worse.
   */
  async lookupSuppression(email: string): Promise<EmailSuppressionLookupDTO> {
    const emailHash = hashSuppressedEmail(email);
    const row = await this.emailSuppressions.findOne({ where: { emailHash } });
    return {
      email,
      isSuppressed: row !== null,
      emailHashPrefix: emailHash.slice(0, SUPPRESSION_HASH_PREFIX_LENGTH),
      reason: row?.reason ?? null,
      suppressedAt: row ? row.createdAt.toISOString() : null,
    };
  }

  /**
   * Remove one suppression row so this address can create a NEW account.
   *
   * BE PRECISE ABOUT WHAT THIS UNDOES, because the wording is the safeguard.
   * The suppression list is permanent by design: it is the promise the
   * delete-account UI makes, that erasing your account will not be quietly
   * reversed by signing in again. Lifting a row does NOT restore anything. The
   * erased account is gone (`AccountDeletionProcessorService` deleted it), its
   * content is severed, and nothing here brings any of it back. All this does
   * is stop refusing a fresh signup on that address, which is the correct
   * remedy for exactly two situations: a person who changed their mind and
   * wants to start over, and an erasure that was made in error.
   *
   * It is the reason this lever is a correction rather than routine, why the
   * reason is mandatory, and why the audit row names what was removed. The
   * audit note carries the hash prefix and the original suppression's own
   * reason and date, never the address: writing the plaintext into a permanent,
   * moderator-readable log would put back the PII the erasure took out.
   */
  async liftSuppression(
    actorUserId: string,
    email: string,
    reason: string,
  ): Promise<EmailSuppressionLiftedDTO> {
    const emailHash = hashSuppressedEmail(email);
    const liftedAt = new Date();

    await this.dataSource.transaction(async (manager) => {
      const row = await manager.findOne(EmailSuppression, {
        where: { emailHash },
      });
      if (!row) {
        throw new NotFoundException(
          'That address is not on the suppression list.',
        );
      }
      await manager.delete(EmailSuppression, { id: row.id });
      await this.writeAudit(manager, {
        actorUserId,
        // No `targetUserId`: the account this row protected was erased, which
        // is the entire reason the row exists. `targetName` stays null too,
        // rather than carrying the address.
        targetUserId: null,
        targetName: null,
        action: 'email_suppression_lifted',
        note: `suppression ${emailHash.slice(0, SUPPRESSION_HASH_PREFIX_LENGTH)} (added ${row.createdAt.toISOString()}, reason ${row.reason}) · ${reason}`,
      });
    });

    this.logger.warn(
      `Email suppression lifted: hashPrefix=${emailHash.slice(0, SUPPRESSION_HASH_PREFIX_LENGTH)} actorId=${actorUserId}`,
    );

    return {
      email,
      isSuppressed: false,
      emailHashPrefix: emailHash.slice(0, SUPPRESSION_HASH_PREFIX_LENGTH),
      liftedAt: liftedAt.toISOString(),
    };
  }

  /* ── shared ────────────────────────────────────────────────────────────── */

  /**
   * One `mod_audit_logs` row, in the caller's transaction.
   *
   * The same trail `updateRole`, `grantStaffRole`, `revokeStaffRole` and
   * `updateInviteQuota` already write, reached the same way: `reportId` null
   * (none of these responds to a report), `targetName` denormalized at write
   * time so the row still names the member after an erasure NULLs
   * `targetUserId`. Writing through the caller's `manager` is what stops the
   * trail and the state disagreeing.
   */
  private async writeAudit(
    manager: EntityManager,
    entry: {
      actorUserId: string;
      targetUserId: string | null;
      targetName: string | null;
      action: string;
      note: string;
    },
  ): Promise<void> {
    const auditLogs = manager.getRepository(ModAuditLog);
    await auditLogs.save(
      auditLogs.create({
        reportId: null,
        actorId: entry.actorUserId,
        targetUserId: entry.targetUserId,
        targetName: entry.targetName,
        action: entry.action,
        reasonCode: null,
        note: entry.note,
        duration: null,
      }),
    );
  }

  private async requireProfile(memberId: string): Promise<Profile> {
    const profile = await this.profiles.findOne({
      where: { userId: memberId },
    });
    if (!profile) throw new NotFoundException('Member not found');
    return profile;
  }

  private async requireUser(memberId: string): Promise<User> {
    const user = await this.users.findOne({ where: { id: memberId } });
    if (!user) throw new NotFoundException('Member not found');
    return user;
  }

  private nameOf(profile: Profile): string {
    return `${profile.firstName} ${profile.lastName}`.trim();
  }
}

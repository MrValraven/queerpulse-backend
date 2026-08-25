import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { AdminMemberModerationService } from './admin-member-moderation.service';

const now = new Date('2026-08-05T10:00:00.000Z');

/**
 * `expect.any` is typed to return `any` in @types/jest, which poisons the
 * object-literal position it sits in with `no-unsafe-assignment`. This
 * narrows the return type to what it actually stands in for here without
 * changing what runs — still `expect.any(Date)` underneath.
 */
function matchAnyDate(): Date {
  return expect.any(Date) as Date;
}

function profileRow(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'member-1',
    slug: 'jamie',
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    ...overrides,
  } as unknown as Profile;
}

function build() {
  const profiles = {
    findOne: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
  };
  // `citeMember` (ADM-9) writes `mod_audit_logs` rows directly (targetUserId/
  // targetName), bypassing `ModAuditService.writeAuditLog` — so it needs its
  // own repository mock, not the `audit` service stub below.
  const auditLogs = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn((row: Record<string, unknown>) =>
      Promise.resolve({ ...row, id: 'audit-1', createdAt: now }),
    ),
  };
  const enforcement = { restrictMember: jest.fn() };
  const audit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };
  const notifications = { create: jest.fn().mockResolvedValue(undefined) };
  const auth = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };

  const service = new AdminMemberModerationService(
    profiles as never,
    auditLogs as never,
    enforcement as never,
    audit as never,
    notifications as never,
    auth as never,
  );
  return {
    service,
    profiles,
    auditLogs,
    enforcement,
    audit,
    notifications,
    auth,
  };
}

describe('AdminMemberModerationService', () => {
  describe('verifyMember', () => {
    it('404s when the member has no profile', async () => {
      const { service, profiles } = build();
      profiles.findOne.mockResolvedValue(null);

      await expect(
        service.verifyMember('admin-1', 'member-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stamps verification and writes an audit row on first verify', async () => {
      const { service, profiles, audit } = build();
      profiles.findOne.mockResolvedValue(profileRow({ verified: false }));

      const result = await service.verifyMember('admin-1', 'member-1');

      expect(profiles.save).toHaveBeenCalledWith(
        expect.objectContaining({
          verified: true,
          verifiedBy: 'admin-1',
          verifiedAt: matchAnyDate(),
        }),
      );
      expect(audit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'admin-1',
        'member_verified',
      );
      expect(result.verified).toBe(true);
    });

    it('is idempotent — an already-verified member is not re-stamped or re-audited', async () => {
      const { service, profiles, audit } = build();
      profiles.findOne.mockResolvedValue(
        profileRow({
          verified: true,
          verifiedAt: now,
          verifiedBy: 'earlier-admin',
        }),
      );

      const result = await service.verifyMember('admin-1', 'member-1');

      expect(profiles.save).not.toHaveBeenCalled();
      expect(audit.writeAuditLog).not.toHaveBeenCalled();
      expect(result.verifiedAt).toBe(now.toISOString());
    });
  });

  describe('citeMember', () => {
    it('404s when the member has no profile', async () => {
      const { service, profiles } = build();
      profiles.findOne.mockResolvedValue(null);

      await expect(
        service.citeMember('admin-1', 'member-1', 'Vouch edge confirmed.'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('writes a report-less, target-scoped audit row and returns the citation', async () => {
      const { service, profiles, auditLogs } = build();
      profiles.findOne.mockResolvedValue(
        profileRow({ firstName: 'Jamie', lastName: 'Silva' }),
      );

      const result = await service.citeMember(
        'admin-1',
        'member-1',
        'Vouch edge confirmed.',
      );

      expect(auditLogs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: null,
          actorId: 'admin-1',
          targetUserId: 'member-1',
          targetName: 'Jamie Silva',
          action: 'evidence_cited',
          note: 'Vouch edge confirmed.',
        }),
      );
      expect(result).toEqual({
        id: 'member-1',
        slug: 'jamie',
        note: 'Vouch edge confirmed.',
        citedAt: now.toISOString(),
      });
    });
  });

  describe('restrictMember', () => {
    it('suspends (duration present), kills sessions and notifies the outcome', async () => {
      const { service, enforcement, auth, notifications } = build();
      const suspendedUntil = new Date('2026-08-12T10:00:00.000Z');
      enforcement.restrictMember.mockResolvedValue({
        userId: 'member-1',
        suspendedUntil,
        status: UserStatus.Suspended,
      });

      const result = await service.restrictMember('admin-1', 'member-1', {
        duration: '7d',
        reasonCode: 'harassment',
        note: 'repeat offender',
      } as never);

      expect(enforcement.restrictMember).toHaveBeenCalledWith(
        'member-1',
        'admin-1',
        expect.objectContaining({ action: 'suspend', duration: '7d' }),
      );
      expect(auth.revokeAllForUser).toHaveBeenCalledWith('member-1');
      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        NotificationType.ModerationOutcome,
        expect.objectContaining({
          action: 'suspend',
          expiresAt: suspendedUntil.toISOString(),
        }),
      );
      expect(result).toEqual({
        id: 'member-1',
        status: UserStatus.Suspended,
        suspendedUntil: suspendedUntil.toISOString(),
      });
    });

    it('bans (no duration) permanently, reporting a null suspendedUntil', async () => {
      const { service, enforcement } = build();
      enforcement.restrictMember.mockResolvedValue({
        userId: 'member-1',
        suspendedUntil: null,
        status: UserStatus.Suspended,
      });

      const result = await service.restrictMember('admin-1', 'member-1', {
        reasonCode: 'spam',
        note: 'bot',
      } as never);

      expect(enforcement.restrictMember).toHaveBeenCalledWith(
        'member-1',
        'admin-1',
        expect.objectContaining({ action: 'ban', duration: undefined }),
      );
      expect(result.suspendedUntil).toBeNull();
    });

    it('reports the ACTUAL persisted status — a deactivated member stays Deactivated', async () => {
      const { service, enforcement } = build();
      enforcement.restrictMember.mockResolvedValue({
        userId: 'member-1',
        suspendedUntil: new Date('2026-08-12T10:00:00.000Z'),
        status: UserStatus.Deactivated, // enforcement preserved the self-deactivation
      });

      const result = await service.restrictMember('admin-1', 'member-1', {
        duration: '7d',
        reasonCode: 'harassment',
        note: 'x',
      } as never);

      expect(result.status).toBe(UserStatus.Deactivated);
    });

    it('propagates a guardrail Forbidden (self/house/staff) and never revokes or notifies', async () => {
      const { service, enforcement, auth, notifications } = build();
      enforcement.restrictMember.mockRejectedValue(
        new ForbiddenException(
          'Moderation actions cannot target staff accounts.',
        ),
      );

      await expect(
        service.restrictMember('admin-1', 'member-1', {
          reasonCode: 'x',
          note: 'y',
        } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(auth.revokeAllForUser).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('swallows a best-effort notification failure — the restriction still commits', async () => {
      const { service, enforcement, notifications } = build();
      enforcement.restrictMember.mockResolvedValue({
        userId: 'member-1',
        suspendedUntil: null,
        status: UserStatus.Suspended,
      });
      notifications.create.mockRejectedValue(new Error('notif down'));

      await expect(
        service.restrictMember('admin-1', 'member-1', {
          reasonCode: 'x',
          note: 'y',
        } as never),
      ).resolves.toMatchObject({
        id: 'member-1',
        status: UserStatus.Suspended,
      });
    });

    it('does not self-notify when the actor is the restricted user', async () => {
      const { service, enforcement, notifications } = build();
      enforcement.restrictMember.mockResolvedValue({
        userId: 'admin-1',
        suspendedUntil: null,
        status: UserStatus.Suspended,
      });

      await service.restrictMember('admin-1', 'admin-1', {
        reasonCode: 'x',
        note: 'y',
      } as never);

      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});

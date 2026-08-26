import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { ACCOUNT_REMOVED } from '../ban-evasion/ban-evasion.events';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { BanRatificationService } from './ban-ratification.service';
import {
  BanRatification,
  BanRatificationStatus,
} from './entities/ban-ratification.entity';
import { ModAuditService } from './mod-audit.service';

/**
 * TS-12. The three guarantees this service exists to make:
 *
 *  1. the moderator who ASKED for a ban can never be the one who confirms it,
 *     admin or not;
 *  2. `ACCOUNT_REMOVED` fires when the ban TAKES EFFECT, never on the hold;
 *  3. a hold nobody confirms lapses, and lapsing does not remove anybody.
 */
describe('BanRatificationService', () => {
  let service: BanRatificationService;
  let ratifications: {
    find: jest.Mock;
    findOne: jest.Mock;
    update: jest.Mock;
  };
  let managerUpdate: jest.Mock;
  let applyRatifiedBan: jest.Mock;
  let restoreUser: jest.Mock;
  let writeAuditLog: jest.Mock;
  let revokeAllForUser: jest.Mock;
  let emit: jest.Mock;

  const pendingHold = (
    overrides: Partial<BanRatification> = {},
  ): BanRatification => ({
    id: 'hold-1',
    reportId: 'report-1',
    targetUserId: 'member-1',
    targetName: 'Rui Andrade',
    requestedBy: 'mod-1',
    note: 'Third account traced to the same person.',
    reasonCode: 'harassment',
    interimAction: 'suspended_pending_ratification',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status: BanRatificationStatus.Pending,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    ratifications = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    applyRatifiedBan = jest.fn().mockResolvedValue(undefined);
    restoreUser = jest.fn().mockResolvedValue(undefined);
    writeAuditLog = jest.fn().mockResolvedValue(undefined);
    revokeAllForUser = jest.fn().mockResolvedValue(undefined);
    emit = jest.fn();

    const module = await Test.createTestingModule({
      providers: [
        BanRatificationService,
        {
          provide: getRepositoryToken(BanRatification),
          useValue: ratifications,
        },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (
              run: (manager: { update: jest.Mock }) => Promise<unknown>,
            ) => run({ update: managerUpdate }),
          },
        },
        {
          provide: ModAuditService,
          useValue: {
            writeAuditLog,
            namesForUserIds: jest.fn().mockResolvedValue(new Map()),
          },
        },
        {
          provide: AccountEnforcementService,
          useValue: { applyRatifiedBan, restoreUser },
        },
        { provide: AuthService, useValue: { revokeAllForUser } },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(null) },
        },
        { provide: EventEmitter2, useValue: { emit } },
      ],
    }).compile();

    service = module.get(BanRatificationService);
  });

  it('refuses the moderator who asked for the ban', async () => {
    ratifications.findOne.mockResolvedValue(pendingHold());
    await expect(
      service.decide('hold-1', 'mod-1', UserRole.Moderator, {
        decision: 'ratify',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(applyRatifiedBan).not.toHaveBeenCalled();
  });

  // Deliberate, not an oversight: "one additional independent moderator" counts
  // people, and the scenario this control is for is a compromised staff
  // account, which is likeliest to hold the highest role.
  it('refuses an admin confirming their own ban', async () => {
    ratifications.findOne.mockResolvedValue(
      pendingHold({ requestedBy: 'a-1' }),
    );
    await expect(
      service.decide('hold-1', 'a-1', UserRole.Admin, { decision: 'ratify' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applies the ban and emits ACCOUNT_REMOVED when a second moderator confirms', async () => {
    ratifications.findOne.mockResolvedValue(pendingHold());
    await service.decide('hold-1', 'mod-2', UserRole.Moderator, {
      decision: 'ratify',
    });
    expect(applyRatifiedBan).toHaveBeenCalledWith(
      expect.anything(),
      'member-1',
    );
    // Written in the RATIFIER's name, under the canonical `ban` code, so the
    // member's appeal against "the ban" resolves to a real row.
    expect(writeAuditLog).toHaveBeenCalledWith(
      'report-1',
      'mod-2',
      'ban',
      'harassment',
      'Third account traced to the same person.',
      undefined,
      expect.anything(),
    );
    expect(revokeAllForUser).toHaveBeenCalledWith('member-1');
    expect(emit).toHaveBeenCalledWith(
      ACCOUNT_REMOVED,
      expect.objectContaining({ userId: 'member-1' }),
    );
  });

  it('restores the member and removes nobody when a second moderator refuses', async () => {
    ratifications.findOne.mockResolvedValue(pendingHold());
    await service.decide('hold-1', 'mod-2', UserRole.Moderator, {
      decision: 'decline',
      note: 'Not enough to end an account over.',
    });
    expect(restoreUser).toHaveBeenCalledWith(expect.anything(), 'member-1');
    expect(applyRatifiedBan).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('refuses a hold that is no longer pending', async () => {
    ratifications.findOne.mockResolvedValue(
      pendingHold({ status: BanRatificationStatus.Ratified }),
    );
    await expect(
      service.decide('hold-1', 'mod-2', UserRole.Moderator, {
        decision: 'ratify',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Lapsing is the fail-safe outcome: the ban does not happen, and the interim
  // suspension expires on its own timer, so nothing here touches the account.
  it('expires a lapsed hold without removing anybody', async () => {
    const lapsed = pendingHold({
      id: 'hold-old',
      expiresAt: new Date(Date.now() - 1000),
    });
    ratifications.find.mockResolvedValue([lapsed]);
    const expired = await service.expireDueHolds();
    expect(expired).toHaveLength(1);
    expect(ratifications.update).toHaveBeenCalledWith(
      { id: 'hold-old', status: BanRatificationStatus.Pending },
      expect.objectContaining({ status: BanRatificationStatus.Expired }),
    );
    expect(applyRatifiedBan).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(
      'report-1',
      'mod-1',
      'ban_hold_expired',
      'harassment',
      'Third account traced to the same person.',
      lapsed.expiresAt.toISOString(),
    );
  });

  it('withdraws a pending hold when its basis is undone', async () => {
    await service.withdrawPendingHold(
      { update: managerUpdate } as never,
      'member-1',
    );
    expect(managerUpdate).toHaveBeenCalledWith(
      BanRatification,
      { targetUserId: 'member-1', status: BanRatificationStatus.Pending },
      expect.objectContaining({ status: BanRatificationStatus.Withdrawn }),
    );
  });
});

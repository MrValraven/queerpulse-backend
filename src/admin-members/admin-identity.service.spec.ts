import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { DeletionRequest } from '../account/entities/deletion-request.entity';
import { EmailSuppression } from '../account/entities/email-suppression.entity';
import { AuthService } from '../auth/auth.service';
import { IdentityRelinkCandidate } from '../auth/entities/identity-relink-candidate.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminIdentityService } from './admin-identity.service';

const ACTOR_ID = 'user-admin';
const MEMBER_ID = 'user-ines';

function makeProfile(): Profile {
  return {
    userId: MEMBER_ID,
    slug: 'ines-martins',
    firstName: 'Inês',
    lastName: 'Martins',
  } as unknown as Profile;
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: MEMBER_ID,
    role: UserRole.Member,
    isSystem: false,
    status: UserStatus.Active,
    suspendedUntil: null,
    googleId: 'google-old-111111',
    ...overrides,
  } as unknown as User;
}

/**
 * The guardrails are the feature. These cover the refusals rather than the
 * happy path, because every one of them is the reason a lever that can hand
 * over an account is safe to expose at all.
 */
function buildMocks() {
  const profiles = { findOne: jest.fn().mockResolvedValue(makeProfile()) };
  const users = { findOne: jest.fn().mockResolvedValue(makeUser()) };
  const relinkCandidates = {
    createQueryBuilder: jest.fn(() => ({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })),
  };
  const staffRoles = { exists: jest.fn().mockResolvedValue(false) };
  const emailSuppressions = { findOne: jest.fn().mockResolvedValue(null) };
  const deactivations = { exists: jest.fn().mockResolvedValue(false) };
  const deletionRequests = { exists: jest.fn().mockResolvedValue(false) };
  const managerFindOne = jest.fn().mockResolvedValue(makeUser());
  const managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
  const auditRepo = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest.fn().mockResolvedValue({}),
  };
  const manager = {
    findOne: managerFindOne,
    update: managerUpdate,
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    getRepository: jest.fn(() => auditRepo),
    createQueryBuilder: jest.fn(() => ({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(makeUser()),
    })),
  };
  const dataSource = {
    transaction: jest.fn((callback: (m: unknown) => unknown) =>
      callback(manager),
    ),
  };
  const auth = {
    applyGoogleIdRelink: jest.fn().mockResolvedValue(true),
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
  };
  return {
    profiles,
    users,
    relinkCandidates,
    staffRoles,
    emailSuppressions,
    deactivations,
    deletionRequests,
    dataSource,
    auth,
    manager,
    managerUpdate,
    auditRepo,
  };
}

async function buildService(
  mocks: ReturnType<typeof buildMocks>,
): Promise<AdminIdentityService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AdminIdentityService,
      { provide: DataSource, useValue: mocks.dataSource },
      { provide: getRepositoryToken(Profile), useValue: mocks.profiles },
      { provide: getRepositoryToken(User), useValue: mocks.users },
      {
        provide: getRepositoryToken(IdentityRelinkCandidate),
        useValue: mocks.relinkCandidates,
      },
      {
        provide: getRepositoryToken(UserStaffRole),
        useValue: mocks.staffRoles,
      },
      {
        provide: getRepositoryToken(EmailSuppression),
        useValue: mocks.emailSuppressions,
      },
      {
        provide: getRepositoryToken(AccountDeactivation),
        useValue: mocks.deactivations,
      },
      {
        provide: getRepositoryToken(DeletionRequest),
        useValue: mocks.deletionRequests,
      },
      { provide: AuthService, useValue: mocks.auth },
    ],
  }).compile();
  return module.get(AdminIdentityService);
}

describe('AdminIdentityService re-link guardrails (PRD-06)', () => {
  let service: AdminIdentityService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('closes the lever on a moderator account and names the demote-first path', async () => {
    mocks.users.findOne.mockResolvedValue(
      makeUser({ role: UserRole.Moderator }),
    );

    const panel = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);

    expect(panel.relink.isAvailable).toBe(false);
    expect(panel.relink.blockedReason).toContain('staff accounts');
    expect(panel.relink.blockedReason).toContain('Remove their role first');
  });

  it('closes the lever on a member holding an additive staff role', async () => {
    mocks.staffRoles.exists.mockResolvedValue(true);

    const panel = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);

    expect(panel.relink.isAvailable).toBe(false);
    expect(panel.relink.blockedReason).toContain('staff role');
  });

  it('closes the lever on the house account and on the operator themselves', async () => {
    mocks.users.findOne.mockResolvedValue(makeUser({ isSystem: true }));
    const houseAccount = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);
    expect(houseAccount.relink.isAvailable).toBe(false);

    mocks.users.findOne.mockResolvedValue(makeUser({ id: ACTOR_ID }));
    const self = await service.getAccountRecovery(ACTOR_ID, ACTOR_ID);
    expect(self.relink.isAvailable).toBe(false);
    expect(self.relink.blockedReason).toContain('your own');
  });

  it('refuses to apply a re-link to a staff account even if the panel said otherwise', async () => {
    // The panel read can be minutes old, so the write re-checks. A member
    // promoted to admin in between must not slip through.
    mocks.manager.createQueryBuilder.mockReturnValue({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(makeUser({ role: UserRole.Admin })),
    });

    await expect(
      service.applyRelink(ACTOR_ID, MEMBER_ID, 'candidate-1', 'a good reason'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(mocks.auth.applyGoogleIdRelink).not.toHaveBeenCalled();
  });
});

describe('AdminIdentityService reactivation guardrails (PRD-11)', () => {
  let service: AdminIdentityService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('refuses a member who paused their own account, pointing at signing in', async () => {
    mocks.users.findOne.mockResolvedValue(
      makeUser({ status: UserStatus.Deactivated }),
    );
    mocks.deactivations.exists.mockResolvedValue(true);

    const panel = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);

    expect(panel.reactivation.isApplicable).toBe(true);
    expect(panel.reactivation.isAvailable).toBe(false);
    expect(panel.reactivation.blockedReason).toContain('signing in');
  });

  it('refuses a member in the erasure grace period', async () => {
    mocks.users.findOne.mockResolvedValue(
      makeUser({ status: UserStatus.Deactivated }),
    );
    mocks.deletionRequests.exists.mockResolvedValue(true);

    const panel = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);

    expect(panel.reactivation.isAvailable).toBe(false);
    expect(panel.reactivation.blockedReason).toContain('erased');
  });

  it('refuses a member under a live suspension rather than laundering it', async () => {
    mocks.users.findOne.mockResolvedValue(
      makeUser({
        status: UserStatus.Deactivated,
        suspendedUntil: new Date(Date.now() + 60_000),
      }),
    );

    const panel = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);

    expect(panel.reactivation.isAvailable).toBe(false);
    expect(panel.reactivation.blockedReason).toContain('suspension');
  });

  it('opens only for the stranded case, and refuses an active member', async () => {
    mocks.users.findOne.mockResolvedValue(
      makeUser({ status: UserStatus.Deactivated }),
    );
    const stranded = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);
    expect(stranded.reactivation.isAvailable).toBe(true);

    mocks.users.findOne.mockResolvedValue(makeUser());
    const active = await service.getAccountRecovery(ACTOR_ID, MEMBER_ID);
    expect(active.reactivation.isApplicable).toBe(false);
    expect(active.reactivation.isAvailable).toBe(false);
  });

  it('throws a conflict rather than writing when the write-time re-check refuses', async () => {
    mocks.manager.findOne.mockResolvedValue(makeUser());

    await expect(
      service.reactivateMember(ACTOR_ID, MEMBER_ID, 'a good reason'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.managerUpdate).not.toHaveBeenCalled();
  });
});

describe('AdminIdentityService suppression lift (PRD-13)', () => {
  let service: AdminIdentityService;
  let mocks: ReturnType<typeof buildMocks>;

  beforeEach(async () => {
    mocks = buildMocks();
    service = await buildService(mocks);
  });

  it('reports an address that is not on the list without touching anything', async () => {
    const result = await service.lookupSuppression('someone@example.com');

    expect(result.isSuppressed).toBe(false);
    expect(result.suppressedAt).toBeNull();
    // The hash prefix is published; the address never becomes a stored key.
    expect(result.emailHashPrefix).toHaveLength(12);
  });

  it('keeps the plaintext address out of the audit note', async () => {
    mocks.manager.findOne.mockResolvedValue({
      id: 'suppression-1',
      emailHash: 'a'.repeat(64),
      reason: 'account_deleted',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.liftSuppression(
      ACTOR_ID,
      'someone@example.com',
      'ticket 233, asked to come back',
    );

    const auditRow = mocks.auditRepo.create.mock.calls[0]?.[0] as {
      note: string;
      targetUserId: string | null;
    };
    expect(auditRow.note).not.toContain('someone@example.com');
    expect(auditRow.note).toContain('ticket 233');
    // The account this row protected was erased, so there is nobody to name.
    expect(auditRow.targetUserId).toBeNull();
  });
});

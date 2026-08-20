import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import {
  Subprofile,
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileMember } from './entities/subprofile-member.entity';
import {
  SubprofileInvite,
  SubprofileInviteStatus,
} from './entities/subprofile-invite.entity';
import { SubprofileInvitesService } from './subprofile-invites.service';
import { SubprofilesService } from './subprofiles.service';
import { MAX_SUBPROFILE_CO_OWNERS } from './subprofile-validation';

// --- fixtures ---------------------------------------------------------------

function makeInvite(
  overrides: Partial<SubprofileInvite> = {},
): SubprofileInvite {
  return {
    id: 'inv-1',
    subprofileId: 'sp-1',
    invitedUserId: 'bob',
    invitedByUserId: 'creator',
    status: SubprofileInviteStatus.Pending,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    respondedAt: null,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'bob',
    user: undefined as never,
    slug: 'bob',
    firstName: 'Bob',
    lastName: 'Diaz',
    pronouns: null,
    pronunciation: null,
    tagline: null,
    bio: null,
    bioPt: null,
    location: null,
    avatarUrl: null,
    visibility: ProfileVisibility.Open,
    openTo: [],
    notHereFor: null,
    identities: [],
    discoverableIdentities: [],
    lookingFor: [],
    lookingForPublic: false,
    tags: [],
    discipline: [],
    profession: [],
    languages: [],
    vouchCount: 0,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    privateNetwork: false,
    featuredConsent: false,
    photoVisible: true,
    hoodVisible: true,
    vouchersVisible: true,
    now: null,
    hiddenUntil: null,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSubprofile(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: 'sp-1',
    userId: 'creator',
    user: undefined as never,
    kind: SubprofileKind.Developer,
    slug: 'nightform',
    handle: null,
    displayName: 'Nightform',
    avatarUrl: null,
    tagline: null,
    bio: null,
    coverUrl: null,
    accent: null,
    availability: null,
    ctaLabel: null,
    ctaUrl: null,
    linkVisibility: SubprofileLinkVisibility.Unlinked,
    visibility: SubprofileVisibility.Open,
    status: SubprofileStatus.Draft,
    position: 0,
    skinData: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// A duplicate-key error shaped like the one TypeORM/pg raise on a unique
// violation — matches `isUniqueViolation`'s `error.code` shape.
function makeUniqueViolation(): Error & { code: string } {
  return Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code: '23505' },
  );
}

describe('SubprofileInvitesService', () => {
  let service: SubprofileInvitesService;
  let invitesRepo: jest.Mocked<
    Pick<
      Repository<SubprofileInvite>,
      'findOne' | 'find' | 'create' | 'save' | 'count'
    >
  >;
  let membersRepo: jest.Mocked<
    Pick<Repository<SubprofileMember>, 'findOne' | 'count' | 'create' | 'save'>
  >;
  let subprofilesRepo: jest.Mocked<Pick<Repository<Subprofile>, 'find'>>;
  let profilesRepo: jest.Mocked<Pick<Repository<Profile>, 'findOne' | 'find'>>;
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let subprofilesService: { assertMember: jest.Mock };
  let events: { emit: jest.Mock };
  // The transactional manager `dataSource.transaction(cb)` hands to `cb` in
  // `invite()`/`accept()`. Dispatches on the entity CLASS passed as the first
  // arg (mirrors how `manager.findOne(Entity, ...)`/`manager.count(Entity, ...)`
  // are actually called), so one shared mock can stand in for lookups against
  // three different entities within the same transaction.
  let manager: {
    findOne: jest.Mock;
    count: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
  };
  let dataSource: { transaction: jest.Mock };

  beforeEach(async () => {
    invitesRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((value: Partial<SubprofileInvite>) => ({
          ...makeInvite(),
          ...value,
        })),
      save: jest
        .fn()
        .mockImplementation((value: SubprofileInvite) =>
          Promise.resolve(value),
        ),
      count: jest.fn().mockResolvedValue(0),
    };
    membersRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(1),
      create: jest
        .fn()
        .mockImplementation((value: Partial<SubprofileMember>) => ({
          ...value,
        })),
      save: jest
        .fn()
        .mockImplementation((value: SubprofileMember) =>
          Promise.resolve(value),
        ),
    };
    subprofilesRepo = { find: jest.fn().mockResolvedValue([]) };
    profilesRepo = {
      findOne: jest.fn().mockResolvedValue(makeProfile()),
      find: jest.fn().mockResolvedValue([]),
    };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    subprofilesService = {
      assertMember: jest.fn().mockResolvedValue(makeSubprofile()),
    };
    events = { emit: jest.fn() };

    // Sane defaults for the locked-transaction path: the persona-row lock
    // resolves to something truthy, no pre-existing member/pending-invite row,
    // member count under the cap. Individual tests override via
    // `manager.findOne.mockImplementation(...)` / `manager.count...` to
    // exercise the cap/conflict/race branches.
    manager = {
      findOne: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === Subprofile) return Promise.resolve(makeSubprofile());
        return Promise.resolve(null); // no existing member row / pending invite
      }),
      count: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === SubprofileMember) return Promise.resolve(1);
        if (entity === SubprofileInvite) return Promise.resolve(0);
        return Promise.resolve(0);
      }),
      save: jest
        .fn()
        .mockImplementation((value: unknown) => Promise.resolve(value)),
      create: jest.fn().mockImplementation((entity: unknown, value: object) =>
        // A real `manager.save(create(SubprofileInvite, …))` returns the
        // persisted row with its DB-generated `createdAt`/`id` populated —
        // `toInviteView` reads `createdAt`. Model that here so the invite
        // path gets a fully-shaped row, not just the columns it set.
        entity === SubprofileInvite ? makeInvite(value) : { ...value },
      ),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (runInTransaction: (m: typeof manager) => Promise<unknown>) =>
            runInTransaction(manager),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubprofileInvitesService,
        {
          provide: getRepositoryToken(SubprofileInvite),
          useValue: invitesRepo,
        },
        {
          provide: getRepositoryToken(SubprofileMember),
          useValue: membersRepo,
        },
        { provide: getRepositoryToken(Subprofile), useValue: subprofilesRepo },
        { provide: getRepositoryToken(Profile), useValue: profilesRepo },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: SubprofilesService, useValue: subprofilesService },
        { provide: EventEmitter2, useValue: events },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(SubprofileInvitesService);
  });

  // --- invite ----------------------------------------------------------------

  describe('invite', () => {
    it('creates a pending invite (inside the locked transaction) and emits subprofile.invited', async () => {
      const invitedProfile = makeProfile({ userId: 'bob', slug: 'bob-slug' });
      profilesRepo.findOne.mockResolvedValue(invitedProfile);
      membersRepo.findOne.mockResolvedValue(null); // not already a member

      const result = await service.invite('creator', 'sp1', 'bob-slug');

      // Resolves the invitee's SLUG to their profile first — the id fed to
      // every downstream check/write is the resolved `userId`, never the slug.
      expect(profilesRepo.findOne).toHaveBeenCalledWith({
        where: { slug: 'bob-slug' },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(
        Subprofile,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subprofileId: 'sp1',
          invitedUserId: 'bob',
          status: SubprofileInviteStatus.Pending,
        }),
      );
      expect(result.invitedUserId).toBe('bob');
      expect(events.emit).toHaveBeenCalledWith(
        'subprofile.invited',
        expect.objectContaining({
          subprofileId: 'sp1',
          invitedUserId: 'bob',
          invitedByUserId: 'creator',
        }),
      );
    });

    it('rejects inviting an existing co-owner with ConflictException (pre-transaction check)', async () => {
      subprofilesService.assertMember.mockResolvedValue(
        makeSubprofile({ id: 'sp1', userId: 'creator' }),
      );
      profilesRepo.findOne.mockResolvedValue(
        makeProfile({ userId: 'bob', slug: 'bob-slug' }),
      );
      membersRepo.findOne.mockResolvedValue({
        id: 'member-1',
        subprofileId: 'sp1',
        userId: 'bob',
      } as SubprofileMember); // already a member

      await expect(
        service.invite('creator', 'sp1', 'bob-slug'),
      ).rejects.toThrow(ConflictException);
      // Never even opens the transaction — this check runs before it.
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects inviting past the co-owner cap with BadRequestException', async () => {
      profilesRepo.findOne.mockResolvedValue(
        makeProfile({ userId: 'bob', slug: 'bob-slug' }),
      );
      membersRepo.findOne.mockResolvedValue(null);
      // member + pending counts (read inside the transaction) sum to the cap.
      manager.count.mockImplementation((entity: unknown) => {
        if (entity === SubprofileMember) {
          return Promise.resolve(MAX_SUBPROFILE_CO_OWNERS - 1);
        }
        if (entity === SubprofileInvite) return Promise.resolve(1);
        return Promise.resolve(0);
      });

      await expect(
        service.invite('creator', 'sp1', 'bob-slug'),
      ).rejects.toThrow(BadRequestException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('rejects inviting yourself with BadRequestException', async () => {
      // The invitee's slug resolves to the SAME userId as the inviter (e.g.
      // inviting your own persona-linked handle) — the self-check compares
      // resolved userIds, not the slug against the raw inviterUserId.
      profilesRepo.findOne.mockResolvedValue(
        makeProfile({ userId: 'creator', slug: 'my-own-slug' }),
      );
      await expect(
        service.invite('creator', 'sp1', 'my-own-slug'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects inviting a blocked-either-way member with BadRequestException', async () => {
      profilesRepo.findOne.mockResolvedValue(
        makeProfile({ userId: 'bob', slug: 'bob-slug' }),
      );
      blockFilter.isBlockedEitherWay.mockResolvedValue(true);
      await expect(
        service.invite('creator', 'sp1', 'bob-slug'),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s when no profile matches the given slug', async () => {
      profilesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.invite('creator', 'sp1', 'ghost-slug'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a second invite while one is already pending (checked inside the transaction)', async () => {
      profilesRepo.findOne.mockResolvedValue(
        makeProfile({ userId: 'bob', slug: 'bob-slug' }),
      );
      membersRepo.findOne.mockResolvedValue(null);
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Subprofile) return Promise.resolve(makeSubprofile());
        if (entity === SubprofileInvite) return Promise.resolve(makeInvite());
        return Promise.resolve(null);
      });

      await expect(
        service.invite('creator', 'sp1', 'bob-slug'),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  // --- accept ------------------------------------------------------------------

  describe('accept', () => {
    it('adds a member row and marks the invite accepted (inside the locked transaction)', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      );

      await service.accept('bob', 'inv1');

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(
        Subprofile,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ subprofileId: 'sp1', userId: 'bob' }),
      );
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubprofileInviteStatus.Accepted }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'subprofile.invite.accepted',
        expect.objectContaining({
          subprofileId: 'sp1',
          joinedUserId: 'bob',
          invitedByUserId: 'creator',
        }),
      );
    });

    it('does not create a duplicate member row when already a member', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      );
      manager.findOne.mockImplementation((entity: unknown) => {
        if (entity === Subprofile) return Promise.resolve(makeSubprofile());
        if (entity === SubprofileMember) {
          return Promise.resolve({
            id: 'member-1',
            subprofileId: 'sp1',
            userId: 'bob',
          });
        }
        return Promise.resolve(null);
      });

      await service.accept('bob', 'inv1');

      // Only the invite is saved — no member-row save was attempted.
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubprofileInviteStatus.Accepted }),
      );
    });

    it('is idempotent when a concurrent accept wins the insert race first (unique violation)', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      );
      // Pre-check says "not a member yet" (raced), but the insert itself
      // hits the unique constraint because a concurrent accept won first.
      let saveCallCount = 0;
      manager.save.mockImplementation((value: unknown) => {
        saveCallCount += 1;
        if (saveCallCount === 1) {
          return Promise.reject(makeUniqueViolation());
        }
        return Promise.resolve(value);
      });

      await expect(service.accept('bob', 'inv1')).resolves.toBeUndefined();

      // The member-insert attempt (1) + the invite-status save (2) both ran;
      // the duplicate-key error on (1) was swallowed rather than propagated.
      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: SubprofileInviteStatus.Accepted }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'subprofile.invite.accepted',
        expect.anything(),
      );
    });

    it('re-throws a non-unique-violation error from the member insert', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      );
      manager.save.mockImplementation(() => Promise.reject(new Error('boom')));

      await expect(service.accept('bob', 'inv1')).rejects.toThrow('boom');
    });

    it('404s when no invite is addressed to this user', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ invitedUserId: 'someone-else' }),
      );
      await expect(service.accept('bob', 'inv1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('409s when the invite is no longer pending', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ status: SubprofileInviteStatus.Declined }),
      );
      await expect(service.accept('bob', 'inv1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('400s when the persona is already at the co-owner cap', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      );
      manager.count.mockImplementation((entity: unknown) => {
        if (entity === SubprofileMember) {
          return Promise.resolve(MAX_SUBPROFILE_CO_OWNERS);
        }
        return Promise.resolve(0);
      });
      await expect(service.accept('bob', 'inv1')).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  // --- decline -----------------------------------------------------------------

  describe('decline', () => {
    it('sets the invite to declined', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ invitedUserId: 'bob' }),
      );
      await service.decline('bob', 'inv1');
      expect(invitesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubprofileInviteStatus.Declined }),
      );
    });

    it('404s when no invite is addressed to this user', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ invitedUserId: 'someone-else' }),
      );
      await expect(service.decline('bob', 'inv1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('409s when the invite is no longer pending', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ status: SubprofileInviteStatus.Revoked }),
      );
      await expect(service.decline('bob', 'inv1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // --- revoke ------------------------------------------------------------------

  describe('revoke', () => {
    it('sets the invite to revoked', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'sp1' }),
      );
      await service.revoke('creator', 'sp1', 'inv1');
      expect(invitesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SubprofileInviteStatus.Revoked }),
      );
    });

    it('404s when the invite does not belong to the given subprofile', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({ id: 'inv1', subprofileId: 'other-sp' }),
      );
      await expect(service.revoke('creator', 'sp1', 'inv1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('409s when the invite is no longer pending', async () => {
      invitesRepo.findOne.mockResolvedValue(
        makeInvite({
          id: 'inv1',
          subprofileId: 'sp1',
          status: SubprofileInviteStatus.Accepted,
        }),
      );
      await expect(service.revoke('creator', 'sp1', 'inv1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  // --- listMine (dedicated MyInviteView, batched) -------------------------------

  describe('listMine', () => {
    it('returns [] with no repo calls to subprofiles/profiles when there are no pending invites', async () => {
      invitesRepo.find.mockResolvedValue([]);
      const result = await service.listMine('bob');
      expect(result).toEqual([]);
      expect(subprofilesRepo.find).not.toHaveBeenCalled();
      expect(profilesRepo.find).not.toHaveBeenCalled();
    });

    it('maps to MyInviteView with the PERSONA identity + inviter name, batched in one subprofiles + one profiles query', async () => {
      invitesRepo.find.mockResolvedValue([
        makeInvite({
          id: 'inv1',
          subprofileId: 'sp1',
          invitedUserId: 'bob',
          invitedByUserId: 'creator',
        }),
      ]);
      subprofilesRepo.find.mockResolvedValue([
        makeSubprofile({ id: 'sp1', displayName: 'Nightform' }),
      ]);
      profilesRepo.find.mockResolvedValue([
        makeProfile({ userId: 'creator', firstName: 'Ada', lastName: 'Lo' }),
      ]);

      const result = await service.listMine('bob');

      expect(subprofilesRepo.find).toHaveBeenCalledTimes(1);
      expect(profilesRepo.find).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        expect.objectContaining({
          id: 'inv1',
          subprofileId: 'sp1',
          personaName: 'Nightform',
          invitedByName: 'Ada Lo',
        }),
      ]);
    });

    it('drops a row whose persona cannot be resolved', async () => {
      invitesRepo.find.mockResolvedValue([
        makeInvite({
          id: 'inv1',
          subprofileId: 'sp1',
          invitedByUserId: 'creator',
        }),
      ]);
      subprofilesRepo.find.mockResolvedValue([]); // persona missing
      profilesRepo.find.mockResolvedValue([makeProfile({ userId: 'creator' })]);

      const result = await service.listMine('bob');
      expect(result).toEqual([]);
    });

    it('drops a row whose inviter profile cannot be resolved', async () => {
      invitesRepo.find.mockResolvedValue([
        makeInvite({
          id: 'inv1',
          subprofileId: 'sp1',
          invitedByUserId: 'creator',
        }),
      ]);
      subprofilesRepo.find.mockResolvedValue([makeSubprofile({ id: 'sp1' })]);
      profilesRepo.find.mockResolvedValue([]); // inviter profile missing

      const result = await service.listMine('bob');
      expect(result).toEqual([]);
    });
  });

  // --- listInvites (persona-scoped) ---------------------------------------------

  describe('listInvites', () => {
    it('returns invites for the persona, resolved against a batched profile lookup', async () => {
      invitesRepo.find.mockResolvedValue([
        makeInvite({ id: 'inv1', subprofileId: 'sp1', invitedUserId: 'bob' }),
      ]);
      profilesRepo.find.mockResolvedValue([makeProfile({ userId: 'bob' })]);

      const result = await service.listInvites('creator', 'sp1');

      expect(subprofilesService.assertMember).toHaveBeenCalledWith(
        'creator',
        'sp1',
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.invitedUserId).toBe('bob');
    });
  });
});

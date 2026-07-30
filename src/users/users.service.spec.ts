import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';

// The slug picker (`nextAvailableSlug`) resolves the next free slug by querying
// the global `handles` registry through a fluent query builder. This stubs that
// repo so nothing is ever "taken" — the base slug stays free on the first try.
function handleRegistryRepoStub() {
  return {
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    })),
  };
}

describe('UsersService', () => {
  let service: UsersService;
  let usersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // `findByGoogleId` re-includes the `select: false` email column, so it goes
  // through the query builder rather than `findOne`. This stub captures that
  // fluent chain and lets each test drive its `getOne` terminal.
  let usersQueryBuilder: {
    addSelect: jest.Mock;
    where: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(async () => {
    usersQueryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => usersQueryBuilder),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: getRepositoryToken(Profile), useValue: {} },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  it('findByGoogleId delegates to the repository', async () => {
    const user = { id: 'u1', status: UserStatus.Active } as User;
    usersQueryBuilder.getOne.mockResolvedValue(user);
    await expect(service.findByGoogleId('g-123')).resolves.toBe(user);
    expect(usersRepo.createQueryBuilder).toHaveBeenCalledWith('user');
    expect(usersQueryBuilder.where).toHaveBeenCalledWith(
      'user.googleId = :googleId',
      { googleId: 'g-123' },
    );
  });

  it('slugify produces a url-safe base slug', () => {
    // @ts-expect-error exercising the private helper deterministically
    expect(service.slugify('Tomás Mendes!')).toBe('tomas-mendes');
  });

  // `promoteToActive` was removed with `UserStatus.Pending` — there is no
  // pending state to promote out of. Membership is granted at creation time
  // (see the createGoogleUser suite below), never as a later transition.

  describe('createGoogleUser', () => {
    it('creates an Active member with invitedBy + activatedAt on the given manager', async () => {
      const saved: Array<{ id: string }> = [];
      const createMock = jest.fn(
        (_entity: unknown, value: Record<string, unknown>) => value,
      );
      const saveMock = jest.fn((value: Record<string, unknown>) => {
        const row = {
          id: saved.length === 0 ? 'new-user' : 'new-profile',
          ...value,
        };
        saved.push(row);
        return Promise.resolve(row);
      });
      const manager = {
        create: createMock,
        save: saveMock,
        getRepository: jest.fn(() => handleRegistryRepoStub()),
        // The profile row and its global handle are INSERTed inside the nested
        // SAVEPOINT; `save` covers the profile, `insert` covers the handle.
        insert: jest.fn().mockResolvedValue(undefined),
        // The profile insert runs in a nested SAVEPOINT transaction; the mock
        // just re-enters the same manager.
        transaction: jest.fn((cb: (m: unknown) => Promise<void>) =>
          cb(manager),
        ),
      } as unknown as EntityManager;

      const user = await service.createGoogleUser(manager, {
        googleId: 'g-1',
        email: 'a@b.c',
        firstName: 'Ada',
        lastName: 'Lovelace',
        status: UserStatus.Active,
        invitedBy: 'inviter-1',
      });

      expect(user).toEqual(expect.objectContaining({ id: 'new-user' }));
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: UserStatus.Active,
          activatedAt: expect.any(Date) as unknown,
          invitedBy: { id: 'inviter-1' },
        }),
      );
      // a Profile row was also saved
      expect(saved.some((r) => r.id === 'new-profile')).toBe(true);
    });

    it('creates a system account when isSystem is passed', async () => {
      const saved: Array<{ id: string }> = [];
      const createMock = jest.fn(
        (_entity: unknown, value: Record<string, unknown>) => value,
      );
      const saveMock = jest.fn((value: Record<string, unknown>) => {
        const row = {
          id: saved.length === 0 ? 'new-user' : 'new-profile',
          ...value,
        };
        saved.push(row);
        return Promise.resolve(row);
      });
      const manager = {
        create: createMock,
        save: saveMock,
        getRepository: jest.fn(() => handleRegistryRepoStub()),
        // The profile row and its global handle are INSERTed inside the nested
        // SAVEPOINT; `save` covers the profile, `insert` covers the handle.
        insert: jest.fn().mockResolvedValue(undefined),
        transaction: jest.fn((cb: (m: unknown) => Promise<void>) =>
          cb(manager),
        ),
      } as unknown as EntityManager;

      const created = await service.createGoogleUser(manager, {
        googleId: 'system:example',
        email: 'system@example.com',
        firstName: 'Example',
        lastName: '',
        isSystem: true,
      });

      expect(created.isSystem).toBe(true);
      expect(createMock).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ isSystem: true }),
      );
    });

    it('defaults isSystem to false for an ordinary member', async () => {
      const saved: Array<{ id: string }> = [];
      const createMock = jest.fn(
        (_entity: unknown, value: Record<string, unknown>) => value,
      );
      const saveMock = jest.fn((value: Record<string, unknown>) => {
        const row = {
          id: saved.length === 0 ? 'new-user' : 'new-profile',
          ...value,
        };
        saved.push(row);
        return Promise.resolve(row);
      });
      const manager = {
        create: createMock,
        save: saveMock,
        getRepository: jest.fn(() => handleRegistryRepoStub()),
        // The profile row and its global handle are INSERTed inside the nested
        // SAVEPOINT; `save` covers the profile, `insert` covers the handle.
        insert: jest.fn().mockResolvedValue(undefined),
        transaction: jest.fn((cb: (m: unknown) => Promise<void>) =>
          cb(manager),
        ),
      } as unknown as EntityManager;

      const created = await service.createGoogleUser(manager, {
        googleId: 'google-123',
        email: 'member@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      expect(created.isSystem).toBeFalsy();
      expect(createMock).toHaveBeenCalledWith(
        User,
        expect.objectContaining({ isSystem: false }),
      );
    });
  });
});

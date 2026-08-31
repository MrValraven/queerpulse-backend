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

/**
 * A sign-up harness that models the global `handles` registry as a live list
 * rather than a fixed answer, because everything worth asserting about the slug
 * picker is about how it reads that list a SECOND time.
 *
 * `registryNames` starts as whatever the namespace already holds and grows on
 * every simulated collision, so the retry inside `insertProfileWithUniqueSlug`
 * re-queries and sees the name that just lost the race, which is exactly what
 * happens against Postgres. `uniqueViolationsBeforeSuccess` makes the first N
 * handle inserts raise a 23505 the way a concurrent sign-up would.
 */
function signupHarness(options?: {
  registryNames?: string[];
  uniqueViolationsBeforeSuccess?: number;
}) {
  const registryNames = [...(options?.registryNames ?? [])];
  let remainingUniqueViolations = options?.uniqueViolationsBeforeSuccess ?? 0;
  const insertedHandleNames: string[] = [];
  const savedProfileSlugs: string[] = [];

  const handleRegistryRepo = {
    createQueryBuilder: jest.fn(() => {
      // `nextAvailableSlug` asks for `base` plus everything matching `base-%`;
      // the stub captures the base off the parameter and filters the same way.
      let base = '';
      // Annotated because the fluent mocks return `builder` from inside its own
      // initializer, which TypeScript cannot infer a type through.
      const builder: {
        select: jest.Mock;
        where: jest.Mock;
        orWhere: jest.Mock;
        getRawMany: jest.Mock;
      } = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn((_sql: string, params: { base: string }) => {
          base = params.base;
          return builder;
        }),
        orWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn(() =>
          Promise.resolve(
            registryNames
              .filter((name) => name === base || name.startsWith(`${base}-`))
              .map((name) => ({ name })),
          ),
        ),
      };
      return builder;
    }),
  };

  const manager = {
    create: jest.fn(
      (_entity: unknown, value: Record<string, unknown>) => value,
    ),
    save: jest.fn((value: Record<string, unknown>) => {
      if (typeof value.slug === 'string') {
        savedProfileSlugs.push(value.slug);
        return Promise.resolve({ id: 'new-profile', ...value });
      }
      return Promise.resolve({ id: 'new-user', ...value });
    }),
    getRepository: jest.fn(() => handleRegistryRepo),
    insert: jest.fn((_entity: unknown, value: { name: string }) => {
      if (remainingUniqueViolations > 0) {
        remainingUniqueViolations -= 1;
        // The losing insert still leaves the winner's row behind, so the retry
        // has something new to read.
        registryNames.push(value.name);
        return Promise.reject(
          Object.assign(new Error('duplicate key'), {
            code: '23505',
          }),
        );
      }
      insertedHandleNames.push(value.name);
      registryNames.push(value.name);
      return Promise.resolve(undefined);
    }),
    transaction: jest.fn((cb: (m: unknown) => Promise<void>) => cb(manager)),
  } as unknown as EntityManager;

  return {
    manager,
    insertedHandleNames,
    savedProfileSlugs,
    // The handle the sign-up actually came away with.
    claimedHandle: (): string =>
      insertedHandleNames[insertedHandleNames.length - 1] ?? '',
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

  // Sign-up is the one write into the global `handles` namespace that nobody
  // types: the handle is derived from whatever Google reports as the display
  // name. That made it the way around the reserved list: a member calling
  // themselves "Support" on Google was handed `@support`, and a DM from
  // `@support` reads as the platform speaking. These cover that the sign-up
  // path now honours the same rule `HandlesService.claim` enforces, and that it
  // does so by stepping past a withheld name rather than by refusing anyone.
  describe('createGoogleUser handle namespace rules', () => {
    it('gives a member whose name lands on a reserved word a suffixed handle', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-support',
        email: 'support-person@example.com',
        firstName: 'Support',
        lastName: '',
      });

      expect(harness.claimedHandle()).toBe('support-1');
      expect(harness.savedProfileSlugs).toEqual(['support-1']);
    });

    it('keeps bumping the suffix for the next member on the same reserved word', async () => {
      const harness = signupHarness({ registryNames: ['support-1'] });

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-support-2',
        email: 'another@example.com',
        firstName: 'Support',
        lastName: '',
      });

      expect(harness.claimedHandle()).toBe('support-2');
    });

    it('lets a system account keep its reserved handle', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'system:queerpulse',
        email: 'system@queerpulse.com',
        firstName: 'QueerPulse',
        lastName: '',
        isSystem: true,
      });

      expect(harness.claimedHandle()).toBe('queerpulse');
    });

    it('withholds the same name from a member sign-up that is not system-owned', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-impostor',
        email: 'impostor@example.com',
        firstName: 'QueerPulse',
        lastName: '',
      });

      expect(harness.claimedHandle()).toBe('queerpulse-1');
    });

    it('suffixes a display name too short to be a legal handle', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-short',
        email: 'al@example.com',
        firstName: 'Al',
        lastName: '',
      });

      // `al` is two characters, which `HANDLE_RE` rejects. The suffix makes it
      // legal while keeping the person's own name.
      expect(harness.claimedHandle()).toBe('al-1');
    });

    it('falls back to `member` when the display name slugifies to nothing', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-empty',
        email: 'empty@example.com',
        firstName: '???',
        lastName: '!!!',
      });

      expect(harness.claimedHandle()).toBe('member');
    });

    it('truncates a display name too long to be a legal handle', async () => {
      const harness = signupHarness();

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-long',
        email: 'long@example.com',
        firstName: 'Maximiliana Bartholomew',
        lastName: 'Featherstonehaugh',
      });

      const claimed = harness.claimedHandle();
      expect(claimed).toBe('maximiliana-bartholomew');
      expect(claimed.length).toBeLessThanOrEqual(30);
    });

    it('still retries with a bumped suffix when the handle insert collides', async () => {
      // A concurrent sign-up takes `ada-lovelace` between the slug query and
      // the insert: the 23505 has to keep reaching the retry loop rather than
      // being converted into a failed sign-up.
      const harness = signupHarness({ uniqueViolationsBeforeSuccess: 1 });

      await service.createGoogleUser(harness.manager, {
        googleId: 'g-ada',
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      expect(harness.claimedHandle()).toBe('ada-lovelace-1');
      expect(harness.savedProfileSlugs).toEqual([
        'ada-lovelace',
        'ada-lovelace-1',
      ]);
    });
  });
});

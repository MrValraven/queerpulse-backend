import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from './entities/profile.entity';
import { User, UserStatus } from './entities/user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let usersRepo: { findOne: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    usersRepo = { findOne: jest.fn(), save: jest.fn() };
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
    usersRepo.findOne.mockResolvedValue(user);
    await expect(service.findByGoogleId('g-123')).resolves.toBe(user);
    expect(usersRepo.findOne).toHaveBeenCalledWith({
      where: { googleId: 'g-123' },
    });
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
      const saved: any[] = [];
      const profileRepo = { exists: jest.fn().mockResolvedValue(false) };
      const manager = {
        create: jest.fn((_entity, v) => v),
        save: jest.fn(async (v) => {
          const row = {
            id: saved.length === 0 ? 'new-user' : 'new-profile',
            ...v,
          };
          saved.push(row);
          return row;
        }),
        getRepository: jest.fn(() => profileRepo),
        // The profile insert runs in a nested SAVEPOINT transaction; the mock
        // just re-enters the same manager.
        transaction: jest.fn(async (cb: (m: unknown) => Promise<void>) =>
          cb(manager),
        ),
      } as any;

      const user = await service.createGoogleUser(manager, {
        googleId: 'g-1',
        email: 'a@b.c',
        firstName: 'Ada',
        lastName: 'Lovelace',
        status: UserStatus.Active,
        invitedBy: 'inviter-1',
      });

      expect(user).toEqual(expect.objectContaining({ id: 'new-user' }));
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: UserStatus.Active,
          activatedAt: expect.any(Date),
          invitedBy: { id: 'inviter-1' },
        }),
      );
      // a Profile row was also saved
      expect(saved.some((r) => r.id === 'new-profile')).toBe(true);
    });
  });
});

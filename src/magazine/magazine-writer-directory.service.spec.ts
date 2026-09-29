import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { MagazineWriterDirectoryService } from './magazine-writer-directory.service';

type FindRepositoryMock = { find: jest.Mock };

function makeProfile(
  userId: string,
  firstName: string,
  lastName: string,
): Profile {
  return {
    userId,
    firstName,
    lastName,
    avatarUrl: null,
  } as unknown as Profile;
}

describe('MagazineWriterDirectoryService', () => {
  let service: MagazineWriterDirectoryService;
  let staffRoles: FindRepositoryMock;
  let users: FindRepositoryMock;
  let profiles: FindRepositoryMock;

  beforeEach(async () => {
    staffRoles = { find: jest.fn().mockResolvedValue([]) };
    users = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MagazineWriterDirectoryService,
        { provide: getRepositoryToken(UserStaffRole), useValue: staffRoles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();

    service = module.get(MagazineWriterDirectoryService);
  });

  it('returns an empty list without further queries when nobody holds the role', async () => {
    await expect(service.listMagazineWriters()).resolves.toEqual([]);

    expect(staffRoles.find).toHaveBeenCalledWith({
      where: { role: 'magazine_writer' },
    });
    expect(users.find).not.toHaveBeenCalled();
    expect(profiles.find).not.toHaveBeenCalled();
  });

  it('keeps only active grant holders with a profile, sorted by name', async () => {
    staffRoles.find.mockResolvedValue([
      { userId: 'writer-zoe' },
      { userId: 'writer-ana' },
      { userId: 'writer-suspended' },
      { userId: 'writer-no-profile' },
    ]);
    users.find.mockResolvedValue([
      { id: 'writer-zoe' },
      { id: 'writer-ana' },
      { id: 'writer-no-profile' },
    ]);
    profiles.find.mockResolvedValue([
      makeProfile('writer-zoe', 'Zoe', 'Reis'),
      makeProfile('writer-ana', 'Ana', 'Lopes'),
    ]);

    const writers = await service.listMagazineWriters();

    expect(users.find).toHaveBeenCalledWith({
      where: {
        id: In([
          'writer-zoe',
          'writer-ana',
          'writer-suspended',
          'writer-no-profile',
        ]),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
    expect(profiles.find).toHaveBeenCalledWith({
      where: { userId: In(['writer-zoe', 'writer-ana', 'writer-no-profile']) },
    });
    expect(writers.map((writer) => writer.id)).toEqual([
      'writer-ana',
      'writer-zoe',
    ]);
    expect(writers[0]).toEqual({
      id: 'writer-ana',
      name: 'Ana Lopes',
      initials: 'AL',
      avatarUrl: null,
    });
  });

  it('skips the profile lookup when every grant holder is inactive', async () => {
    staffRoles.find.mockResolvedValue([{ userId: 'writer-suspended' }]);
    users.find.mockResolvedValue([]);

    await expect(service.listMagazineWriters()).resolves.toEqual([]);

    expect(profiles.find).not.toHaveBeenCalled();
  });
});

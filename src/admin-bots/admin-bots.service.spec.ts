import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { ProfilesService } from '../profiles/profiles.service';
import { ShapingKind } from '../profiles/entities/shaping.entity';
import { AdminBotsService } from './admin-bots.service';

type ProfilesServiceWriteMethods = Pick<
  ProfilesService,
  | 'updateMe'
  | 'updateUsername'
  | 'replaceSocials'
  | 'replaceWork'
  | 'replaceSkills'
  | 'replaceShapings'
  | 'replaceGroups'
>;

describe('AdminBotsService', () => {
  let service: AdminBotsService;
  let users: jest.Mocked<Pick<Repository<User>, 'findOne' | 'find'>>;
  let profiles: jest.Mocked<ProfilesServiceWriteMethods>;

  beforeEach(() => {
    users = {
      findOne: jest.fn(),
      find: jest.fn(),
    };
    profiles = {
      updateMe: jest.fn().mockResolvedValue({ ok: true }),
      updateUsername: jest.fn().mockResolvedValue({ ok: true }),
      replaceSocials: jest.fn().mockResolvedValue({ ok: true }),
      replaceWork: jest.fn().mockResolvedValue({ ok: true }),
      replaceSkills: jest.fn().mockResolvedValue({ ok: true }),
      replaceShapings: jest.fn().mockResolvedValue({ ok: true }),
      replaceGroups: jest.fn().mockResolvedValue({ ok: true }),
    };
    service = new AdminBotsService(
      users as unknown as Repository<User>,
      profiles as unknown as ProfilesService,
    );
  });

  it('throws NotFound when the target is not a system account', async () => {
    users.findOne.mockResolvedValue({ id: 'user-1', isSystem: false } as User);
    await expect(service.updateBotProfile('user-1', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(profiles.updateMe).not.toHaveBeenCalled();
  });

  it('throws NotFound when the target user does not exist', async () => {
    users.findOne.mockResolvedValue(null);
    await expect(
      service.updateBotProfile('missing', {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(profiles.updateMe).not.toHaveBeenCalled();
  });

  it('delegates to ProfilesService for a system account', async () => {
    users.findOne.mockResolvedValue({ id: 'bot-1', isSystem: true } as User);
    const dto = { bio: 'Hello' } as never;
    const result = await service.updateBotProfile('bot-1', dto);
    expect(profiles.updateMe).toHaveBeenCalledWith('bot-1', dto);
    expect(result).toEqual({ ok: true });
  });

  // Single source of truth for each write dto's contents. Each literal is
  // declared exactly once here and reused by BOTH the isSystem-gate table and
  // the delegation table below (via `invoke` and `expectedArgs`), instead of
  // being re-declared once per test block.
  const usernameDto = { username: 'newhandle' };
  const socialsDto = {
    items: [{ platform: 'twitter', urlOrHandle: '@bot' }],
  };
  const workDto = {
    items: [{ category: 'Community', title: 'Engineer', year: '2024' }],
  };
  const skillsDto = { items: [{ name: 'TypeScript', meta: 'Backend' }] };
  const shapingsDto = {
    items: [{ kind: ShapingKind.Book, title: 'A Book', note: 'A note' }],
  };
  const groupsDto = { items: [{ groupSlug: 'allies', role: 'member' }] };

  // One entry per write method except `updateBotProfile` (covered by its own
  // hand-written tests above), driving both the isSystem-gate table and the
  // system-account delegation table further below. `invoke` is parameterized
  // on `userId` so the same entry works for the non-system, missing, and
  // system-account scenarios; `expectedArgs` is the exact argument tuple the
  // underlying ProfilesService method must receive when the target IS a
  // system account.
  const writeMethods: Array<{
    name: string;
    invoke: (userId: string) => Promise<unknown>;
    // The typed method mocks from `jest.Mocked<...>` are `MockInstance`s, not
    // the constructable `jest.Mock`; widen to match what they actually are.
    profilesMock: () => jest.MockInstance<any, any[]>;
    expectedArgs: unknown[];
  }> = [
    {
      name: 'updateBotUsername',
      invoke: (userId) => service.updateBotUsername(userId, usernameDto),
      profilesMock: () => profiles.updateUsername,
      expectedArgs: ['bot-1', usernameDto.username],
    },
    {
      name: 'replaceBotSocials',
      invoke: (userId) => service.replaceBotSocials(userId, socialsDto),
      profilesMock: () => profiles.replaceSocials,
      expectedArgs: ['bot-1', socialsDto.items],
    },
    {
      name: 'replaceBotWork',
      invoke: (userId) => service.replaceBotWork(userId, workDto),
      profilesMock: () => profiles.replaceWork,
      expectedArgs: ['bot-1', workDto.items],
    },
    {
      name: 'replaceBotSkills',
      invoke: (userId) => service.replaceBotSkills(userId, skillsDto),
      profilesMock: () => profiles.replaceSkills,
      expectedArgs: ['bot-1', skillsDto.items],
    },
    {
      name: 'replaceBotShapings',
      invoke: (userId) => service.replaceBotShapings(userId, shapingsDto),
      profilesMock: () => profiles.replaceShapings,
      expectedArgs: ['bot-1', shapingsDto.items],
    },
    {
      name: 'replaceBotGroups',
      invoke: (userId) => service.replaceBotGroups(userId, groupsDto),
      profilesMock: () => profiles.replaceGroups,
      expectedArgs: ['bot-1', groupsDto.items],
    },
  ];

  describe('the isSystem gate', () => {
    it.each(writeMethods)(
      '$name rejects with NotFound and does not delegate when the target is not a system account',
      async ({ invoke, profilesMock }) => {
        users.findOne.mockResolvedValue({
          id: 'user-1',
          isSystem: false,
        } as User);
        await expect(invoke('user-1')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(profilesMock()).not.toHaveBeenCalled();
      },
    );

    it.each(writeMethods)(
      '$name rejects with NotFound and does not delegate when the target does not exist',
      async ({ invoke, profilesMock }) => {
        users.findOne.mockResolvedValue(null);
        await expect(invoke('missing')).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(profilesMock()).not.toHaveBeenCalled();
      },
    );
  });

  describe('delegation for a system account', () => {
    it.each(writeMethods)(
      '$name calls the underlying ProfilesService method with the right args',
      async ({ invoke, profilesMock, expectedArgs }) => {
        users.findOne.mockResolvedValue({
          id: 'bot-1',
          isSystem: true,
        } as User);
        await invoke('bot-1');
        expect(profilesMock()).toHaveBeenCalledWith(...expectedArgs);
      },
    );
  });

  describe('listBots', () => {
    it('queries system accounts with their profile and maps them to summaries', async () => {
      const systemAccount = {
        id: 'bot-1',
        isSystem: true,
        profile: {
          slug: 'queerpulse',
          firstName: 'QueerPulse',
          lastName: 'Team',
          avatarUrl: 'https://example.com/avatar.png',
        },
      } as User;
      users.find.mockResolvedValue([systemAccount]);

      const result = await service.listBots();

      expect(users.find).toHaveBeenCalledWith({
        where: { isSystem: true },
        relations: { profile: true },
      });
      expect(result).toEqual([
        {
          userId: 'bot-1',
          slug: 'queerpulse',
          firstName: 'QueerPulse',
          lastName: 'Team',
          avatarUrl: 'https://example.com/avatar.png',
        },
      ]);
    });
  });
});

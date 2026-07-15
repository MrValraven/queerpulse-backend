import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { Shaping, ShapingKind } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ProfilesService } from './profiles.service';

// A chainable query-builder stub whose terminal methods resolve to [].
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoin',
    'leftJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'take',
    'skip',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

describe('ProfilesService.getBySlug visibility', () => {
  let service: ProfilesService;
  let profiles: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let connections: { areConnected: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock; excludeBlocked: jest.Mock };
  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });

  const profile = (overrides = {}): Profile =>
    ({
      userId: 'owner-1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: 'they/them',
      tagline: 'hi',
      bio: 'longform',
      location: 'Lisbon',
      now: 'now text',
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
      ...overrides,
    }) as unknown as Profile;

  beforeEach(async () => {
    profiles = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    connections = { areConnected: jest.fn().mockResolvedValue(false) };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      excludeBlocked: jest.fn((qb) => qb),
    };
    const groupMemberships = {
      ...findEmpty(),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilesService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        { provide: getRepositoryToken(WorkItem), useValue: findEmpty() },
        { provide: getRepositoryToken(Skill), useValue: findEmpty() },
        { provide: getRepositoryToken(BoardPost), useValue: findEmpty() },
        { provide: getRepositoryToken(Shaping), useValue: findEmpty() },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        { provide: getRepositoryToken(Group), useValue: findEmpty() },
        {
          provide: getRepositoryToken(GroupMembership),
          useValue: groupMemberships,
        },
        { provide: DataSource, useValue: {} },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: ConnectionsService, useValue: connections },
        { provide: BlockFilterService, useValue: blockFilter },
      ],
    }).compile();
    service = module.get(ProfilesService);
  });

  it('404s an unknown slug', async () => {
    profiles.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the full profile for an open profile to any viewer', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Open }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
    expect((res as { bio: string }).bio).toBe('longform');
  });

  it('returns a limited card for a private profile to a non-owner', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Private }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
    expect((res as unknown as Record<string, unknown>).bio).toBeUndefined();
  });

  it('returns the full profile to the owner regardless of visibility', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Private }),
    );
    const res = await service.getBySlug('jo', 'owner-1');
    expect(res.limited).toBe(false);
  });

  it('treats network as limited for a non-owner (until Phase 6 connections)', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Network }),
    );
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(true);
  });

  it('returns the full network profile to an accepted connection', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Network }),
    );
    connections.areConnected.mockResolvedValue(true);
    const res = await service.getBySlug('jo', 'someone-else');
    expect(res.limited).toBe(false);
  });

  it('assembles the full profile with new relations and ISO joinedAt', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ visibility: ProfileVisibility.Open }),
    );
    const res = await service.getBySlug('jo', 'viewer');
    expect(res.limited).toBe(false);
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.joinedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(full.now).toBe('now text');
    expect(full.skills).toEqual([]);
    expect(full.board).toEqual([]);
    expect(full.groups).toEqual([]);
    expect(full.activity).toEqual([]);
    expect(full.related).toEqual([]);
  });

  it('skips the related-members query when the member has no tags or location', async () => {
    profiles.findOne.mockResolvedValue(
      profile({ tags: [], location: null, visibility: ProfileVisibility.Open }),
    );
    await service.getBySlug('jo', 'viewer');
    // loadRelated short-circuits: profiles.createQueryBuilder is only ever
    // called for related members, so with no tags/location it is never called.
    expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('updateMe writes now and returns the full profile', async () => {
    const p = profile({ visibility: ProfileVisibility.Open });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);
    const res = await service.updateMe('owner-1', { now: 'new now' });
    expect(p.now).toBe('new now');
    expect(res.limited).toBe(false);
    expect((res as { now: string | null }).now).toBe('new now');
  });

  describe('searchMembers', () => {
    it('applies excludeBlocked scoped to the viewer and the p.user_id column', async () => {
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      await service.searchMembers({}, 'viewer-1');

      expect(blockFilter.excludeBlocked).toHaveBeenCalledWith(
        qb,
        'viewer-1',
        '"p"."user_id"',
      );
    });
  });
});

describe('ProfilesService replace-list endpoints', () => {
  let service: ProfilesService;
  const findEmpty = () => ({ find: jest.fn().mockResolvedValue([]) });
  type TxManager = {
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  const txDataSource = () => ({
    transaction: jest.fn(async (cb: (m: TxManager) => Promise<void>) => {
      await cb({
        delete: jest.fn(),
        create: jest.fn((_e: unknown, v: unknown) => v),
        save: jest.fn(),
      });
    }),
  });

  type RepoMock = { find?: jest.Mock; createQueryBuilder?: jest.Mock };
  const build = async (overrides: {
    skills?: RepoMock;
    shapings?: RepoMock;
    groups?: RepoMock;
    groupMemberships?: RepoMock;
  }) => {
    const module = await Test.createTestingModule({
      providers: [
        ProfilesService,
        {
          provide: getRepositoryToken(Profile),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn() },
        },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        { provide: getRepositoryToken(WorkItem), useValue: findEmpty() },
        {
          provide: getRepositoryToken(Skill),
          useValue: overrides.skills ?? findEmpty(),
        },
        { provide: getRepositoryToken(BoardPost), useValue: findEmpty() },
        {
          provide: getRepositoryToken(Shaping),
          useValue: overrides.shapings ?? findEmpty(),
        },
        { provide: getRepositoryToken(Activity), useValue: findEmpty() },
        {
          provide: getRepositoryToken(Group),
          useValue: overrides.groups ?? findEmpty(),
        },
        {
          provide: getRepositoryToken(GroupMembership),
          useValue: overrides.groupMemberships ?? {
            ...findEmpty(),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: DataSource, useValue: txDataSource() },
        {
          provide: VouchService,
          useValue: {
            getVouchCount: jest.fn().mockResolvedValue(0),
            getVouchCounts: jest.fn().mockResolvedValue(new Map()),
          },
        },
        { provide: ConnectionsService, useValue: { areConnected: jest.fn() } },
        {
          provide: BlockFilterService,
          useValue: {
            isBlockedEitherWay: jest.fn().mockResolvedValue(false),
            excludeBlocked: jest.fn((qb: unknown) => qb),
          },
        },
      ],
    }).compile();
    return module.get(ProfilesService);
  };

  it('replaceSkills persists and returns name/meta only', async () => {
    const skillsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 's1',
          userId: 'u1',
          name: 'Web dev',
          meta: 'React',
          position: 0,
        },
      ]),
    };
    service = await build({ skills: skillsRepo });
    const res = await service.replaceSkills('u1', [
      { name: 'Web dev', meta: 'React' },
    ]);
    expect(res).toEqual([{ name: 'Web dev', meta: 'React' }]);
  });

  it('replaceShapings rejects a duplicate kind with 400', async () => {
    service = await build({});
    const items = [
      { kind: ShapingKind.Film, title: 'A', note: 'x' },
      { kind: ShapingKind.Film, title: 'B', note: 'y' },
    ];
    await expect(service.replaceShapings('u1', items)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('replaceGroups rejects an unknown group slug with 400', async () => {
    const groups = { find: jest.fn().mockResolvedValue([]) }; // slug not found
    service = await build({ groups });
    await expect(
      service.replaceGroups('u1', [{ groupSlug: 'nope', role: 'Member' }]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('replaceGroups rejects a duplicate group slug with 400', async () => {
    const groups = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: 'g1', slug: 'devs', name: 'Devs' }]),
    };
    service = await build({ groups });
    await expect(
      service.replaceGroups('u1', [
        { groupSlug: 'devs', role: 'Member' },
        { groupSlug: 'devs', role: 'Organiser' },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });
});

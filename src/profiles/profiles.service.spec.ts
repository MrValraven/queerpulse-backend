import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { HandlesService } from '../handles/handles.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { VouchService } from '../vouch/vouch.service';
import { truncateAtWord } from './directory-blurb';
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
    'addOrderBy',
    'setParameters',
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

const LONG_BIO =
  "I build things for the web and spend most weekends cooking for more people than my kitchen was designed for. Lately I've been learning to bind books.";

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
      identities: ['Queer'],
      lookingFor: ['Community & friendship'],
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
        { provide: HandlesService, useValue: { rename: jest.fn() } },
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
    // Private Interests fields stay hidden from a non-owner viewer.
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.identities).toEqual([]);
    expect(full.lookingFor).toEqual([]);
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
    // The owner gets their private Interests fields back.
    const full = res as Extract<typeof res, { limited: false }>;
    expect(full.identities).toEqual(['Queer']);
    expect(full.lookingFor).toEqual(['Community & friendship']);
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
    const res = await service.updateMe('owner-1', {
      now: 'new now',
      identities: ['Trans'],
      lookingFor: ['Creative collaboration'],
    });
    expect(p.now).toBe('new now');
    expect(p.identities).toEqual(['Trans']);
    expect(res.limited).toBe(false);
    const full = res;
    expect(full.now).toBe('new now');
    // updateMe is always the owner, so private fields come back.
    expect(full.identities).toEqual(['Trans']);
    expect(full.lookingFor).toEqual(['Creative collaboration']);
  });

  it('updateMe clears now when sent an empty string', async () => {
    const p = profile({ now: 'old status' });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    const res = await service.updateMe('owner-1', { now: '' });

    expect(p.now).toBeNull();
    const full = res;
    expect(full.now).toBeNull();
  });

  it('updateMe leaves now untouched when the field is omitted', async () => {
    const p = profile({ now: 'old status' });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', { tagline: 'new tagline' });

    expect(p.now).toBe('old status');
  });

  it('updateMe replaces openTo wholesale and keeps custom labels verbatim', async () => {
    const p = profile({ openTo: [{ kind: 'preset', id: 'swaps' }] });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    const res = await service.updateMe('owner-1', {
      openTo: [
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: 'A nurse or two for the testing nights' },
      ],
    });

    // A REPLACE, not a merge: the previous `swaps` chip is gone.
    expect(p.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'A nurse or two for the testing nights' },
    ]);
    const full = res;
    expect(full.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'A nurse or two for the testing nights' },
    ]);
  });

  it('updateMe clears openTo when sent an empty list', async () => {
    const p = profile({ openTo: [{ kind: 'preset', id: 'swaps' }] });
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', { openTo: [] });

    expect(p.openTo).toEqual([]);
  });

  it('updateMe normalizes openTo before saving', async () => {
    const p = profile();
    profiles.findOne.mockResolvedValue(p);
    (profiles as unknown as { save: jest.Mock }).save = jest
      .fn()
      .mockResolvedValue(p);

    await service.updateMe('owner-1', {
      openTo: [
        { kind: 'preset', id: 'mentoring' },
        { kind: 'preset', id: 'mentoring' },
        { kind: 'custom', label: '  Darkroom time  ' },
        { kind: 'custom', label: '   ' },
      ],
    });

    expect(p.openTo).toEqual([
      { kind: 'preset', id: 'mentoring' },
      { kind: 'custom', label: 'Darkroom time' },
    ]);
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

    it('serves the bio-derived blurb on the card, but the raw tagline on the profile', async () => {
      // The trap, end to end: one member, no short bio, a long bio. Their card
      // borrows the bio's opening so the directory isn't a grid of blank lines,
      // while GET /profiles/:slug must still say the short bio is empty —
      // otherwise the editor seeds its input with words they never wrote and a
      // Save silently commits them.
      const p = profile({ tagline: '', bio: LONG_BIO });
      const qb = qbStub();
      qb.getManyAndCount.mockResolvedValue([[p], 1]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      profiles.findOne.mockResolvedValue(p);

      const list = await service.searchMembers({}, 'viewer-1');
      expect(list.items[0].tagline).toBe(truncateAtWord(LONG_BIO));
      expect(list.items[0].tagline!.endsWith('…')).toBe(true);
      expect(list.items[0]).not.toHaveProperty('bio');

      const detail = await service.getBySlug('jo', 'viewer-1');
      expect(detail.tagline).toBe('');
    });
  });

  describe('getMine', () => {
    it('resolves the caller own slug and returns the full profile', async () => {
      profiles.findOne.mockResolvedValue({ slug: 'tiago-costa', userId: 'u1' });
      const spy = jest
        .spyOn(service, 'getBySlug')
        .mockResolvedValue({ limited: false } as never);

      const res = await service.getMine('u1');

      expect(profiles.findOne).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
      expect(spy).toHaveBeenCalledWith('tiago-costa', 'u1');
      expect(res).toEqual({ limited: false });
    });

    it('throws NotFound when the caller has no profile row', async () => {
      profiles.findOne.mockResolvedValue(null);
      await expect(service.getMine('u1')).rejects.toThrow(NotFoundException);
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

  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  type RepoMock = {
    find?: jest.Mock;
    findOne?: jest.Mock;
    createQueryBuilder?: jest.Mock;
    save?: jest.Mock;
  };
  const build = async (overrides: {
    profiles?: RepoMock;
    skills?: RepoMock;
    shapings?: RepoMock;
    groups?: RepoMock;
    groupMemberships?: RepoMock;
    workItems?: RepoMock;
  }) => {
    const module = await Test.createTestingModule({
      providers: [
        ProfilesService,
        {
          provide: getRepositoryToken(Profile),
          useValue: overrides.profiles ?? {
            findOne: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        { provide: getRepositoryToken(SocialLink), useValue: findEmpty() },
        {
          provide: getRepositoryToken(WorkItem),
          useValue: overrides.workItems ?? findEmpty(),
        },
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
        { provide: HandlesService, useValue: { rename: jest.fn() } },
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

  it('replaceWork converts a stored image key to an API files URL on return', async () => {
    const key =
      'work/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000.png';
    const workItemsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: 'w1',
          userId: 'u1',
          category: 'Dev',
          title: 'X',
          year: '2022',
          imageUrl: key,
          position: 0,
        },
      ]),
    };
    service = await build({ workItems: workItemsRepo });

    const res = await service.replaceWork('u1', [
      { category: 'Dev', title: 'X', year: '2022', imageUrl: key },
    ]);

    expect(res[0].imageUrl).toBe(`https://api.test/files/${key}`);
  });

  it('updateMe persists an uploaded avatar key to Profile.avatarUrl and returns it as a files URL', async () => {
    const key =
      'avatars/11111111-2222-3333-4444-555555555555/77777777-8888-9999-aaaa-bbbbbbbbbbbb.jpg';
    const p = {
      userId: 'u1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: null,
      tagline: null,
      bio: null,
      location: null,
      now: null,
      avatarUrl: null,
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: [],
      discoverableIdentities: [],
      lookingFor: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    } as unknown as Profile;
    const profilesRepo = {
      findOne: jest.fn().mockResolvedValue(p),
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn().mockResolvedValue(p),
    };
    service = await build({
      profiles: profilesRepo,
      // buildFullProfile -> loadGroups needs a real chainable stub; the
      // default groupMemberships override only stubs `createQueryBuilder` as
      // a bare jest.fn(), which resolves to undefined and breaks the chain.
      groupMemberships: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => qbStub()),
      },
    });

    const res = await service.updateMe('u1', { avatarUrl: key });

    // The DTO's avatarUrl rides in on `rest` via `Object.assign(profile, rest)`
    // — no dedicated service code, exactly like SubprofilesService.update.
    expect(p.avatarUrl).toBe(key);
    expect(profilesRepo.save).toHaveBeenCalledWith(p);
    expect(res.avatarUrl).toBe(`https://api.test/files/${key}`);
  });

  it('updateMe clears the avatar back to null when sent null', async () => {
    const p = {
      userId: 'u1',
      slug: 'jo',
      firstName: 'Jo',
      lastName: 'Lee',
      pronouns: null,
      tagline: null,
      bio: null,
      location: null,
      now: null,
      avatarUrl: 'avatars/11111111-2222-3333-4444-555555555555/old.jpg',
      visibility: ProfileVisibility.Open,
      openTo: [],
      identities: [],
      discoverableIdentities: [],
      lookingFor: [],
      tags: [],
      verified: false,
      joinedAt: new Date('2024-03-01T00:00:00.000Z'),
    } as unknown as Profile;
    const profilesRepo = {
      findOne: jest.fn().mockResolvedValue(p),
      createQueryBuilder: jest.fn(() => qbStub()),
      save: jest.fn().mockResolvedValue(p),
    };
    service = await build({
      profiles: profilesRepo,
      groupMemberships: {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn(() => qbStub()),
      },
    });

    const res = await service.updateMe('u1', { avatarUrl: null });

    expect(p.avatarUrl).toBeNull();
    expect(res.avatarUrl).toBeNull();
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

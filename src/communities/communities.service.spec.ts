import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { CommunitiesService } from './communities.service';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `profiles.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'groupBy',
    'orderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  return qb;
};

// The `.insert().into().values().orIgnore().execute()` chain used by
// `join`'s public-tier instant-add and `triageJoinRequest`'s approve-upsert
// (mirrors `community-posts.service.spec.ts`'s `insertQbStub`, itself
// mirroring `EventsService.addCohost`'s idiom).
const insertQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.insert = jest.fn().mockReturnValue(qb);
  qb.into = jest.fn().mockReturnValue(qb);
  qb.values = jest.fn().mockReturnValue(qb);
  qb.orIgnore = jest.fn().mockReturnValue(qb);
  qb.execute = jest.fn().mockResolvedValue({ raw: [], generatedMaps: [] });
  return qb;
};

describe('CommunitiesService', () => {
  let service: CommunitiesService;
  let communities: {
    findOne: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let members: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let posts: { createQueryBuilder: jest.Mock };
  let replies: { createQueryBuilder: jest.Mock };
  let joinRequests: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    communities = {
      findOne: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((v: object) => v),
      save: jest.fn((c: unknown) => Promise.resolve(c)),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    members = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      // Synthesizes generated columns (`id`, `joinedAt`) so a mapper reading
      // them off a `save()` result never sees `undefined` (the A4 lesson:
      // a bare-passthrough mock caused an `undefined.toISOString()` throw).
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'member-id',
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    posts = { createQueryBuilder: jest.fn(() => qbStub()) };
    replies = { createQueryBuilder: jest.fn(() => qbStub()) };
    joinRequests = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) =>
        Promise.resolve({
          id: 'jr-id',
          status: JoinRequestStatus.Pending,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(v as object),
        }),
      ),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so `communities.save`/`members.save`
    // assertions work whether the code path runs inside the transaction or
    // not — the transaction is otherwise opaque to the caller.
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Community) return communities;
        if (entity === CommunityMember) return members;
        if (entity === CommunityJoinRequest) return joinRequests;
        if (entity === Profile) return profiles;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
    };
    const dataSource = {
      transaction: jest.fn(
        async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunitiesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        { provide: getRepositoryToken(CommunityPostReply), useValue: replies },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: joinRequests,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(CommunitiesService);
  });

  describe('create', () => {
    it('creates a community: owner roster row, ref assigned, slug from handle', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
      };
      const res = await service.create('u1', dto as any);
      expect(res.slug).toBe('queer-devs');
      expect(res.ref).toMatch(/^QP-C-\d{4}$/);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );
    });

    it('seeds stewards as mod roster rows via slug lookup, skipping the owner', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      const qb = qbStub();
      qb.getMany.mockResolvedValue([{ slug: 'jo', userId: 'steward-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
        stewards: ['jo'],
      };
      await service.create('u1', dto as any);

      expect(members.save).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'steward-1', role: RosterRole.Mod }),
      ]);
    });

    it('does not enroll invites onto the roster (no membership without consent)', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      // Even when the invited slug resolves to a real, active profile, no
      // CommunityMember row should ever be created for it.
      const qb = qbStub();
      qb.getMany.mockResolvedValue([{ slug: 'invitee', userId: 'invitee-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
        invites: ['invitee'],
      };
      await service.create('u1', dto as any);

      // Only the owner roster row is ever saved — no extra `members.save`
      // call (and thus no roster row) for the invited slug.
      expect(members.save).toHaveBeenCalledTimes(1);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );
      expect(members.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'invitee-1' }),
      );
    });

    it('seeds stewards but never invites when both are present on the same create', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      const qb = qbStub();
      qb.getMany.mockResolvedValue([
        { slug: 'jo', userId: 'steward-1' },
        { slug: 'invitee', userId: 'invitee-1' },
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);

      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
        stewards: ['jo'],
        invites: ['invitee'],
      };
      await service.create('u1', dto as any);

      // The second `members.save` call is the roster-seed batch — exactly
      // the steward, nothing for the invitee.
      expect(members.save).toHaveBeenCalledTimes(2);
      expect(members.save).toHaveBeenCalledWith([
        expect.objectContaining({ userId: 'steward-1', role: RosterRole.Mod }),
      ]);
    });

    it('retries ref/slug allocation on a unique-violation race and eventually succeeds', async () => {
      communities.save
        .mockRejectedValueOnce({ code: '23505' })
        .mockImplementationOnce((c: Partial<Community>) =>
          Promise.resolve({
            ...c,
            id: 'c1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        );
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);

      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
      };
      const res = await service.create('u1', dto as any);

      expect(res.ref).toMatch(/^QP-C-\d{4}$/);
      expect(communities.save).toHaveBeenCalledTimes(2);
    });

    it('gives up after exhausting retries on a persistent unique violation', async () => {
      communities.save.mockRejectedValue({ code: '23505' });

      const dto = {
        name: 'Queer Devs',
        handle: 'queer-devs',
        type: 'professional',
        accessTier: 'public',
        rosterVisible: true,
        features: [],
        rules: [],
        purpose: 'x',
        whoFor: 'y',
        tagline: 'z',
      };
      await expect(service.create('u1', dto as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(communities.save).toHaveBeenCalledTimes(5);
    });
  });

  describe('getBySlug', () => {
    it('404s a private community for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'p',
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('p', 'u2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('shows a private community to one of its roster members', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'p',
        accessTier: AccessTier.Private,
        ownerId: 'owner-1',
        name: 'Priv',
        type: CommunityType.Social,
        tagline: 't',
        ref: 'QP-C-0001',
        purpose: 'purpose',
        whoFor: 'who',
        rosterVisible: true,
        features: [],
        rules: [],
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      const detail = await service.getBySlug('p', 'u2');
      expect(detail.myRole).toBe(RosterRole.Member);
    });

    it('404s an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('list', () => {
    it("filter='mine' inner-joins on the viewer's own membership and returns only those rows", async () => {
      const qb = qbStub();
      const row = {
        id: 'c1',
        slug: 'a',
        name: 'A',
        type: CommunityType.Social,
        tagline: 't',
        accessTier: AccessTier.Public,
        ref: 'QP-C-0001',
      };
      qb.getManyAndCount.mockResolvedValue([[row], 1]);
      communities.createQueryBuilder.mockReturnValue(qb);
      members.find.mockResolvedValue([
        { communityId: 'c1', userId: 'u1', role: RosterRole.Member },
      ]);

      const result = await service.list('u1', { filter: 'mine' });

      expect(qb.innerJoin).toHaveBeenCalledWith(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId: 'u1' },
      );
      expect(qb.leftJoin).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].slug).toBe('a');
      expect(result.items[0].myRole).toBe(RosterRole.Member);
    });

    it("default filter='discover' left-joins membership and excludes private for non-members", async () => {
      const qb = qbStub();
      communities.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', {});

      expect(qb.leftJoin).toHaveBeenCalledWith(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId: 'u1' },
      );
      expect(qb.andWhere).toHaveBeenCalledWith(
        '(c.access_tier != :privateTier OR m.user_id = :viewerId)',
        { privateTier: AccessTier.Private, viewerId: 'u1' },
      );
    });
  });

  describe('update', () => {
    it('rejects a non-owner/non-mod', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.update('x', 'intruder', { name: 'new' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists a partial update for the owner', async () => {
      const community = {
        id: 'c1',
        slug: 'x',
        ownerId: 'u1',
        name: 'Old',
        purpose: 'p',
        type: CommunityType.Social,
        whoFor: 'w',
        tagline: 't',
        accessTier: AccessTier.Public,
        rosterVisible: true,
        features: [],
        rules: [],
        ref: 'QP-C-0001',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });

      const res = await service.update('x', 'u1', { name: 'New name' });
      expect(res.name).toBe('New name');
      expect(communities.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New name' }),
      );
    });

    it('allows a mod (not just the owner) to update', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
        name: 'Old',
        purpose: 'p',
        type: CommunityType.Social,
        whoFor: 'w',
        tagline: 't',
        accessTier: AccessTier.Public,
        rosterVisible: true,
        features: [],
        rules: [],
        ref: 'QP-C-0001',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      await expect(
        service.update('x', 'mod-1', { tagline: 'new tagline' }),
      ).resolves.toMatchObject({ tagline: 'new tagline' });
    });
  });

  describe('join', () => {
    it('joins a public-tier community instantly via an idempotent (orIgnore) insert', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Public,
      });
      members.findOne.mockResolvedValue(null);
      const insertQb = insertQbStub();
      members.createQueryBuilder.mockReturnValue(insertQb);

      const res = await service.join('x', 'u1', {});

      expect(res).toEqual({
        outcome: 'joined',
        role: RosterRole.Member,
        request: null,
      });
      expect(insertQb.insert).toHaveBeenCalled();
      expect(insertQb.into).toHaveBeenCalledWith(CommunityMember);
      expect(insertQb.values).toHaveBeenCalledWith({
        communityId: 'c1',
        userId: 'u1',
        role: RosterRole.Member,
      });
      expect(insertQb.orIgnore).toHaveBeenCalled();
    });

    it('creates a pending join request for a request-tier community; a second pending request conflicts', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue(null);
      profiles.find.mockResolvedValue([
        {
          userId: 'u1',
          slug: 'jo',
          firstName: 'Jo',
          lastName: 'D',
          avatarUrl: null,
        },
      ]);

      const res = await service.join('x', 'u1', { note: 'let me in' });

      expect(res.outcome).toBe('requested');
      expect(res.role).toBeNull();
      expect(res.request).toMatchObject({
        status: JoinRequestStatus.Pending,
        note: 'let me in',
      });
      expect(res.request?.member.slug).toBe('jo');

      // The partial-unique index on (community_id, user_id) WHERE
      // status='pending' backstops a double-request race — a hit surfaces
      // here as 23505, which must map to Conflict, not a 500.
      joinRequests.save.mockRejectedValueOnce({ code: '23505' });
      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('is idempotent for an already-existing member: resolves joined, never throws', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Request,
      });
      members.findOne.mockResolvedValue({
        id: 'm1',
        communityId: 'c1',
        userId: 'u1',
        role: RosterRole.Member,
      });

      const res = await service.join('x', 'u1', {});

      expect(res).toEqual({
        outcome: 'joined',
        role: RosterRole.Member,
        request: null,
      });
    });
  });

  describe('roster', () => {
    it('forbids a non-member from viewing the roster when rosterVisible=false', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        rosterVisible: false,
      });
      members.findOne.mockResolvedValue(null);
      await expect(service.roster('x', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('404s a private community for a non-member, even though rosterVisible defaults true', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Private,
        rosterVisible: true,
      });
      members.findOne.mockResolvedValue(null);
      await expect(service.roster('x', 'stranger')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('triageJoinRequest', () => {
    it('requires owner/mod; approving adds a roster row and marks the request approved', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });

      // A plain member cannot triage.
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.triageJoinRequest('x', 'jr1', 'intruder', 'approve'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // A mod can: approving flips the status and upserts the roster row.
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      joinRequests.findOne.mockResolvedValue({
        id: 'jr1',
        communityId: 'c1',
        userId: 'applicant-1',
        note: 'hi',
        status: JoinRequestStatus.Pending,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'applicant-1',
          slug: 'applicant',
          firstName: 'A',
          lastName: 'P',
          avatarUrl: null,
        },
      ]);
      const insertQb = insertQbStub();
      members.createQueryBuilder.mockReturnValue(insertQb);

      const res = await service.triageJoinRequest(
        'x',
        'jr1',
        'mod-1',
        'approve',
      );

      expect(res.status).toBe(JoinRequestStatus.Approved);
      expect(insertQb.insert).toHaveBeenCalled();
      expect(insertQb.into).toHaveBeenCalledWith(CommunityMember);
      expect(insertQb.values).toHaveBeenCalledWith({
        communityId: 'c1',
        userId: 'applicant-1',
        role: RosterRole.Member,
      });
      expect(insertQb.orIgnore).toHaveBeenCalled();
    });

    it('rejects triaging an already-resolved (approved) request', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      joinRequests.findOne.mockResolvedValue({
        id: 'jr1',
        communityId: 'c1',
        userId: 'applicant-1',
        note: 'hi',
        status: JoinRequestStatus.Approved,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      await expect(
        service.triageJoinRequest('x', 'jr1', 'mod-1', 'decline'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('removeMember', () => {
    it('refuses to remove the owner (self-leave or mod-remove alike)', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany.mockResolvedValue([{ slug: 'owner-slug', userId: 'owner-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne.mockResolvedValue({ id: 'm1', role: RosterRole.Owner });

      await expect(
        service.removeMember('x', 'owner-1', 'owner-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(members.delete).not.toHaveBeenCalled();
    });
  });

  describe('myCommunities', () => {
    it('returns a bare, unpaginated array of the caller`s roster rows', async () => {
      const qb = qbStub();
      qb.getRawMany.mockResolvedValue([
        {
          slug: 'trans-joy',
          name: 'Trans Joy',
          role: RosterRole.Mod,
          joinedAt: new Date('2026-02-02T00:00:00.000Z'),
        },
        {
          slug: 'book-club',
          name: 'Book Club',
          role: RosterRole.Member,
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      members.createQueryBuilder.mockReturnValue(qb);

      const res = await service.myCommunities('me-1');

      // A plain array — no `items`/`page`/`total` envelope. Paginating this
      // is the defect the endpoint exists to fix.
      expect(Array.isArray(res)).toBe(true);
      expect(res).toEqual([
        {
          slug: 'trans-joy',
          name: 'Trans Joy',
          role: RosterRole.Mod,
          joinedAt: '2026-02-02T00:00:00.000Z',
        },
        {
          slug: 'book-club',
          name: 'Book Club',
          role: RosterRole.Member,
          joinedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      expect(qb.skip).not.toHaveBeenCalled();
      expect(qb.take).not.toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('m.user_id = :userId', {
        userId: 'me-1',
      });
    });

    it('is sourced from community_members only, so a pending join request is never a membership', async () => {
      const qb = qbStub();
      members.createQueryBuilder.mockReturnValue(qb);

      await expect(service.myCommunities('applicant-1')).resolves.toEqual([]);

      // The join-requests table is never consulted: a pending request has no
      // roster row, so it is excluded structurally rather than by a filter.
      expect(joinRequests.find).not.toHaveBeenCalled();
      expect(joinRequests.findOne).not.toHaveBeenCalled();
    });
  });

  describe('setMemberRole', () => {
    const community = { id: 'c1', slug: 'x', ownerId: 'owner-1' };

    // Resolves `memberSlug` -> userId through `MemberLookup.userIdForSlug`,
    // which runs on the profiles query builder.
    const resolveSlug = (slug: string, userId: string) => {
      const qb = qbStub();
      qb.getMany.mockResolvedValue([{ slug, userId }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
    };

    beforeEach(() => {
      communities.findOne.mockResolvedValue(community);
    });

    it('lets the owner promote a member to mod', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' }) // actor
        .mockResolvedValueOnce({
          id: 'm2',
          role: RosterRole.Member,
          userId: 'target-1',
        }); // target

      const res = await service.setMemberRole(
        'x',
        'owner-1',
        'target-slug',
        RosterRole.Mod,
      );

      expect(res).toEqual({
        slug: 'x',
        memberSlug: 'target-slug',
        role: RosterRole.Mod,
      });
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm2', role: RosterRole.Mod }),
      );
    });

    it('lets a mod promote a plain member to mod', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' })
        .mockResolvedValueOnce({
          id: 'm2',
          role: RosterRole.Member,
          userId: 'target-1',
        });

      await expect(
        service.setMemberRole('x', 'mod-1', 'target-slug', RosterRole.Mod),
      ).resolves.toEqual({
        slug: 'x',
        memberSlug: 'target-slug',
        role: RosterRole.Mod,
      });
    });

    it('forbids a plain member from changing anyone`s role', async () => {
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        userId: 'nobody-1',
      });

      await expect(
        service.setMemberRole('x', 'nobody-1', 'target-slug', RosterRole.Mod),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(members.save).not.toHaveBeenCalled();
      // Authorization runs before the target is resolved, so an unauthorized
      // caller learns nothing about who is on the roster.
      expect(profiles.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('forbids a non-member (stranger) from changing anyone`s role', async () => {
      members.findOne.mockResolvedValue(null);

      await expect(
        service.setMemberRole('x', 'stranger', 'target-slug', RosterRole.Mod),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('refuses to demote the owner, even when a mod asks', async () => {
      resolveSlug('owner-slug', 'owner-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' })
        .mockResolvedValueOnce({
          id: 'm1',
          role: RosterRole.Owner,
          userId: 'owner-1',
        });

      await expect(
        service.setMemberRole('x', 'mod-1', 'owner-slug', RosterRole.Member),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('refuses to demote the owner even when the owner asks (ownership is immutable here)', async () => {
      resolveSlug('owner-slug', 'owner-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' })
        .mockResolvedValueOnce({
          id: 'm1',
          role: RosterRole.Owner,
          userId: 'owner-1',
        });

      await expect(
        service.setMemberRole('x', 'owner-1', 'owner-slug', RosterRole.Member),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('forbids a mod from demoting a peer mod (only the owner can)', async () => {
      resolveSlug('peer-slug', 'peer-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' })
        .mockResolvedValueOnce({
          id: 'm3',
          role: RosterRole.Mod,
          userId: 'peer-1',
        });

      await expect(
        service.setMemberRole('x', 'mod-1', 'peer-slug', RosterRole.Member),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('lets the owner demote a mod back to member', async () => {
      resolveSlug('peer-slug', 'peer-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' })
        .mockResolvedValueOnce({
          id: 'm3',
          role: RosterRole.Mod,
          userId: 'peer-1',
        });

      await expect(
        service.setMemberRole('x', 'owner-1', 'peer-slug', RosterRole.Member),
      ).resolves.toEqual({
        slug: 'x',
        memberSlug: 'peer-slug',
        role: RosterRole.Member,
      });
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm3', role: RosterRole.Member }),
      );
    });

    it('forbids a mod from changing their own role', async () => {
      resolveSlug('mod-slug', 'mod-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' })
        .mockResolvedValueOnce({
          id: 'm2',
          role: RosterRole.Mod,
          userId: 'mod-1',
        });

      await expect(
        service.setMemberRole('x', 'mod-1', 'mod-slug', RosterRole.Member),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('404s an unknown member slug, and a member of a different community', async () => {
      // Unknown slug -> MemberLookup resolves nothing.
      const emptyQb = qbStub();
      profiles.createQueryBuilder.mockReturnValue(emptyQb);
      members.findOne.mockResolvedValue({
        role: RosterRole.Owner,
        userId: 'owner-1',
      });
      await expect(
        service.setMemberRole('x', 'owner-1', 'ghost', RosterRole.Mod),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Known member, but no roster row in *this* community.
      resolveSlug('elsewhere-slug', 'elsewhere-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' })
        .mockResolvedValueOnce(null);
      await expect(
        service.setMemberRole('x', 'owner-1', 'elsewhere-slug', RosterRole.Mod),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(members.save).not.toHaveBeenCalled();
    });

    it('404s an unknown community before any authorization work', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(
        service.setMemberRole('nope', 'owner-1', 'target-slug', RosterRole.Mod),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent: re-promoting an existing mod as the owner writes nothing', async () => {
      resolveSlug('peer-slug', 'peer-1');
      members.findOne
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' })
        .mockResolvedValueOnce({
          id: 'm3',
          role: RosterRole.Mod,
          userId: 'peer-1',
        });

      await expect(
        service.setMemberRole('x', 'owner-1', 'peer-slug', RosterRole.Mod),
      ).resolves.toEqual({
        slug: 'x',
        memberSlug: 'peer-slug',
        role: RosterRole.Mod,
      });
      expect(members.save).not.toHaveBeenCalled();
    });
  });
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { ConnectionsService } from '../connections/connections.service';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  CommunitiesService,
  CreateCommunityInput,
} from './communities.service';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import { COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS } from './community-ban-ratification-window';
import { CommunityBan } from './entities/community-ban.entity';
import {
  CommunityInvite,
  CommunityInviteStatus,
} from './entities/community-invite.entity';
import {
  COMMUNITY_BAN_AUDIT_ACTION,
  COMMUNITY_REMOVAL_AUDIT_ACTION,
  CommunityGovernanceLogService,
} from './community-governance-log.service';
import {
  CommunityJoinRequest,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import {
  CommunityTagRequest,
  CommunityTagRequestStatus,
} from './entities/community-tag-request.entity';
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
    'addOrderBy',
    'skip',
    'take',
    'limit',
    'offset',
    // Singular, and distinct from `setParameters`: the tag facet count query
    // binds one parameter per tag as it builds the select
    // (`countByFilterClauses`), same as `profiles.service.spec.ts`'s stub.
    'setParameter',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  // The tag facet count reads one aggregate row. `undefined` is the honest
  // stub: `countByFilterClauses` treats a missing row as zero for every tag.
  qb.getRawOne = jest.fn().mockResolvedValue(undefined);
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

// `community_invites` is driven through BOTH chains: `create`/`invite` insert
// pending rows (`.insert().into().values().orIgnore().execute()`) and
// `acceptInvite` claims one (`.update().set().where().execute()`). One stub
// answers both, so a test never has to know which the path under test picks.
const inviteQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const method of [
    'insert',
    'into',
    'values',
    'orIgnore',
    'update',
    'set',
    'where',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest
    .fn()
    .mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });
  return qb;
};

// The `.update().set().where().execute()` chain `triageJoinRequest` uses for
// its atomic conditional claim (flip pending -> approved/declined only while
// still pending). Defaults to `affected: 1` — the claim succeeded — so the
// approve branch proceeds to the roster upsert.
const updateQbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  qb.update = jest.fn().mockReturnValue(qb);
  qb.set = jest.fn().mockReturnValue(qb);
  qb.where = jest.fn().mockReturnValue(qb);
  qb.execute = jest.fn().mockResolvedValue({ affected: 1, raw: [] });
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
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let profiles: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let users: { findOne: jest.Mock; find: jest.Mock };
  // `getBySlug` consults the moderation state before returning a detail; a
  // VISIBLE (`hidden:false, removed:false`) default keeps every non-moderation
  // test on the normal path. `notifications` is fire-and-forget on join/triage
  // flows, so a no-op stub suffices.
  let contentModeration: { stateFor: jest.Mock };
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let governanceLog: { log: jest.Mock; logModerationAudit: jest.Mock };
  // `suggestedCommunities`'s social-graph signal and `unfreeze`'s
  // automatic-freeze gate (BE-COM-04). Neither is exercised by the flows
  // below beyond needing to resolve, so both default to the permissive
  // answer: no connections, and zero open reports.
  let connections: { allAcceptedConnectionUserIds: jest.Mock };
  let autoFreeze: { openReportCount: jest.Mock };
  let bans: {
    exists: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let tagRequests: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  // The door gate for the `private` and `invite` tiers (PRD-140/PRD-141).
  // Default: nobody holds an invitation, which is the ordinary case and the
  // one every pre-existing test below was written against.
  let invites: {
    findOne: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  // Fire-and-forget roster-membership domain events
  // (`COMMUNITY_MEMBER_JOINED` / `COMMUNITY_MEMBER_LEFT`).
  let eventEmitter: { emit: jest.Mock };
  let banRatifications: { proposePermanentBar: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };
  // The transaction manager `createWithUniqueRef` runs inside; `query` is the
  // raw `SELECT nextval('communities_ref_seq')` ref allocation.
  let manager: { query: jest.Mock; getRepository: jest.Mock };

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
      // `withdrawMyJoinRequest` deletes the caller's own pending row and reads
      // `affected` back. Default: one row went, the ordinary withdrawal.
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => updateQbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    // `resolveInvitees` batches a house-account (`isSystem`) exclusion
    // lookup over every resolved invitee; an empty result means "none of
    // them is a system account".
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };
    governanceLog = {
      log: jest.fn().mockResolvedValue(undefined),
      // `removeMember` now also writes a `mod_audit_logs` row, which is what
      // makes a community ban appealable at all.
      logModerationAudit: jest.fn().mockResolvedValue(undefined),
    };
    connections = {
      allAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
    };
    autoFreeze = {
      openReportCount: jest.fn().mockResolvedValue(0),
    };
    // `join` asks whether the applicant is barred (`exists`), and
    // `removeMember` writes the bar through an insert chain then READS IT BACK
    // (`barReturn` trusts the row on file, never the values it just sent, so
    // the conflict path describes the ban actually in force). Default: nobody
    // is banned, and the read-back finds nothing.
    bans = {
      exists: jest.fn().mockResolvedValue(false),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => insertQbStub()),
    };
    tagRequests = {
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      find: jest.fn().mockResolvedValue([]),
    };
    invites = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => inviteQbStub()),
    };
    eventEmitter = { emit: jest.fn() };
    // PRD-25. A permanent bar opens a hold for a second owner, co-owner or
    // moderator. The DEFAULT here is "this community has somebody else who
    // could sign", because that is the ordinary case; the solo-owner fallback
    // is the null return, exercised explicitly below.
    banRatifications = {
      proposePermanentBar: jest.fn().mockResolvedValue({
        id: 'hold-1',
        expiresAt: new Date('2026-01-04T00:00:00.000Z'),
      }),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use, so `communities.save`/`members.save`
    // assertions work whether the code path runs inside the transaction or
    // not — the transaction is otherwise opaque to the caller.
    // `communities_ref_seq` (BE-COM-23) — `createWithUniqueRef` allocates the
    // `QP-C-####` ref with a raw `SELECT nextval(...)` through the transaction
    // manager instead of `COUNT(*) + 1`. Returns a string, like the pg driver
    // does for a bigint.
    let nextCommunityRefNumber = 0;
    manager = {
      query: jest.fn(() => {
        nextCommunityRefNumber += 1;
        return Promise.resolve([{ refNumber: String(nextCommunityRefNumber) }]);
      }),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Community) return communities;
        if (entity === CommunityMember) return members;
        if (entity === CommunityJoinRequest) return joinRequests;
        if (entity === CommunityInvite) return invites;
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
        {
          provide: getRepositoryToken(CommunityTagRequest),
          useValue: tagRequests,
        },
        { provide: getRepositoryToken(CommunityBan), useValue: bans },
        { provide: getRepositoryToken(CommunityInvite), useValue: invites },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: DataSource, useValue: dataSource },
        {
          provide: ContentModerationService,
          useValue: contentModeration,
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        {
          provide: CommunityGovernanceLogService,
          useValue: governanceLog,
        },
        { provide: ConnectionsService, useValue: connections },
        { provide: CommunityAutoFreezeService, useValue: autoFreeze },
        { provide: EventEmitter2, useValue: eventEmitter },
        {
          provide: CommunityBanRatificationService,
          useValue: banRatifications,
        },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(CommunitiesService);
    // `toCommunityDetail` resolves `coverImageUrl` through `toImageUrl`, which
    // throws `Service temporarily unavailable` when the base was never wired.
    // Only fixtures carrying a storage-key cover hit it (the M1 foreign-cover
    // cases), which is why it bites those and not the rest.
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
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
      const res = await service.create('u1', dto as CreateCommunityInput);
      expect(res.slug).toBe('queer-devs');
      expect(res.ref).toBe('QP-C-0001');
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );
      // BE-COM-23: the ref comes from `communities_ref_seq`, never
      // `COUNT(*) + 1` — a hard-deleted community used to make every later
      // create collide on `UQ_communities_ref`.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("nextval('communities_ref_seq')"),
      );
      expect(communities.count).not.toHaveBeenCalled();
    });

    // BE-COM-06: `stewards` used to be seeded straight into the roster as
    // `mod` inside the create transaction — no notification, no accept step,
    // no way to decline. Any member could make up to 50 other members
    // moderators of a community they never agreed to. A steward is now only
    // INVITED (a `CommunityInviteReceived` carrying `proposedRole: 'mod'`),
    // and the owner promotes them with `setMemberRole` once they join.
    it('invites stewards with proposedRole=mod instead of seeding roster rows', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        slug: 'queer-devs',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([{ slug: 'jo', userId: 'steward-1' }]);
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
      await service.create('u1', dto as CreateCommunityInput);

      // The creator's own `owner` row is the only membership written.
      expect(members.save).toHaveBeenCalledTimes(1);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );
      expect(members.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'steward-1' }),
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['steward-1'],
        NotificationType.CommunityInviteReceived,
        expect.objectContaining({
          actorId: 'u1',
          communitySlug: 'queer-devs',
          proposedRole: RosterRole.Mod,
        }),
        'u1',
      );
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
      qb.getMany!.mockResolvedValue([{ slug: 'invitee', userId: 'invitee-1' }]);
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
      await service.create('u1', dto as CreateCommunityInput);

      // Only the owner roster row is ever saved — no extra `members.save`
      // call (and thus no roster row) for the invited slug.
      expect(members.save).toHaveBeenCalledTimes(1);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );
      expect(members.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'invitee-1' }),
      );
      // A plain invite carries no `proposedRole` — that field is what
      // distinguishes a steward ask from an ordinary one.
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['invitee-1'],
        NotificationType.CommunityInviteReceived,
        expect.not.objectContaining({
          proposedRole: expect.anything() as unknown,
        }),
        'u1',
      );
    });

    it('invites both stewards and invites, and writes no roster row for either', async () => {
      communities.save.mockImplementation((c: Partial<Community>) => ({
        ...c,
        id: 'c1',
        slug: 'queer-devs',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }));
      members.save.mockImplementation((m: Partial<CommunityMember>) => m);
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([
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
      await service.create('u1', dto as CreateCommunityInput);

      // One roster write only: the creator's `owner` row.
      expect(members.save).toHaveBeenCalledTimes(1);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', role: RosterRole.Owner }),
      );

      // Two fan-outs, not one — the steward's carries `proposedRole: 'mod'`
      // so the client can say "asked you to help moderate".
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['invitee-1'],
        NotificationType.CommunityInviteReceived,
        expect.not.objectContaining({
          proposedRole: expect.anything() as unknown,
        }),
        'u1',
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['steward-1'],
        NotificationType.CommunityInviteReceived,
        expect.objectContaining({ proposedRole: RosterRole.Mod }),
        'u1',
      );
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
      const res = await service.create('u1', dto as CreateCommunityInput);

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
      await expect(
        service.create('u1', dto as CreateCommunityInput),
      ).rejects.toBeInstanceOf(ConflictException);
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

    // PRD-140. The invitation is the only thing that opens a private
    // community to somebody who is not on its roster, and what it opens is
    // the SAME detail a non-member of a `request`-tier community already
    // receives. Without this the invitee tapped their notification and was
    // bounced to `/communities` with no explanation.
    it('shows a private community to a non-member holding a pending invitation, and dates it', async () => {
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
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        communityId: 'c1',
        invitedUserId: 'u2',
        status: CommunityInviteStatus.Pending,
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
      });

      const detail = await service.getBySlug('p', 'u2');

      expect(detail.myRole).toBeNull();
      expect(detail.invitedAt).toBe('2026-02-02T00:00:00.000Z');
    });

    // PRD-143. The owner-facing archive copy promises the community "stays
    // visible as read-only", and the archive notification every member gets
    // deep-links straight here. Gating this on staff took every post and
    // resource a member wrote there away from them.
    it('shows an archived community to a plain member, flagged archived', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'p',
        accessTier: AccessTier.Public,
        archivedAt: new Date('2026-03-01T00:00:00.000Z'),
        ownerId: 'owner-1',
        name: 'Closed',
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

      expect(detail.archived).toBe(true);
      expect(detail.myRole).toBe(RosterRole.Member);
    });

    it('404s an archived community for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'p',
        accessTier: AccessTier.Public,
        archivedAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue(null);

      await expect(service.getBySlug('p', 'u2')).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
      qb.getManyAndCount!.mockResolvedValue([[row], 1]);
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
      expect(result.items[0]!.slug).toBe('a');
      expect(result.items[0]!.myRole).toBe(RosterRole.Member);
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

    it('defaults to newest-first (created_at DESC) when sort is omitted', async () => {
      const qb = qbStub();
      communities.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', {});

      expect(qb.orderBy).toHaveBeenCalledWith('c.createdAt', 'DESC');
      expect(qb.addOrderBy).not.toHaveBeenCalled();
    });

    it("sort='newest' orders by created_at DESC (same as the default)", async () => {
      const qb = qbStub();
      communities.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', { sort: 'newest' });

      expect(qb.orderBy).toHaveBeenCalledWith('c.createdAt', 'DESC');
      expect(qb.addOrderBy).not.toHaveBeenCalled();
    });

    it("sort='name' orders alphabetically with a stable id tiebreaker", async () => {
      const qb = qbStub();
      communities.createQueryBuilder.mockReturnValue(qb);

      await service.list('u1', { sort: 'name' });

      expect(qb.orderBy).toHaveBeenCalledWith('c.name', 'ASC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('c.id', 'ASC');
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

    // BE-COM-22: `PATCH /communities/:slug` was the only mutating community
    // route with no audit entry, so an access-tier change left nothing behind
    // for a member asking "who made this public?".
    it('writes a settings_changed governance entry carrying the before/after diff', async () => {
      communities.findOne.mockResolvedValue({
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
        archivedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });

      await service.update('x', 'u1', { name: 'New name', tagline: 't' });

      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'u1',
          action: GovernanceLogAction.SettingsChanged,
          // Only the field that actually moved — an echoed-back unchanged
          // `tagline` is diffed out rather than logged as a change.
          metadata: { changes: { name: { from: 'Old', to: 'New name' } } },
        }),
      );
    });

    it('logs nothing when the patch changes no field', async () => {
      communities.findOne.mockResolvedValue({
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
        archivedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });

      await service.update('x', 'u1', { name: 'Old' });

      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    // `accessTier`/`rosterVisible` are the community's privacy promise —
    // flipping `private` to `public` exposes the roster and every post at
    // once, the same class of act as archiving or transferring it. Owner-only,
    // even though a mod may edit everything else.
    it('forbids a mod from changing accessTier (owner-only)', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
        name: 'Old',
        purpose: 'p',
        type: CommunityType.Social,
        whoFor: 'w',
        tagline: 't',
        accessTier: AccessTier.Private,
        rosterVisible: true,
        features: [],
        rules: [],
        ref: 'QP-C-0001',
        archivedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });

      await expect(
        service.update('x', 'mod-1', { accessTier: AccessTier.Public }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(communities.save).not.toHaveBeenCalled();
    });

    it('lets a mod re-send an unchanged accessTier (no-op, not a privacy change)', async () => {
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
        archivedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });

      await expect(
        service.update('x', 'mod-1', {
          accessTier: AccessTier.Public,
          tagline: 'new tagline',
        }),
      ).resolves.toMatchObject({ tagline: 'new tagline' });
    });

    it('refuses to edit an archived community', async () => {
      communities.findOne.mockResolvedValue({
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
        archivedAt: new Date('2026-02-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });

      await expect(
        service.update('x', 'u1', { name: 'New name' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(communities.save).not.toHaveBeenCalled();
    });

    // M1 (storage-key impersonation): the community cover is a shared-upload
    // surface (any owner/moderator edits the same community), so the interceptor
    // exempts it and the service draws the line — a foreign cover key is allowed
    // only when it is already the stored value (a co-editor's no-op re-save);
    // pointing the field at a NEW foreign upload is refused.
    describe('foreign cover ownership (M1)', () => {
      const OTHER_ID = '22222222-2222-2222-2222-222222222222';
      const FILE_SEGMENT = '33333333-3333-3333-3333-333333333333';
      const FOREIGN_COVER = `community-covers/${OTHER_ID}/${FILE_SEGMENT}.jpg`;
      const baseCommunity = {
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
      };

      it('lets a moderator re-save the unchanged foreign cover already stored', async () => {
        communities.findOne.mockResolvedValue({
          ...baseCommunity,
          coverImageUrl: FOREIGN_COVER,
        });
        members.findOne.mockResolvedValue({ role: RosterRole.Mod });
        await expect(
          service.update('x', 'mod-1', { coverImageUrl: FOREIGN_COVER }),
        ).resolves.toBeDefined();
      });

      it('rejects introducing a new foreign cover key', async () => {
        communities.findOne.mockResolvedValue({
          ...baseCommunity,
          coverImageUrl: null,
        });
        members.findOne.mockResolvedValue({ role: RosterRole.Mod });
        await expect(
          service.update('x', 'mod-1', { coverImageUrl: FOREIGN_COVER }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  describe('join', () => {
    it('joins a public-tier community instantly via an idempotent (orIgnore) insert', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Public,
        // `rules` is NOT NULL with a `{}` default on the entity, so a real
        // row always carries an array here. The join/approve paths read it to
        // decide whether house rules must be agreed to at the door.
        rules: [],
        rulesVersion: 1,
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
        rules: [],
        rulesVersion: 1,
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

    // BE-COM-17: `join` used to check `frozenAt` and nothing else, so a caller
    // could confirm a private community exists purely from the status code
    // (201 here vs 404 on the detail), and staff of a private or archived
    // community received join-request notifications from people who should
    // never have known it was there. Everything `getBySlug` 404s, this route
    // 404s too.
    it('404s a private community for a non-member', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Private,
        archivedAt: null,
      });
      members.findOne.mockResolvedValue(null);

      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(joinRequests.save).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('404s an archived community', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Public,
        archivedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      members.findOne.mockResolvedValue(null);

      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(members.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('404s a community a moderator has taken down', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Public,
        archivedAt: null,
      });
      members.findOne.mockResolvedValue(null);
      contentModeration.stateFor.mockResolvedValue({
        hidden: false,
        removed: true,
      });

      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(members.createQueryBuilder).not.toHaveBeenCalled();
    });

    // PRD-140. A pending invitation admits its holder straight to the roster
    // and is spent doing it: without this a `private` community could never
    // gain a second member, because every other door into it 404s.
    it('admits a private-tier invitee at once and marks the invitation accepted', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Private,
        archivedAt: null,
        rules: [],
        rulesVersion: 1,
      });
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        communityId: 'c1',
        invitedUserId: 'u1',
        status: CommunityInviteStatus.Pending,
        createdAt: new Date('2026-02-02T00:00:00.000Z'),
      });
      const claimQb = inviteQbStub();
      invites.createQueryBuilder.mockReturnValue(claimQb);
      const insertQb = insertQbStub();
      members.createQueryBuilder.mockReturnValue(insertQb);

      const res = await service.join('x', 'u1', {});

      expect(res).toEqual({
        outcome: 'joined',
        role: RosterRole.Member,
        request: null,
      });
      // The flip is a GUARDED update: a revoke landing between the read and
      // this write must win, never be overwritten.
      expect(claimQb.where).toHaveBeenCalledWith(
        'id = :id AND status = :pending',
        { id: 'inv-1', pending: CommunityInviteStatus.Pending },
      );
      expect(insertQb.values).toHaveBeenCalledWith({
        communityId: 'c1',
        userId: 'u1',
        role: RosterRole.Member,
      });
      expect(joinRequests.save).not.toHaveBeenCalled();
    });

    // The invitation was revoked between the read and the write, so the claim
    // matches nothing. A private community must answer exactly as it answers
    // anybody uninvited rather than quietly honouring a withdrawn invitation.
    it('404s a private-tier caller whose invitation was revoked mid-join', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Private,
        archivedAt: null,
        rules: [],
        rulesVersion: 1,
      });
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        communityId: 'c1',
        invitedUserId: 'u1',
        status: CommunityInviteStatus.Pending,
      });
      const claimQb = inviteQbStub();
      claimQb.execute!.mockResolvedValue({ affected: 0, raw: [] });
      invites.createQueryBuilder.mockReturnValue(claimQb);
      const insertQb = insertQbStub();
      members.createQueryBuilder.mockReturnValue(insertQb);

      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(insertQb.execute).not.toHaveBeenCalled();
      expect(joinRequests.save).not.toHaveBeenCalled();
    });

    // PRD-141. The `invite` tier used to create an ordinary pending request
    // from anyone, so "only people you've invited can get in" gated nothing
    // and behaved exactly like `request`. The tier is publicly listed, so the
    // refusal names its reason instead of 404ing.
    it('refuses an uninvited caller on the invite tier with invite_required, writing no request', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Invite,
        archivedAt: null,
        rules: [],
        rulesVersion: 1,
      });
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue(null);

      const res = await service.join('x', 'u1', {});

      expect(res).toEqual({
        outcome: 'invite_required',
        role: null,
        request: null,
      });
      expect(joinRequests.save).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('admits an invite-tier invitee at once', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Invite,
        archivedAt: null,
        rules: [],
        rulesVersion: 1,
      });
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue({
        id: 'inv-2',
        communityId: 'c1',
        invitedUserId: 'u1',
        status: CommunityInviteStatus.Pending,
      });
      members.createQueryBuilder.mockReturnValue(insertQbStub());

      const res = await service.join('x', 'u1', {});

      expect(res.outcome).toBe('joined');
      expect(joinRequests.save).not.toHaveBeenCalled();
    });

    // An invitation opens a door. It is not a way past a ban, a takedown, a
    // freeze or the house rules, every one of which still binds an invitee.
    it('still refuses an invitee of a frozen community', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Invite,
        archivedAt: null,
        frozenAt: new Date('2026-02-01T00:00:00.000Z'),
        rules: [],
        rulesVersion: 1,
      });
      members.findOne.mockResolvedValue(null);
      invites.findOne.mockResolvedValue({
        id: 'inv-2',
        communityId: 'c1',
        invitedUserId: 'u1',
        status: CommunityInviteStatus.Pending,
      });

      await expect(service.join('x', 'u1', {})).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(invites.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-existing member: resolves joined, never throws', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        accessTier: AccessTier.Request,
        rules: [],
        rulesVersion: 1,
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
        rules: [],
        rulesVersion: 1,
      });

      // A plain member cannot triage.
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(
        service.triageJoinRequest('x', 'jr1', 'intruder', {
          action: 'approve',
        }),
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

      const res = await service.triageJoinRequest('x', 'jr1', 'mod-1', {
        action: 'approve',
      });

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
        service.triageJoinRequest('x', 'jr1', 'mod-1', { action: 'decline' }),
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
      qb.getMany!.mockResolvedValue([
        { slug: 'owner-slug', userId: 'owner-1' },
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne.mockResolvedValue({ id: 'm1', role: RosterRole.Owner });

      await expect(
        service.removeMember('x', 'owner-1', 'owner-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(members.delete).not.toHaveBeenCalled();
    });

    // Mirrors `setMemberRole`'s peer-mod rule: a mod cannot remove another
    // mod, only the owner can. Otherwise one moderator could quietly clear the
    // rest of the moderation team off the roster.
    it('forbids a mod from removing a peer mod (only the owner can)', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([{ slug: 'peer-slug', userId: 'peer-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne
        // target's roster row
        .mockResolvedValueOnce({
          id: 'm3',
          role: RosterRole.Mod,
          userId: 'peer-1',
        })
        // actor's own roster row, read by `assertOwnerOrMod`
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' });

      await expect(
        service.removeMember('x', 'mod-1', 'peer-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(members.delete).not.toHaveBeenCalled();
    });

    it('lets the owner remove a mod', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([{ slug: 'peer-slug', userId: 'peer-1' }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne
        .mockResolvedValueOnce({
          id: 'm3',
          role: RosterRole.Mod,
          userId: 'peer-1',
        })
        .mockResolvedValueOnce({ role: RosterRole.Owner, userId: 'owner-1' });

      await service.removeMember('x', 'owner-1', 'peer-slug');

      expect(members.delete).toHaveBeenCalledWith({ id: 'm3' });
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.MemberRemoved,
          targetUserId: 'peer-1',
        }),
      );
    });

    // PRD-28. The removal used to write the community's own governance log and
    // stop there, so the decision existed nowhere `POST /appeals` could see it
    // (it resolves an appeal's target out of `mod_audit_logs`). Both rows now.
    it('mirrors a staff removal that allows the return into mod_audit_logs', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([
        { slug: 'member-slug', userId: 'member-1' },
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne
        .mockResolvedValueOnce({
          id: 'm5',
          role: RosterRole.Member,
          userId: 'member-1',
        })
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' });

      await service.removeMember('x', 'mod-1', 'member-slug', {
        allowReturn: true,
        reason: 'Kept derailing the welcome thread',
      });

      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'mod-1',
          action: GovernanceLogAction.MemberRemoved,
          targetUserId: 'member-1',
        }),
      );
      expect(governanceLog.logModerationAudit).toHaveBeenCalledWith({
        actorUserId: 'mod-1',
        action: COMMUNITY_REMOVAL_AUDIT_ACTION,
        targetUserId: 'member-1',
        note: 'Kept derailing the welcome thread',
        // A removal serves no term: the member may come back at once.
        duration: null,
      });
    });

    // The guard that matters most. A member leaving takes the same code path,
    // and an audit row here would put "you appealed leaving your own
    // community" in front of them.
    it('writes the governance entry but no audit row for a self-leave', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([
        { slug: 'member-slug', userId: 'member-1' },
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne.mockResolvedValue({
        id: 'm5',
        role: RosterRole.Member,
        userId: 'member-1',
      });

      await service.removeMember('x', 'member-1', 'member-slug', {
        allowReturn: true,
      });

      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: GovernanceLogAction.MemberRemoved,
          targetUserId: 'member-1',
        }),
      );
      const loggedEntry = governanceLog.log.mock.calls[0]?.[0] as {
        metadata?: { removedBySelf?: boolean };
      };
      expect(loggedEntry.metadata?.removedBySelf).toBe(true);
      expect(governanceLog.logModerationAudit).not.toHaveBeenCalled();
      // Nor the "you were removed" notification, for the same reason.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    // The two are different acts and the appeals queue reads them apart by
    // action alone, so a bar must never arrive under the removal's code.
    it('records a bar under the ban action alone, never the removal action', async () => {
      communities.findOne.mockResolvedValue({
        id: 'c1',
        slug: 'x',
        name: 'Trans Joy',
        ownerId: 'owner-1',
      });
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([
        { slug: 'member-slug', userId: 'member-1' },
      ]);
      profiles.createQueryBuilder.mockReturnValue(qb);
      members.findOne
        .mockResolvedValueOnce({
          id: 'm5',
          role: RosterRole.Member,
          userId: 'member-1',
        })
        .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' });
      // The read-back `barReturn` does after the insert: the bar now on file.
      bans.findOne.mockResolvedValue({
        userId: 'member-1',
        reason: 'Harassment',
        expiresAt: null,
        ruleIndex: null,
        ruleVersion: null,
        ruleText: null,
      });

      await service.removeMember('x', 'mod-1', 'member-slug', {
        reason: 'Harassment',
      });

      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: GovernanceLogAction.MemberBanned,
          targetUserId: 'member-1',
        }),
      );
      expect(governanceLog.logModerationAudit).toHaveBeenCalledWith(
        expect.objectContaining({ action: COMMUNITY_BAN_AUDIT_ACTION }),
      );
      expect(governanceLog.logModerationAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: COMMUNITY_REMOVAL_AUDIT_ACTION }),
      );
    });

    // PRD-25. The finding: one moderator could bar a member from a community
    // forever with no second signature, while the platform-level equivalent has
    // needed one since TS-12.
    describe('permanent bar needs a second signature (PRD-25)', () => {
      // The `expiresAt` the insert chain was actually given.
      const insertedBanExpiresAt = (): Date | null => {
        const insertQb = bans.createQueryBuilder.mock.results[0]?.value as
          { values: jest.Mock } | undefined;
        const values = insertQb?.values.mock.calls[0]?.[0] as
          { expiresAt: Date | null } | undefined;
        return values?.expiresAt ?? null;
      };

      // Puts a staff removal of an ordinary member on the happy path, with the
      // ban read-back returning whatever `barReturn` just wrote.
      const arrangeStaffRemoval = () => {
        communities.findOne.mockResolvedValue({
          id: 'c1',
          slug: 'x',
          name: 'Trans Joy',
          ownerId: 'owner-1',
          rules: [],
          rulesVersion: 1,
        });
        const qb = qbStub();
        qb.getMany!.mockResolvedValue([
          { slug: 'member-slug', userId: 'member-1' },
        ]);
        profiles.createQueryBuilder.mockReturnValue(qb);
        members.findOne
          .mockResolvedValueOnce({
            id: 'm5',
            role: RosterRole.Member,
            userId: 'member-1',
          })
          .mockResolvedValueOnce({ role: RosterRole.Mod, userId: 'mod-1' });
        // The read-back: whatever the insert chain was handed is what comes
        // back, so the 30-day term the service computed is observable here.
        bans.findOne.mockImplementation(() =>
          Promise.resolve({
            id: 'ban-1',
            userId: 'member-1',
            reason: 'Harassment',
            expiresAt: insertedBanExpiresAt(),
            ruleIndex: null,
            ruleVersion: null,
            ruleText: null,
          }),
        );
      };

      const THIRTY_DAYS_MS =
        COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS * 24 * 60 * 60 * 1000;

      it('removes the member at once and leaves the bar pending at 30 days', async () => {
        arrangeStaffRemoval();

        const before = Date.now();
        const outcome = await service.removeMember(
          'x',
          'mod-1',
          'member-slug',
          {
            reason: 'Harassment',
          },
        );

        // The removal never waits on anybody.
        expect(members.delete).toHaveBeenCalledWith({ id: 'm5' });
        // Nor does the bar: it lands at the 30-day fallback, not as permanent.
        const writtenExpiry = insertedBanExpiresAt();
        expect(writtenExpiry).not.toBeNull();
        expect(writtenExpiry!.getTime()).toBeGreaterThanOrEqual(
          before + THIRTY_DAYS_MS - 5000,
        );
        // And a second signature is now being waited on.
        expect(banRatifications.proposePermanentBar).toHaveBeenCalledWith(
          expect.objectContaining({
            proposerUserId: 'mod-1',
            reason: 'Harassment',
          }),
        );
        expect(outcome.isRemoved).toBe(true);
        expect(outcome.hasBarredReturn).toBe(true);
        expect(outcome.isPendingRatification).toBe(true);
        expect(outcome.ratificationId).toBe('hold-1');
        expect(outcome.hasNoSecondSignatory).toBe(false);
      });

      // The case the finding is most worried about, and the one with no
      // exemption: a solo owner cannot bar anybody permanently alone.
      it('falls back to 30 days with no hold when nobody else could sign', async () => {
        arrangeStaffRemoval();
        banRatifications.proposePermanentBar.mockResolvedValue(null);

        const outcome = await service.removeMember(
          'x',
          'mod-1',
          'member-slug',
          {
            reason: 'Harassment',
          },
        );

        expect(insertedBanExpiresAt()).not.toBeNull();
        expect(outcome.hasBarredReturn).toBe(true);
        expect(outcome.isPendingRatification).toBe(false);
        expect(outcome.ratificationId).toBeNull();
        expect(outcome.hasNoSecondSignatory).toBe(true);
        // Said in words, because a caller told nothing believes they got the
        // permanent bar they asked for.
        expect(outcome.message).toContain('30 days');
      });

      // A bounded bar was never one person's forever, so it needs nobody.
      it('leaves a banDays-bounded bar alone and asks for no signature', async () => {
        arrangeStaffRemoval();

        const before = Date.now();
        const outcome = await service.removeMember(
          'x',
          'mod-1',
          'member-slug',
          {
            reason: 'Harassment',
            banDays: 7,
          },
        );

        const writtenExpiry = insertedBanExpiresAt();
        expect(writtenExpiry).not.toBeNull();
        // Seven days, not the thirty a permanent request would have settled at.
        expect(writtenExpiry!.getTime()).toBeLessThan(
          before + THIRTY_DAYS_MS - 5000,
        );
        expect(banRatifications.proposePermanentBar).not.toHaveBeenCalled();
        expect(outcome.isPendingRatification).toBe(false);
        expect(outcome.hasNoSecondSignatory).toBe(false);
      });

      // The guard that matters most, restated against the new code path: a
      // member leaving writes no bar, so there is nothing to countersign.
      it('bars nothing and proposes nothing on a self-leave', async () => {
        communities.findOne.mockResolvedValue({
          id: 'c1',
          slug: 'x',
          ownerId: 'owner-1',
          rules: [],
          rulesVersion: 1,
        });
        const qb = qbStub();
        qb.getMany!.mockResolvedValue([
          { slug: 'member-slug', userId: 'member-1' },
        ]);
        profiles.createQueryBuilder.mockReturnValue(qb);
        members.findOne.mockResolvedValue({
          id: 'm5',
          role: RosterRole.Member,
          userId: 'member-1',
        });

        const outcome = await service.removeMember(
          'x',
          'member-1',
          'member-slug',
        );

        expect(bans.createQueryBuilder).not.toHaveBeenCalled();
        expect(banRatifications.proposePermanentBar).not.toHaveBeenCalled();
        expect(outcome.hasBarredReturn).toBe(false);
        expect(outcome.isPendingRatification).toBe(false);
        expect(governanceLog.logModerationAudit).not.toHaveBeenCalled();
      });
    });
  });

  describe('myCommunities', () => {
    it('returns a bare, unpaginated array of the caller`s roster rows', async () => {
      const qb = qbStub();
      // `cardProgramId` is a selected alias on the left join, so every raw row
      // carries the key: the id when the community runs a card program, null
      // when it does not. It is what `hasCardProgram` is derived from.
      qb.getRawMany!.mockResolvedValue([
        {
          slug: 'trans-joy',
          name: 'Trans Joy',
          role: RosterRole.Mod,
          joinedAt: new Date('2026-02-02T00:00:00.000Z'),
          cardProgramId: 'cp-1',
        },
        {
          slug: 'book-club',
          name: 'Book Club',
          role: RosterRole.Member,
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          cardProgramId: null,
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
          // The raw id is never handed out; only whether there is one.
          hasCardProgram: true,
        },
        {
          slug: 'book-club',
          name: 'Book Club',
          role: RosterRole.Member,
          joinedAt: '2026-01-01T00:00:00.000Z',
          hasCardProgram: false,
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
      qb.getMany!.mockResolvedValue([{ slug, userId }]);
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

  describe('archive', () => {
    const community = {
      id: 'c1',
      slug: 'x',
      ownerId: 'owner-1',
      archivedAt: null as Date | null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    beforeEach(() => {
      communities.findOne.mockResolvedValue({ ...community });
    });

    // `assertOwner` gates purely on `Community.ownerId` — no roster lookup —
    // so a mod is rejected exactly like any other non-owner, per the
    // docstring's "OWNER-ONLY, deliberately stricter than the owner/mod gate".
    it('rejects a mod (owner-only, stricter than update/roster routes)', async () => {
      await expect(service.archive('x', 'mod-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(communities.save).not.toHaveBeenCalled();
    });

    it('rejects a non-member stranger', async () => {
      await expect(service.archive('x', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('archives for the owner: sets archivedAt, logs governance, notifies the whole roster', async () => {
      members.find.mockResolvedValue([
        { userId: 'owner-1' },
        { userId: 'member-1' },
      ]);

      const detail = await service.archive('x', 'owner-1');

      expect(detail.myRole).toBe(RosterRole.Owner);
      expect(communities.save).toHaveBeenCalledWith(
        expect.objectContaining({ archivedAt: expect.any(Date) as unknown }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.Archived,
        }),
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['owner-1', 'member-1'],
        NotificationType.CommunityArchived,
        expect.objectContaining({ actorId: 'owner-1', communitySlug: 'x' }),
        'owner-1',
      );
    });

    it('is idempotent: archiving an already-archived community is a no-op', async () => {
      communities.findOne.mockResolvedValue({
        ...community,
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const detail = await service.archive('x', 'owner-1');

      expect(detail.myRole).toBe(RosterRole.Owner);
      expect(communities.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });
  });

  // PRD-143. Archiving closes a room and leaves everything written in it
  // standing. `getBySlug` now serves it to everybody on the roster, which is
  // only safe because every write into it is refused — for its staff as much
  // as for its members.
  describe('an archived community is read-only', () => {
    const archived = {
      id: 'c1',
      slug: 'x',
      ownerId: 'owner-1',
      accessTier: AccessTier.Public,
      archivedAt: new Date('2026-03-01T00:00:00.000Z'),
      rules: [],
      rulesVersion: 1,
    };

    it('refuses a role change', async () => {
      communities.findOne.mockResolvedValue(archived);
      members.findOne.mockResolvedValue({ id: 'm1', role: RosterRole.Owner });

      await expect(
        service.setMemberRole('x', 'owner-1', 'jo', RosterRole.Mod),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(members.save).not.toHaveBeenCalled();
    });

    it('refuses to triage a join request left in the queue', async () => {
      communities.findOne.mockResolvedValue(archived);
      members.findOne.mockResolvedValue({ id: 'm1', role: RosterRole.Owner });

      await expect(
        service.triageJoinRequest('x', 'jr-1', 'owner-1', {
          action: 'approve',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(joinRequests.findOne).not.toHaveBeenCalled();
    });

    it('refuses a tag request', async () => {
      communities.findOne.mockResolvedValue(archived);
      members.findOne.mockResolvedValue({ id: 'm1', role: RosterRole.Owner });

      await expect(
        service.createTagRequest('x', 'owner-1', { label: 'book club' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tagRequests.save).not.toHaveBeenCalled();
    });

    it('refuses a staff removal', async () => {
      communities.findOne.mockResolvedValue(archived);
      const profilesQb = qbStub();
      profilesQb.getMany!.mockResolvedValue([{ slug: 'jo', userId: 'u1' }]);
      profiles.createQueryBuilder.mockReturnValue(profilesQb);
      members.findOne.mockResolvedValue({
        id: 'm1',
        role: RosterRole.Member,
        userId: 'u1',
      });

      await expect(
        service.removeMember('x', 'owner-1', 'jo'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(members.delete).not.toHaveBeenCalled();
    });

    // The one write that stays open, deliberately: walking out is always the
    // member's own to do, and a community they can no longer leave would be a
    // room that closed with them still listed in it.
    it('still lets a member leave', async () => {
      communities.findOne.mockResolvedValue(archived);
      const profilesQb = qbStub();
      profilesQb.getMany!.mockResolvedValue([{ slug: 'jo', userId: 'u1' }]);
      profiles.createQueryBuilder.mockReturnValue(profilesQb);
      members.findOne.mockResolvedValue({
        id: 'm1',
        role: RosterRole.Member,
        userId: 'u1',
      });

      await service.removeMember('x', 'u1', 'jo');

      expect(members.delete).toHaveBeenCalledWith({ id: 'm1' });
    });

    // The same exception, for the same reason: an applicant queued outside a
    // room that has since closed is exactly the person this endpoint exists
    // for, and taking back your own request writes nothing the archive is
    // protecting (PRD-148).
    it('still lets an applicant take back their own join request', async () => {
      communities.findOne.mockResolvedValue(archived);

      await service.withdrawMyJoinRequest('x', 'applicant-1');

      expect(joinRequests.delete).toHaveBeenCalledWith({
        communityId: 'c1',
        userId: 'applicant-1',
        status: JoinRequestStatus.Pending,
      });
    });
  });

  describe('unfreeze', () => {
    const community = {
      id: 'c1',
      slug: 'x',
      ownerId: 'owner-1',
      frozenAt: new Date('2026-01-01T00:00:00.000Z') as Date | null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    beforeEach(() => {
      communities.findOne.mockResolvedValue({ ...community });
    });

    it('rejects a plain member', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Member });
      await expect(service.unfreeze('x', 'member-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(communities.save).not.toHaveBeenCalled();
    });

    it('rejects a non-member stranger', async () => {
      members.findOne.mockResolvedValue(null);
      await expect(service.unfreeze('x', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('lets a mod (not just the owner) unfreeze: clears frozenAt, logs governance, notifies staff', async () => {
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      members.find.mockResolvedValue([{ userId: 'mod-1' }]);

      const detail = await service.unfreeze('x', 'mod-1');

      expect(detail.myRole).toBe(RosterRole.Mod);
      expect(communities.save).toHaveBeenCalledWith(
        expect.objectContaining({ frozenAt: null }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'mod-1',
          action: GovernanceLogAction.Unfrozen,
        }),
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        expect.arrayContaining(['owner-1', 'mod-1']),
        NotificationType.CommunityUnfrozen,
        expect.objectContaining({ actorId: 'mod-1', communitySlug: 'x' }),
        'mod-1',
      );
    });

    it('is idempotent: unfreezing a community that is not frozen is a no-op', async () => {
      communities.findOne.mockResolvedValue({ ...community, frozenAt: null });
      members.findOne.mockResolvedValue({ role: RosterRole.Owner });

      const detail = await service.unfreeze('x', 'owner-1');

      expect(detail.myRole).toBe(RosterRole.Owner);
      expect(communities.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });
  });

  describe('transferOwnership', () => {
    const community = {
      id: 'c1',
      slug: 'x',
      ownerId: 'owner-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    const resolveSlug = (slug: string, userId: string) => {
      const qb = qbStub();
      qb.getMany!.mockResolvedValue([{ slug, userId }]);
      profiles.createQueryBuilder.mockReturnValue(qb);
    };

    beforeEach(() => {
      communities.findOne.mockResolvedValue({ ...community });
    });

    it('rejects a mod attempting a transfer (owner-only)', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne.mockResolvedValue({ role: RosterRole.Mod });
      await expect(
        service.transferOwnership('x', 'mod-1', 'target-slug'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(communities.save).not.toHaveBeenCalled();
    });

    it('rejects self-transfer', async () => {
      resolveSlug('owner-slug', 'owner-1');
      await expect(
        service.transferOwnership('x', 'owner-1', 'owner-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s an unknown target member slug', async () => {
      const emptyQb = qbStub();
      profiles.createQueryBuilder.mockReturnValue(emptyQb);
      await expect(
        service.transferOwnership('x', 'owner-1', 'ghost'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a transfer to the house account', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne.mockResolvedValue({
        id: 'm2',
        role: RosterRole.Member,
        userId: 'target-1',
      });
      users.findOne.mockResolvedValue({ id: 'target-1', isSystem: true });
      await expect(
        service.transferOwnership('x', 'owner-1', 'target-slug'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(communities.save).not.toHaveBeenCalled();
    });

    it('hands ownership to the target, demotes the outgoing owner to mod, logs governance, notifies both parties', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne
        // target's roster row (2nd lookup, after the self-transfer check)
        .mockResolvedValueOnce({
          id: 'm2',
          role: RosterRole.Member,
          userId: 'target-1',
        })
        // outgoing owner's roster row, re-read inside the transaction
        .mockResolvedValueOnce({
          id: 'm1',
          role: RosterRole.Owner,
          userId: 'owner-1',
        });
      users.findOne.mockResolvedValue({ id: 'target-1', isSystem: false });

      const detail = await service.transferOwnership(
        'x',
        'owner-1',
        'target-slug',
      );

      // The actor is now a moderator of the community they handed off.
      expect(detail.myRole).toBe(RosterRole.Mod);
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm2', role: RosterRole.Owner }),
      );
      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1', role: RosterRole.Mod }),
      );
      expect(communities.save).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'target-1' }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.OwnershipTransferred,
          targetUserId: 'target-1',
        }),
      );
      // One notification to the new owner, one to the demoted former owner.
      expect(notifications.create).toHaveBeenCalledWith(
        'target-1',
        NotificationType.CommunityOwnershipTransferred,
        expect.objectContaining({ youAreNowOwner: true }),
        'owner-1',
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.CommunityOwnershipTransferred,
        expect.objectContaining({ youAreNowOwner: false }),
        'owner-1',
      );
    });

    it('does not demote the outgoing owner a second time if their roster row already moved (retry-safe)', async () => {
      resolveSlug('target-slug', 'target-1');
      members.findOne
        .mockResolvedValueOnce({
          id: 'm2',
          role: RosterRole.Member,
          userId: 'target-1',
        })
        // The outgoing owner's row is no longer 'owner' (already demoted by a
        // prior attempt) — the guarded demote inside the transaction must
        // not re-save it.
        .mockResolvedValueOnce({
          id: 'm1',
          role: RosterRole.Mod,
          userId: 'owner-1',
        });
      users.findOne.mockResolvedValue({ id: 'target-1', isSystem: false });

      await service.transferOwnership('x', 'owner-1', 'target-slug');

      expect(members.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm2', role: RosterRole.Owner }),
      );
      expect(members.save).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'm1' }),
      );
    });
  });

  describe('createTagRequest', () => {
    const community = { id: 'c1', slug: 'x' };

    it('tells the community-tag-request queue that a suggestion landed', async () => {
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue({
        role: RosterRole.Mod,
        userId: 'mod-1',
      });
      // `status` and `createdAt` are column defaults, so a real saved row
      // carries both; the response mapper reads them straight back out.
      tagRequests.save.mockResolvedValue({
        id: 'tag-request-1',
        communityId: 'c1',
        requestedByUserId: 'mod-1',
        label: 'polyamory',
        note: null,
        status: CommunityTagRequestStatus.Pending,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      await service.createTagRequest('x', 'mod-1', {
        label: 'polyamory',
        note: undefined,
      });

      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.CommunityTagRequests,
        'tag-request-1',
      );
    });

    it('tells nobody when the requester is not an owner or mod', async () => {
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue(null);

      await expect(
        service.createTagRequest('x', 'outsider-1', {
          label: 'polyamory',
          note: undefined,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(tagRequests.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });

  // PRD-150. The owner who filed a suggestion could see nothing at all
  // afterwards; this is the read that closes that loop. Reading it still
  // changes no vocabulary: `COMMUNITY_TAGS` stays a hardcoded array.
  describe('listTagRequests', () => {
    const community = {
      id: 'c1',
      slug: 'x',
      archivedAt: null,
      accessTier: AccessTier.Request,
    };
    const requestRow = {
      id: 'tag-request-1',
      communityId: 'c1',
      requestedByUserId: 'mod-1',
      label: 'polyamory',
      note: 'three of us asked for it',
      status: CommunityTagRequestStatus.Resolved,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      resolvedAt: new Date('2026-08-04T00:00:00.000Z'),
      resolvedByUserId: 'admin-1',
    };

    it('returns the log for this community only, newest first and capped', async () => {
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue({
        role: RosterRole.CoOwner,
        userId: 'co-owner-1',
      });
      tagRequests.find.mockResolvedValue([requestRow]);
      profiles.find.mockResolvedValue([
        {
          userId: 'mod-1',
          slug: 'ines',
          firstName: 'Ines',
          lastName: 'Rocha',
          pronouns: 'ela/dela',
          avatarUrl: null,
          photoVisible: true,
        },
      ]);

      const result = await service.listTagRequests('x', 'co-owner-1');

      expect(tagRequests.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { communityId: 'c1' },
          order: { createdAt: 'DESC', id: 'DESC' },
          take: DEFAULT_LIST_LIMIT,
        }),
      );
      expect(result.items).toEqual([
        {
          id: 'tag-request-1',
          label: 'polyamory',
          note: 'three of us asked for it',
          status: CommunityTagRequestStatus.Resolved,
          createdAt: '2026-08-01T00:00:00.000Z',
          resolvedAt: '2026-08-04T00:00:00.000Z',
          requestedBy: {
            slug: 'ines',
            firstName: 'Ines',
            lastName: 'Rocha',
            pronouns: 'ela/dela',
            avatarUrl: null,
          },
        },
      ]);
    });

    it('resolves every requester in ONE lookup, never one per row', async () => {
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue({
        role: RosterRole.Mod,
        userId: 'mod-1',
      });
      tagRequests.find.mockResolvedValue([
        requestRow,
        { ...requestRow, id: 'tag-request-2', requestedByUserId: 'mod-2' },
        { ...requestRow, id: 'tag-request-3', requestedByUserId: 'mod-1' },
      ]);

      await service.listTagRequests('x', 'mod-1');

      expect(profiles.find).toHaveBeenCalledTimes(1);
    });

    it('refuses a plain member', async () => {
      communities.findOne.mockResolvedValue(community);
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        userId: 'member-1',
      });

      await expect(
        service.listTagRequests('x', 'member-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tagRequests.find).not.toHaveBeenCalled();
    });
  });

  // PRD-148. A request filed by mistake used to be unleavable: the hero showed
  // a disabled "Requested" button, and the only way out was a decline that
  // would have written a 30 or 180 day reapply lock.
  describe('withdrawMyJoinRequest', () => {
    const community = {
      id: 'c1',
      slug: 'x',
      accessTier: AccessTier.Request,
      archivedAt: null,
    };

    it('deletes only the pending row belonging to the caller, and tells nobody', async () => {
      communities.findOne.mockResolvedValue(community);

      await service.withdrawMyJoinRequest('x', 'applicant-1');

      expect(joinRequests.delete).toHaveBeenCalledWith({
        communityId: 'c1',
        userId: 'applicant-1',
        status: JoinRequestStatus.Pending,
      });
      // Silent by design: nobody acted on the request, so there is nothing to
      // retract and no reason to tell the room she changed her mind.
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });

    // The point of deleting rather than adding a fourth status: a withdrawal
    // writes no `reapplyAfter`, so the member may apply again at once.
    it('leaves no reapply lock behind', async () => {
      communities.findOne.mockResolvedValue(community);

      await service.withdrawMyJoinRequest('x', 'applicant-1');

      expect(joinRequests.save).not.toHaveBeenCalled();
      expect(joinRequests.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('answers a second tap with 204 rather than an error', async () => {
      communities.findOne.mockResolvedValue(community);
      joinRequests.delete.mockResolvedValue({ affected: 0 });
      members.findOne.mockResolvedValue(null);
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.withdrawMyJoinRequest('x', 'applicant-1'),
      ).resolves.toBeUndefined();
    });

    it('says so when the request was approved first', async () => {
      communities.findOne.mockResolvedValue(community);
      joinRequests.delete.mockResolvedValue({ affected: 0 });
      members.findOne.mockResolvedValue({
        role: RosterRole.Member,
        userId: 'applicant-1',
      });
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.withdrawMyJoinRequest('x', 'applicant-1'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('says so when a decline landed first, and carries the reapply date', async () => {
      communities.findOne.mockResolvedValue(community);
      joinRequests.delete.mockResolvedValue({ affected: 0 });
      members.findOne.mockResolvedValue(null);
      joinRequests.findOne.mockResolvedValue({
        id: 'jr-1',
        status: JoinRequestStatus.Declined,
        reapplyAfter: new Date('2026-10-01T00:00:00.000Z'),
      });

      await expect(
        service.withdrawMyJoinRequest('x', 'applicant-1'),
      ).rejects.toMatchObject({
        response: {
          code: 'JOIN_REQUEST_ALREADY_ANSWERED',
          reapplyAfter: '2026-10-01T00:00:00.000Z',
        },
      });
    });

    // The existence posture `getBySlug` draws: a private community is never
    // confirmed to somebody with no standing in it.
    it('404s a private community for a caller with no request and no roster row', async () => {
      communities.findOne.mockResolvedValue({
        ...community,
        accessTier: AccessTier.Private,
      });
      members.findOne.mockResolvedValue(null);
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.withdrawMyJoinRequest('x', 'stranger-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(joinRequests.delete).not.toHaveBeenCalled();
    });
  });
});

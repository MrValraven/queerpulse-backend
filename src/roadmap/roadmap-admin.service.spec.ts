import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';
import { RoadmapIdea, RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import { RoadmapItemComment } from './entities/roadmap-item-comment.entity';
import { RoadmapItemDependency } from './entities/roadmap-item-dependency.entity';
import {
  RoadmapColumn,
  RoadmapConfidence,
  RoadmapCost,
  RoadmapItem,
  RoadmapPaidKind,
  RoadmapPriority,
} from './entities/roadmap-item.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';
import { RoadmapTeamMember } from './entities/roadmap-team-member.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { RoadmapAdminService } from './roadmap-admin.service';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default (mirrors `companies.service.spec.ts`'s `qbStub`).
const qbStub = () => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'innerJoin',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  qb.getRawOne = jest.fn().mockResolvedValue({ max: null });
  return qb;
};

const BASE_ITEM: RoadmapItem = {
  id: 'item-1',
  column: RoadmapColumn.Planned,
  category: 'Safety',
  name: 'Trans health directory',
  description: 'internal notes',
  publicNote: 'A warm one-liner',
  date: null,
  stage: null,
  eta: null,
  targetQuarter: 'Q3 2026',
  progress: null,
  priority: RoadmapPriority.P1,
  confidence: RoadmapConfidence.Likely,
  committed: false,
  isPublic: true,
  requested: true,
  notified: false,
  spikeFlag: false,
  safetyStatus: 0,
  blockedBy: null,
  blockedWhy: null,
  paidKind: RoadmapPaidKind.Volunteer,
  weeklyHours: 0,
  cost: RoadmapCost.None,
  ownerId: null,
  slips: [],
  guide: null,
  votes: 0,
  hot: false,
  archived: false,
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

// `CreateRoadmapItemDto`-shaped fixture — unlike `BASE_ITEM` (a full
// `RoadmapItem` entity, which carries fields like `id`/`createdAt` the create
// DTO doesn't have and can't structurally satisfy it), this is what
// `createItem` actually accepts.
const BASE_CREATE_DTO = {
  column: RoadmapColumn.Planned,
  category: 'Safety',
  name: 'Trans health directory',
  description: 'internal notes',
};

const BASE_IDEA: RoadmapIdea = {
  id: 'idea-1',
  text: 'Add a trans-health directory',
  status: RoadmapIdeaStatus.Pending,
  category: 'Safety',
  note: null,
  duplicateOfItemId: null,
  declineReason: null,
  declineNote: null,
  votes: 4,
  submittedById: 'member-1',
  sortOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('RoadmapAdminService', () => {
  let service: RoadmapAdminService;
  let items: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    exists: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock; getRepository: jest.Mock };
  };
  let votes: {
    find: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let auditLog: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let comments: { find: jest.Mock };
  let deps: { find: jest.Mock };
  let team: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let ideas: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let settings: { findOne: jest.Mock };
  let notifications: { createForRecipients: jest.Mock; create: jest.Mock };
  // Exposed at describe scope (not just inside `beforeEach`) so tests that
  // exercise a transactional mutator (`promoteIdea`/`mergeIdea`) can assert
  // directly on `manager.delete` — the same object `items.manager.transaction`
  // hands to the mutator's callback.
  let manager: {
    getRepository: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
    increment: jest.Mock;
    update: jest.Mock;
  };

  const ACTOR = { actorId: 'admin-1', actorLabel: 'Ash (admin)' };

  beforeEach(async () => {
    auditLog = {
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      find: jest.fn().mockResolvedValue([]),
    };
    comments = { find: jest.fn().mockResolvedValue([]) };
    deps = { find: jest.fn().mockResolvedValue([]) };
    team = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    communityMembers = { createQueryBuilder: jest.fn(() => qbStub()) };
    ideas = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
    };
    settings = { findOne: jest.fn().mockResolvedValue(null) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    };
    votes = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
    };

    // `manager.getRepository(Entity)` routes to the same mocks the outer
    // `@InjectRepository` tokens use — every transactional method (delete,
    // updateDeps, duplicate, bulk) runs its work through this, and
    // `RoadmapAdminService.audit`'s default manager (`this.items.manager`)
    // routes non-transactional mutators' audit rows through it too. Mirrors
    // `companies.service.spec.ts`. `manager.delete(Entity, criteria)` — used
    // directly (not via `getRepository`) by `promoteIdea`/`mergeIdea`/
    // `deleteItem`/`deleteIdea`'s polymorphic-vote cleanup — is a separate
    // top-level mock, not routed through `getRepository`. Likewise
    // `manager.findOne`/`increment`/`update` (used directly by `mergeIdea`,
    // Fix-round 1 — the whole read-modify-write moved onto the transactional
    // `manager` instead of pre-transaction repo reads): `findOne` routes by
    // entity to the SAME `items`/`ideas` mocks the plain repositories use, so
    // a test configuring `items.findOne`/`ideas.findOne` controls both the
    // non-transactional AND the transactional lookups with one setup.
    manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === RoadmapItem) return items;
        if (entity === RoadmapItemDependency) return deps;
        if (entity === RoadmapAuditLog) return auditLog;
        if (entity === RoadmapVote) return votes;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn((entity: unknown, options: unknown): unknown => {
        if (entity === RoadmapItem) return items.findOne(options) as unknown;
        if (entity === RoadmapIdea) return ideas.findOne(options) as unknown;
        throw new Error(
          `unexpected entity in manager.findOne: ${String(entity)}`,
        );
      }),
      increment: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    items = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((v: object) => v),
      save: jest.fn((v: unknown) => Promise.resolve(v)),
      exists: jest.fn().mockResolvedValue(true),
      // Only reached via `manager.getRepository(RoadmapItem)` inside
      // `bulkItems`'s transaction (which routes to this SAME mock — see
      // `manager.getRepository` below), never called directly on `items`.
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qbStub()),
      manager: {
        transaction: jest.fn(
          async (cb: (m: typeof manager) => Promise<unknown>) => cb(manager),
        ),
        getRepository: manager.getRepository,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoadmapAdminService,
        { provide: getRepositoryToken(RoadmapItem), useValue: items },
        { provide: getRepositoryToken(RoadmapIdea), useValue: ideas },
        { provide: getRepositoryToken(RoadmapVote), useValue: votes },
        { provide: getRepositoryToken(RoadmapSettings), useValue: settings },
        { provide: getRepositoryToken(RoadmapTeamMember), useValue: team },
        { provide: getRepositoryToken(RoadmapItemComment), useValue: comments },
        {
          provide: getRepositoryToken(RoadmapItemDependency),
          useValue: deps,
        },
        { provide: getRepositoryToken(RoadmapAuditLog), useValue: auditLog },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(RoadmapAdminService);
  });

  describe('updateItem — slip guard', () => {
    it('400s a targetQuarter change on a non-shipped item with no slipReason', async () => {
      items.findOne.mockResolvedValue({ ...BASE_ITEM });

      await expect(
        service.updateItem('item-1', { targetQuarter: 'Q4 2026' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(items.save).not.toHaveBeenCalled();
    });

    it('appends a slip entry and saves when slipReason is given', async () => {
      items.findOne.mockResolvedValue({ ...BASE_ITEM });

      const result = await service.updateItem(
        'item-1',
        { targetQuarter: 'Q4 2026', slipReason: 'Waiting on legal review' },
        ACTOR,
      );

      expect(result.slips).toEqual([
        expect.objectContaining({
          from: 'Q3 2026',
          to: 'Q4 2026',
          reason: 'Waiting on legal review',
          movedByName: ACTOR.actorLabel,
        }),
      ]);
      expect(items.save).toHaveBeenCalledWith(
        expect.objectContaining({ targetQuarter: 'Q4 2026' }),
      );
    });

    it('does not require slipReason when the item has already shipped', async () => {
      items.findOne.mockResolvedValue({
        ...BASE_ITEM,
        column: RoadmapColumn.Shipped,
      });

      const result = await service.updateItem(
        'item-1',
        { targetQuarter: 'Q4 2026' },
        ACTOR,
      );

      expect(result.slips).toEqual([]);
      expect(items.save).toHaveBeenCalled();
    });
  });

  describe('updateItem — safety guard', () => {
    it('400s making a safety-gated item public', async () => {
      items.findOne.mockResolvedValue({
        ...BASE_ITEM,
        isPublic: false,
        safetyStatus: 1,
      });

      await expect(
        service.updateItem('item-1', { isPublic: true }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(items.save).not.toHaveBeenCalled();
    });

    it('allows publishing once the safety review has cleared', async () => {
      items.findOne.mockResolvedValue({
        ...BASE_ITEM,
        isPublic: false,
        safetyStatus: 2,
      });

      const result = await service.updateItem(
        'item-1',
        { isPublic: true },
        ACTOR,
      );

      expect(result.isPublic).toBe(true);
    });
  });

  describe('updateItem — shipped progress invariant', () => {
    it('forces progress to 100 when the card lands in the shipped column', async () => {
      items.findOne.mockResolvedValue({ ...BASE_ITEM, progress: null });

      const result = await service.updateItem(
        'item-1',
        { column: RoadmapColumn.Shipped },
        ACTOR,
      );

      expect(result.progress).toBe(100);
      expect(items.save).toHaveBeenCalledWith(
        expect.objectContaining({ progress: 100 }),
      );
    });
  });

  describe('createItem — safety guard', () => {
    it('400s creating an item that is public while safety-gated', async () => {
      await expect(
        service.createItem(
          { ...BASE_CREATE_DTO, isPublic: true, safetyStatus: 1 },
          ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(items.save).not.toHaveBeenCalled();
    });

    it('allows creating a private safety-gated item', async () => {
      items.save.mockResolvedValue({
        ...BASE_ITEM,
        isPublic: false,
        safetyStatus: 1,
      });

      await service.createItem(
        { ...BASE_CREATE_DTO, isPublic: false, safetyStatus: 1 },
        ACTOR,
      );

      expect(items.save).toHaveBeenCalled();
    });
  });

  describe('bulkItems', () => {
    it('moves a selection to a new column and writes one audit row', async () => {
      items.find.mockResolvedValue([
        { ...BASE_ITEM, id: 'item-1' },
        { ...BASE_ITEM, id: 'item-2' },
      ]);

      const result = await service.bulkItems(
        {
          ids: ['item-1', 'item-2'],
          action: 'move',
          column: RoadmapColumn.Building,
        },
        ACTOR,
      );

      expect(result).toEqual({ count: 2 });
      expect(items.update).toHaveBeenCalledWith(
        { id: expect.anything() as unknown },
        { column: RoadmapColumn.Building },
      );
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: ACTOR.actorId,
          action: expect.stringContaining('Bulk move on 2 item(s)') as string,
        }),
      );
    });

    it('400s a "move" action with no target column', async () => {
      await expect(
        service.bulkItems({ ids: ['item-1'], action: 'move' }, ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('forces progress to 100 when bulk-moving into shipped', async () => {
      items.find.mockResolvedValue([{ ...BASE_ITEM, id: 'item-1' }]);

      await service.bulkItems(
        { ids: ['item-1'], action: 'move', column: RoadmapColumn.Shipped },
        ACTOR,
      );

      expect(items.update).toHaveBeenCalledWith(
        { id: expect.anything() as unknown },
        { column: RoadmapColumn.Shipped, progress: 100 },
      );
    });

    it('"show" narrows the count/audit to items whose safety review has cleared', async () => {
      items.find.mockResolvedValue([
        { ...BASE_ITEM, id: 'item-1', safetyStatus: 0 },
        { ...BASE_ITEM, id: 'item-2', safetyStatus: 1 },
      ]);

      const result = await service.bulkItems(
        { ids: ['item-1', 'item-2'], action: 'show' },
        ACTOR,
      );

      expect(result).toEqual({ count: 1 });
      expect(items.update).toHaveBeenCalledWith(
        { id: expect.anything() as unknown },
        { isPublic: true },
      );
      // Only the one non-gated item was actually written — confirm the
      // update call's id filter didn't include the gated item by checking
      // the `In(...)` operator's captured value directly.
      const [idFilter] = items.update.mock.calls[0] as [
        { id: { value: string[] } },
        unknown,
      ];
      expect(idFilter.id.value).toEqual(['item-1']);
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('Bulk show on 1 item(s)') as string,
        }),
      );
    });
  });

  describe('promoteIdea', () => {
    it('creates a new planned item from the idea and removes the idea', async () => {
      // Locked-and-reloaded via the transactional `manager` (routes to this
      // same `ideas.findOne` mock — see the `manager.findOne` setup above).
      ideas.findOne.mockResolvedValue({ ...BASE_IDEA, submittedById: null });

      const result = await service.promoteIdea('idea-1', ACTOR);

      expect(result.column).toBe(RoadmapColumn.Planned);
      expect(result.name).toBe(BASE_IDEA.text);
      expect(result.category).toBe(BASE_IDEA.category);
      expect(result.votes).toBe(BASE_IDEA.votes);
      expect(result.requested).toBe(true);
      expect(items.save).toHaveBeenCalled();
      // The idea and its votes are removed in the same transaction as the
      // item is created — no orphaned `roadmap_votes` row left behind.
      expect(manager.delete).toHaveBeenCalledWith(RoadmapVote, {
        targetType: RoadmapVoteTarget.Idea,
        targetId: 'idea-1',
      });
      expect(manager.delete).toHaveBeenCalledWith(RoadmapIdea, {
        id: 'idea-1',
      });
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('Promoted idea') as string,
        }),
      );
    });

    it('notifies the submitter, best-effort, when the idea came from a member', async () => {
      ideas.findOne.mockResolvedValue({
        ...BASE_IDEA,
        submittedById: 'member-1',
      });

      await service.promoteIdea('idea-1', ACTOR);

      expect(notifications.create).toHaveBeenCalledWith(
        'member-1',
        expect.anything(),
        expect.objectContaining({ source: 'roadmap', status: 'promoted' }),
      );
    });

    it('404s (no-ops) instead of double-creating when a concurrent request already promoted/merged/declined the idea', async () => {
      // Locked inside the transaction and found gone — a concurrent
      // promote/merge/decline won the race and already deleted it.
      ideas.findOne.mockResolvedValue(null);

      await expect(service.promoteIdea('idea-1', ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(items.save).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('mergeIdea', () => {
    // A Postgres unique-violation error, shaped exactly as `isUniqueViolation`
    // checks it (`error.code`/`error.constraint`) — simulates
    // `voteRepo.update(...)` losing the race against
    // `UQ_roadmap_votes_member_target` because the member already has a live
    // vote on the target item.
    const uniqueViolation = () =>
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'UQ_roadmap_votes_member_target',
      });

    it('moves live votes onto the target item without violating the unique vote constraint', async () => {
      ideas.findOne.mockResolvedValue({
        ...BASE_IDEA,
        votes: 3,
        submittedById: null,
      });
      items.findOne
        // Initial target lookup, inside the transaction.
        .mockResolvedValueOnce({
          ...BASE_ITEM,
          id: 'item-2',
          votes: 5,
          requested: false,
        })
        // Re-fetched after `manager.increment`/`manager.update` — reflects
        // what those statements would have actually done in Postgres.
        .mockResolvedValueOnce({
          ...BASE_ITEM,
          id: 'item-2',
          votes: 8,
          requested: true,
        });
      votes.find.mockResolvedValueOnce([
        {
          id: 'vote-a',
          memberId: 'member-a',
          targetType: RoadmapVoteTarget.Idea,
          targetId: 'idea-1',
        },
        {
          id: 'vote-b',
          memberId: 'member-b',
          targetType: RoadmapVoteTarget.Idea,
          targetId: 'idea-1',
        },
      ]);
      // member-b's reassignment collides with a vote they already have on
      // the target item directly — the unique (memberId, targetType,
      // targetId) constraint means their idea-side vote must be dropped
      // (caught via `isUniqueViolation`), not reassigned.
      votes.update.mockImplementation((criteria: { id: string }) =>
        criteria.id === 'vote-b'
          ? Promise.reject(uniqueViolation())
          : Promise.resolve({ affected: 1 }),
      );

      const result = await service.mergeIdea(
        'idea-1',
        { intoItemId: 'item-2' },
        ACTOR,
      );

      expect(votes.update).toHaveBeenCalledWith(
        { id: 'vote-a' },
        { targetType: RoadmapVoteTarget.Item, targetId: 'item-2' },
      );
      // The attempted (and rejected) reassignment for vote-b, followed by
      // the fallback delete instead of a silent double-count.
      expect(votes.update).toHaveBeenCalledWith(
        { id: 'vote-b' },
        { targetType: RoadmapVoteTarget.Item, targetId: 'item-2' },
      );
      expect(votes.delete).toHaveBeenCalledWith({ id: 'vote-b' });
      expect(manager.increment).toHaveBeenCalledWith(
        RoadmapItem,
        { id: 'item-2' },
        'votes',
        3,
      );
      expect(manager.update).toHaveBeenCalledWith(
        RoadmapItem,
        { id: 'item-2' },
        { requested: true },
      );
      expect(manager.delete).toHaveBeenCalledWith(RoadmapIdea, {
        id: 'idea-1',
      });
      expect(result.votes).toBe(8); // 5 seed + 3 idea seed
      expect(result.requested).toBe(true);
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('Merged idea') as string,
        }),
      );
    });

    it('404s when the target item does not exist', async () => {
      items.findOne.mockResolvedValue(null);

      await expect(
        service.mergeIdea('idea-1', { intoItemId: 'missing' }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The target is checked before the idea is even locked/loaded.
      expect(ideas.findOne).not.toHaveBeenCalled();
    });

    it('no-ops when the idea was already merged/promoted/deleted by a concurrent request', async () => {
      items.findOne.mockResolvedValue({
        ...BASE_ITEM,
        id: 'item-2',
        votes: 5,
        requested: false,
      });
      // Re-loaded (locked) inside the transaction and found gone.
      ideas.findOne.mockResolvedValue(null);

      const result = await service.mergeIdea(
        'idea-1',
        { intoItemId: 'item-2' },
        ACTOR,
      );

      expect(manager.increment).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalledWith(
        RoadmapIdea,
        expect.anything(),
      );
      expect(notifications.create).not.toHaveBeenCalled();
      expect(result.votes).toBe(5);
      expect(result.requested).toBe(false);
    });
  });

  describe('declineIdea', () => {
    it('sets status to dismissed with the decline reason/note', async () => {
      ideas.findOne.mockResolvedValue({
        ...BASE_IDEA,
        status: RoadmapIdeaStatus.Pending,
      });

      const result = await service.declineIdea(
        'idea-1',
        { reason: 'scope', note: "Doesn't fit this quarter" },
        ACTOR,
      );

      expect(result.status).toBe(RoadmapIdeaStatus.Dismissed);
      expect(result.declineReason).toBe('scope');
      expect(result.declineNote).toBe("Doesn't fit this quarter");
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining('Declined idea') as string,
        }),
      );
    });
  });

  describe('updateIdea — reopen', () => {
    it('clears declineReason/declineNote when status moves back to published', async () => {
      ideas.findOne.mockResolvedValue({
        ...BASE_IDEA,
        status: RoadmapIdeaStatus.Dismissed,
        declineReason: 'scope',
        declineNote: 'Out of scope for now',
      });

      const result = await service.updateIdea(
        'idea-1',
        { status: RoadmapIdeaStatus.Published },
        ACTOR,
      );

      expect(result.status).toBe(RoadmapIdeaStatus.Published);
      expect(result.declineReason).toBeNull();
      expect(result.declineNote).toBeNull();
      expect(ideas.save).toHaveBeenCalledWith(
        expect.objectContaining({ declineReason: null, declineNote: null }),
      );
    });

    it('leaves declineReason/declineNote alone on an unrelated field edit', async () => {
      ideas.findOne.mockResolvedValue({
        ...BASE_IDEA,
        status: RoadmapIdeaStatus.Dismissed,
        declineReason: 'scope',
        declineNote: 'Out of scope for now',
      });

      const result = await service.updateIdea(
        'idea-1',
        { sortOrder: 2 },
        ACTOR,
      );

      expect(result.declineReason).toBe('scope');
      expect(result.declineNote).toBe('Out of scope for now');
    });
  });

  describe('createTeamMember — conflict guard', () => {
    // Same `isUniqueViolation` idiom `mergeIdea`/`updateDeps` use — a
    // Postgres unique-violation shaped exactly as the service checks it
    // (`error.code`/`error.constraint`), simulating `team.save(...)` losing
    // the race against `UQ_roadmap_team_members_user_id` (a member has at
    // most one roster row).
    const uniqueViolation = () =>
      Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint: 'UQ_roadmap_team_members_user_id',
      });

    it('409s creating a roster row for a member already on the team', async () => {
      team.save.mockRejectedValue(uniqueViolation());

      await expect(
        service.createTeamMember({ userId: 'user-1', role: 'Engineer' }, ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('creates a roster row and resolves the member name from `profiles`', async () => {
      team.save.mockResolvedValue({
        id: 'team-1',
        userId: 'user-1',
        role: 'Engineer',
        weeklyCapHours: 10,
        paid: true,
        sortOrder: 0,
      });
      profiles.find.mockResolvedValue([
        {
          userId: 'user-1',
          firstName: 'Rowan',
          lastName: 'Reyes',
          slug: 'rowan',
          avatarUrl: null,
        },
      ]);

      const result = await service.createTeamMember(
        { userId: 'user-1', role: 'Engineer' },
        ACTOR,
      );

      expect(result.name).toBe('Rowan Reyes');
      expect(auditLog.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.stringContaining(
            'Added "Rowan Reyes" to the team',
          ) as string,
        }),
      );
    });
  });

  describe('getAuditCsv', () => {
    it('quotes every field and doubles embedded quotes', async () => {
      auditLog.find.mockResolvedValue([
        {
          id: 'audit-1',
          actorId: 'admin-1',
          actorLabel: 'Ash (admin)',
          action: 'Said "hello, world" to the team',
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
        },
      ]);

      const csv = await service.getAuditCsv();
      const lines = csv.split('\n');

      expect(lines[0]).toBe('"when","who","what"');
      expect(lines[1]).toBe(
        '"2026-08-01T12:00:00.000Z","Ash (admin)","Said ""hello, world"" to the team"',
      );
    });

    it('neutralizes leading formula-trigger characters before quoting', async () => {
      auditLog.find.mockResolvedValue([
        {
          id: 'audit-1',
          actorId: 'admin-1',
          actorLabel: "=cmd|'/c calc'!A1",
          action: '+HYPERLINK("http://evil.example")',
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
        },
        {
          id: 'audit-2',
          actorId: 'admin-2',
          actorLabel: '-2+3',
          action: '@SUM(1,2)',
          createdAt: new Date('2026-08-01T12:01:00.000Z'),
        },
      ]);

      const csv = await service.getAuditCsv();
      const lines = csv.split('\n');

      expect(lines[1]).toBe(
        '"2026-08-01T12:00:00.000Z","\'=cmd|\'/c calc\'!A1","\'+HYPERLINK(""http://evil.example"")"',
      );
      expect(lines[2]).toBe(
        '"2026-08-01T12:01:00.000Z","\'-2+3","\'@SUM(1,2)"',
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Event } from '../events/entities/event.entity';
import { Report } from '../reports/entities/report.entity';
import { CommunityDigestService } from './community-digest.service';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import { Community } from './entities/community.entity';
import { CommunityPost } from './entities/community-post.entity';

// A chainable query-builder stub whose terminal methods resolve to empty
// results by default. Mirrors `landing.service.spec.ts`'s `qbStub`.
function qbStub() {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

describe('CommunityDigestService', () => {
  let service: CommunityDigestService;
  let communities: { find: jest.Mock };
  let members: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let posts: {
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let events: { createQueryBuilder: jest.Mock };
  let joinRequests: { createQueryBuilder: jest.Mock };
  let reports: { query: jest.Mock };

  beforeEach(async () => {
    communities = { find: jest.fn().mockResolvedValue([]) };
    members = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbStub()),
    };
    posts = {
      createQueryBuilder: jest.fn(() => qbStub()),
      query: jest.fn().mockResolvedValue([]),
    };
    events = { createQueryBuilder: jest.fn(() => qbStub()) };
    joinRequests = { createQueryBuilder: jest.fn(() => qbStub()) };
    reports = { query: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityDigestService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        { provide: getRepositoryToken(Event), useValue: events },
        {
          provide: getRepositoryToken(CommunityJoinRequest),
          useValue: joinRequests,
        },
        { provide: getRepositoryToken(Report), useValue: reports },
      ],
    }).compile();
    service = module.get(CommunityDigestService);
  });

  describe('getDigest', () => {
    it('includes a space the caller belongs to, distinct from its parent, and labels it with the parent name', async () => {
      members.find.mockResolvedValue([
        {
          communityId: 'space-1',
          role: RosterRole.Member,
          notificationLevel: CommunityNotificationLevel.All,
        },
      ]);
      // The batched parent-name lookup: a second `communities.find` call for
      // the distinct parent ids collected off the first result.
      communities.find.mockResolvedValueOnce([
        {
          id: 'space-1',
          slug: 'photography',
          name: 'Photography',
          parentId: 'parent-1',
          avatarImageUrl: null,
        },
      ]);
      communities.find.mockResolvedValueOnce([
        { id: 'parent-1', name: 'Bristol Queer Collective' },
      ]);

      const result = await service.getDigest('user-1');

      expect(result.communities).toEqual([
        expect.objectContaining({
          slug: 'photography',
          name: 'Photography',
          parentName: 'Bristol Queer Collective',
        }),
      ]);
    });

    it('reports parentName null for a top-level community the caller belongs to', async () => {
      members.find.mockResolvedValue([
        {
          communityId: 'community-1',
          role: RosterRole.Member,
          notificationLevel: CommunityNotificationLevel.All,
        },
      ]);
      communities.find.mockResolvedValueOnce([
        {
          id: 'community-1',
          slug: 'trans-nb-network',
          name: 'Trans & Non-Binary Network',
          parentId: null,
          avatarImageUrl: null,
        },
      ]);

      const result = await service.getDigest('user-1');

      expect(result.communities).toEqual([
        expect.objectContaining({
          slug: 'trans-nb-network',
          parentName: null,
        }),
      ]);
      // No space in the caller's roster means no parent ids to resolve, so
      // the batched parent-name lookup never runs a second query.
      expect(communities.find).toHaveBeenCalledTimes(1);
    });
  });
});

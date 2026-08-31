import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { ConnectionsService } from '../connections/connections.service';
import { Connection } from '../connections/entities/connection.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { MemberSuggestionDismissal } from './entities/member-suggestion-dismissal.entity';
import { MemberSuggestionsService } from './member-suggestions.service';

/**
 * These tests are mostly about what must NEVER come back.
 *
 * A directory is a place a member walked into. A suggestion is the platform
 * walking up to them, so every exclusion here is load-bearing: a blocked
 * member, a member who hid themself, a suspended account, someone already
 * connected, someone already waved away, or the viewer themself must not be
 * offered. The SQL gates are asserted by checking the predicates that reach
 * the query builder (the mock cannot run Postgres); the pool and post-query
 * gates are asserted on real behaviour.
 */

/** Chainable select-builder stub. Records every predicate it is handed. */
class QueryBuilderStub {
  readonly predicates: string[] = [];
  readonly parameters: Record<string, unknown> = {};
  rows: unknown[] = [];
  rawRows: unknown[] = [];

  select = jest.fn(() => this);
  innerJoin = jest.fn(
    (_relation: string, _alias: string, condition?: string) => {
      if (condition) this.predicates.push(condition);
      return this;
    },
  );
  where = jest.fn((clause: string, params?: Record<string, unknown>) => {
    this.predicates.push(clause);
    Object.assign(this.parameters, params ?? {});
    return this;
  });
  andWhere = jest.fn((clause: string, params?: Record<string, unknown>) => {
    this.predicates.push(clause);
    Object.assign(this.parameters, params ?? {});
    return this;
  });
  setParameter = jest.fn((key: string, value: unknown) => {
    this.parameters[key] = value;
    return this;
  });
  orderBy = jest.fn(() => this);
  limit = jest.fn(() => this);
  getMany = jest.fn(() => Promise.resolve(this.rows));
  getRawMany = jest.fn(() => Promise.resolve(this.rawRows));

  /** True when any predicate mentions all of `fragments`. */
  hasPredicateWith(...fragments: string[]): boolean {
    return this.predicates.some((predicate) =>
      fragments.every((fragment) => predicate.includes(fragment)),
    );
  }
}

interface InsertBuilderStub {
  insert: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  execute: jest.Mock;
}

function insertBuilderStub(): InsertBuilderStub {
  const builder: InsertBuilderStub = {
    insert: jest.fn(),
    values: jest.fn(),
    orIgnore: jest.fn(),
    execute: jest.fn().mockResolvedValue({}),
  };
  builder.insert.mockReturnValue(builder);
  builder.values.mockReturnValue(builder);
  builder.orIgnore.mockReturnValue(builder);
  return builder;
}

const VIEWER_ID = 'viewer-1';

function profileFixture(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'candidate-1',
    slug: 'ana-costa',
    firstName: 'Ana',
    lastName: 'Costa',
    pronouns: 'she/her',
    pronunciation: null,
    tagline: 'Photographer',
    bio: null,
    bioPt: null,
    location: null,
    avatarUrl: null,
    visibility: ProfileVisibility.Open,
    openTo: [],
    notHereFor: null,
    identities: [],
    discoverableIdentities: [],
    lookingFor: [],
    lookingForPublic: false,
    tags: [],
    discipline: [],
    profession: [],
    languages: [],
    vouchCount: 0,
    photoVisible: true,
    hoodVisible: true,
    vouchersVisible: true,
    hiddenUntil: null,
    joinedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Profile;
}

describe('MemberSuggestionsService', () => {
  let service: MemberSuggestionsService;
  let profileBuilders: QueryBuilderStub[];
  let profiles: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communityMembers: { find: jest.Mock };
  let communities: { find: jest.Mock };
  let connections: { find: jest.Mock };
  let dismissals: { createQueryBuilder: jest.Mock };
  let connectionsService: {
    getAcceptedConnectionUserIds: jest.Mock;
    mutualCountsByUserIds: jest.Mock;
  };
  let blockFilter: { excludeHidden: jest.Mock };
  let hiddenFrom: { excludeHiddenFrom: jest.Mock };
  let contentModeration: { statesForAnyType: jest.Mock };
  let insertBuilder: InsertBuilderStub;

  /** The builder `visibleCandidates` used (the last one profiles handed out). */
  const candidateBuilder = () => profileBuilders[profileBuilders.length - 1]!;

  beforeEach(async () => {
    profileBuilders = [];
    insertBuilder = insertBuilderStub();
    profiles = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const builder = new QueryBuilderStub();
        profileBuilders.push(builder);
        return builder;
      }),
    };
    communityMembers = { find: jest.fn().mockResolvedValue([]) };
    communities = { find: jest.fn().mockResolvedValue([]) };
    connections = { find: jest.fn().mockResolvedValue([]) };
    dismissals = { createQueryBuilder: jest.fn(() => insertBuilder) };
    connectionsService = {
      getAcceptedConnectionUserIds: jest.fn().mockResolvedValue([]),
      mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
    };
    blockFilter = { excludeHidden: jest.fn() };
    hiddenFrom = { excludeHiddenFrom: jest.fn() };
    contentModeration = {
      statesForAnyType: jest.fn().mockResolvedValue(new Map()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemberSuggestionsService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Connection), useValue: connections },
        {
          provide: getRepositoryToken(MemberSuggestionDismissal),
          useValue: dismissals,
        },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: HiddenFromService, useValue: hiddenFrom },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();
    service = module.get(MemberSuggestionsService);
  });

  /** Viewer who is on one roster-visible community with one other member. */
  function seedSharedCommunity(candidateUserIds: string[]) {
    profiles.findOne.mockResolvedValue(
      profileFixture({ userId: VIEWER_ID, slug: 'viewer' }),
    );
    communityMembers.find.mockImplementation(
      (options: { where: { userId?: string } }) =>
        options.where.userId === VIEWER_ID
          ? Promise.resolve([{ communityId: 'community-1' }])
          : Promise.resolve(
              candidateUserIds.map((userId) => ({
                userId,
                communityId: 'community-1',
              })),
            ),
    );
    communities.find.mockResolvedValue([
      {
        id: 'community-1',
        name: 'Trans & Non-Binary Network',
        archivedAt: null,
      },
    ]);
  }

  describe('exclusions', () => {
    it('asks the database for active accounts only, so a suspended member is never suggested', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      expect(candidateBuilder().hasPredicateWith('u.status = :active')).toBe(
        true,
      );
    });

    it('applies the directory block and mute gate to the same column', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        candidateBuilder(),
        VIEWER_ID,
        '"p"."user_id"',
      );
    });

    it('applies the directory hidden-from gate, so a member who hid from this viewer stays hidden', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      expect(hiddenFrom.excludeHiddenFrom).toHaveBeenCalledWith(
        candidateBuilder(),
        VIEWER_ID,
        '"p"."user_id"',
      );
    });

    it('honours "hide me for 24 hours" exactly as the directory does', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      expect(candidateBuilder().hasPredicateWith('"hidden_until"')).toBe(true);
    });

    it('never suggests the viewer to themself', async () => {
      seedSharedCommunity([VIEWER_ID, 'candidate-1']);
      await service.suggest(VIEWER_ID);

      const builder = candidateBuilder();
      expect(builder.parameters.candidateIds).toEqual(['candidate-1']);
      expect(builder.hasPredicateWith('p.userId <> :viewerUserId')).toBe(true);
    });

    it('drops anyone the viewer already has an accepted connection with before querying', async () => {
      seedSharedCommunity(['candidate-1', 'already-connected']);
      connectionsService.getAcceptedConnectionUserIds.mockResolvedValue([
        'already-connected',
      ]);
      await service.suggest(VIEWER_ID);

      expect(candidateBuilder().parameters.candidateIds).toEqual([
        'candidate-1',
      ]);
    });

    it('excludes every connection row in either direction, at any status', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      // No status predicate: a pending request is already asked, and a
      // declined or blocked row is an answer that must not be worked around
      // through a different surface.
      const builder = candidateBuilder();
      expect(
        builder.hasPredicateWith(
          'NOT EXISTS',
          '"connections"',
          'requester_id',
          'addressee_id',
        ),
      ).toBe(true);
      expect(builder.hasPredicateWith('"connections"', 'status')).toBe(false);
    });

    it('excludes anyone the viewer has already dismissed', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      expect(
        candidateBuilder().hasPredicateWith(
          'NOT EXISTS',
          '"member_suggestion_dismissals"',
          '"dismissed_user_id"',
        ),
      ).toBe(true);
    });

    // PRD-16. In the QUERY, so an opted-out member cannot be scored and then
    // leaked by a mapping change further down, and as a `NOT EXISTS` so the
    // absent row reads as "recommendable": most members have never opened
    // Settings and have no `member_preferences` row at all.
    it('excludes anyone who asked not to be recommended', async () => {
      seedSharedCommunity(['candidate-1']);
      await service.suggest(VIEWER_ID);

      const builder = candidateBuilder();
      expect(
        builder.hasPredicateWith(
          'NOT EXISTS',
          '"member_preferences"',
          '"hide_from_suggestions" = true',
        ),
      ).toBe(true);
      // Keyed to the CANDIDATE, never the viewer: the switch stops a member
      // being recommended, and never stops them seeing recommendations.
      expect(
        builder.hasPredicateWith(
          '"__suggestion_optout"."user_id" = "p"."user_id"',
        ),
      ).toBe(true);
    });

    it('drops a member a moderator has hidden, keyed by slug or by user id', async () => {
      seedSharedCommunity(['candidate-1', 'candidate-2']);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = [
          profileFixture({ userId: 'candidate-1', slug: 'ana-costa' }),
          profileFixture({ userId: 'candidate-2', slug: 'rui-silva' }),
        ];
        profileBuilders.push(builder);
        return builder;
      });
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['ana-costa', { hidden: true, removed: false }]]),
      );

      const suggestions = await service.suggest(VIEWER_ID);

      expect(suggestions.map((entry) => entry.member.slug)).toEqual([
        'rui-silva',
      ]);
    });

    it('drops a member a moderator has removed', async () => {
      seedSharedCommunity(['candidate-1']);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = [profileFixture({ userId: 'candidate-1' })];
        profileBuilders.push(builder);
        return builder;
      });
      contentModeration.statesForAnyType.mockResolvedValue(
        new Map([['candidate-1', { hidden: false, removed: true }]]),
      );

      await expect(service.suggest(VIEWER_ID)).resolves.toEqual([]);
    });
  });

  describe('what it offers', () => {
    it('offers nothing at all to a member who has joined, connected and written nothing', async () => {
      profiles.findOne.mockResolvedValue(
        profileFixture({ userId: VIEWER_ID, slug: 'viewer' }),
      );

      await expect(service.suggest(VIEWER_ID)).resolves.toEqual([]);
      // No candidate query is even issued: there is nothing honest to ask for.
      expect(profileBuilders).toHaveLength(0);
    });

    it('carries the reason with the card so it can say why, never "recommended for you"', async () => {
      seedSharedCommunity(['candidate-1']);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = [profileFixture({ userId: 'candidate-1' })];
        profileBuilders.push(builder);
        return builder;
      });

      const [suggestion] = await service.suggest(VIEWER_ID);

      expect(suggestion?.reason).toEqual({
        kind: 'community',
        label: 'Trans & Non-Binary Network',
        presetId: null,
        count: 1,
      });
    });

    it('will not explain a suggestion with a community whose roster is hidden', async () => {
      seedSharedCommunity(['candidate-1']);
      // The roster-visible filter is a `where` on the community repository, so
      // a hidden-roster community simply does not come back.
      communities.find.mockResolvedValue([]);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = [profileFixture({ userId: 'candidate-1' })];
        profileBuilders.push(builder);
        return builder;
      });

      await expect(service.suggest(VIEWER_ID)).resolves.toEqual([]);
      expect(communities.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ rosterVisible: true }),
        }),
      );
    });

    it('never explains a suggestion with an identity', async () => {
      seedSharedCommunity(['candidate-1']);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = [
          profileFixture({
            userId: 'candidate-1',
            identities: ['Non-binary'],
            discoverableIdentities: ['Non-binary'],
          }),
        ];
        profileBuilders.push(builder);
        return builder;
      });

      const [suggestion] = await service.suggest(VIEWER_ID);

      expect(suggestion?.reason.kind).not.toBe('identity');
      expect(suggestion?.reason.label).not.toContain('binary');
    });

    it('honours the requested limit and its ceiling', async () => {
      const candidateUserIds = Array.from(
        { length: 8 },
        (_unused, index) => `candidate-${index}`,
      );
      seedSharedCommunity(candidateUserIds);
      profiles.createQueryBuilder.mockImplementation(() => {
        const builder = new QueryBuilderStub();
        builder.rows = candidateUserIds.map((userId, index) =>
          profileFixture({ userId, slug: `member-${index}` }),
        );
        profileBuilders.push(builder);
        return builder;
      });

      await expect(service.suggest(VIEWER_ID, 3)).resolves.toHaveLength(3);
      await expect(service.suggest(VIEWER_ID, 999)).resolves.toHaveLength(8);
    });
  });

  describe('dismiss', () => {
    it('remembers the dismissal so the same person is not offered forever', async () => {
      profiles.findOne.mockResolvedValue(
        profileFixture({ userId: 'candidate-1' }),
      );

      await expect(service.dismiss(VIEWER_ID, 'ana-costa')).resolves.toEqual({
        dismissed: true,
      });
      expect(insertBuilder.values).toHaveBeenCalledWith({
        userId: VIEWER_ID,
        dismissedUserId: 'candidate-1',
      });
    });

    it('is idempotent: a second tap is absorbed by the unique constraint', async () => {
      profiles.findOne.mockResolvedValue(
        profileFixture({ userId: 'candidate-1' }),
      );

      await service.dismiss(VIEWER_ID, 'ana-costa');

      expect(insertBuilder.orIgnore).toHaveBeenCalled();
    });

    it('writes nothing when the member dismisses themself', async () => {
      profiles.findOne.mockResolvedValue(profileFixture({ userId: VIEWER_ID }));

      await expect(service.dismiss(VIEWER_ID, 'viewer')).resolves.toEqual({
        dismissed: true,
      });
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('404s an unknown slug rather than writing a row nobody can undo', async () => {
      profiles.findOne.mockResolvedValue(null);

      await expect(service.dismiss(VIEWER_ID, 'nobody')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

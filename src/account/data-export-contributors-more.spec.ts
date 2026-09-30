import { In, Repository } from 'typeorm';
import { AccountExportService } from './account-export.service';
import { DataExportContribution } from './data-export-contributor';
import {
  AccountRequestsExportContributor,
  AppealsExportContributor,
  BarterExportContributor,
  BoardExportContributor,
  CardScansExportContributor,
  CollectionsExportContributor,
  CommunityActivityExportContributor,
  CommunityMembershipsExportContributor,
  CommunityRequestsExportContributor,
  ConnectionNotesExportContributor,
  DraftsExportContributor,
  EventParticipationExportContributor,
  EventPreferencesExportContributor,
  FeedPreferencesExportContributor,
  ForumActivityExportContributor,
  GovernanceActivityExportContributor,
  GroupListingsExportContributor,
  HandlesExportContributor,
  InvitesSentExportContributor,
  JoinApplicationExportContributor,
  LandlordRecommendationsExportContributor,
  LandlordsExportContributor,
  ListingActivityExportContributor,
  MagazineContributionsExportContributor,
  MagazinePaymentsExportContributor,
  MemberPreferencesExportContributor,
  MessageActivityExportContributor,
  MORE_EXPORT_CONTRIBUTORS,
  PersonaActivityExportContributor,
  PersonaContentExportContributor,
  ProfileSectionsExportContributor,
  RecognitionExportContributor,
  ResourceFeedbackExportContributor,
  SafeSpacesExportContributor,
  SavedListsExportContributor,
  StaffRolesExportContributor,
  SuggestionDismissalsExportContributor,
  VerificationExportContributor,
  VolunteeringRolesExportContributor,
  WatchHistoryExportContributor,
  WorkExportContributor,
} from './data-export-contributors-more';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const MEMBER_ID = 'user-1';

/** A repository stub exposing only the given finder methods. */
function repositoryWith<Entity extends object>(
  methods: Partial<
    Record<'find' | 'findOne' | 'createQueryBuilder', jest.Mock>
  >,
): Repository<Entity> {
  return methods as unknown as Repository<Entity>;
}

/** What one repository stub was asked: its finder `where` options in call
 *  order, and every `where`/`andWhere` of the query builders it handed out. */
interface RepositoryLog {
  finderWheres: unknown[];
  builderConditions: string[];
  builderParameters: unknown[];
}

const BUILDER_CHAIN_METHODS = [
  'innerJoin',
  'leftJoin',
  'where',
  'andWhere',
  'orderBy',
  'addSelect',
] as const;

/**
 * A repository that holds nothing for anyone and logs how it was queried.
 * `find` resolves `[]`, `findOne` resolves null, and a query builder's
 * `getMany`/`getOne` resolve `[]`/null, unless `builderRows` says otherwise.
 */
function recordingRepository<Entity extends object>(
  log: RepositoryLog = {
    finderWheres: [],
    builderConditions: [],
    builderParameters: [],
  },
  builderRows: unknown[] = [],
): Repository<Entity> {
  const createQueryBuilder = jest.fn(() => {
    const builder: Record<string, jest.Mock> = {
      getMany: jest.fn().mockResolvedValue(builderRows),
      getOne: jest.fn().mockResolvedValue(builderRows[0] ?? null),
    };
    for (const method of BUILDER_CHAIN_METHODS) {
      builder[method] = jest.fn((...args: unknown[]) => {
        if (method === 'where' || method === 'andWhere') {
          log.builderConditions.push(String(args[0]));
          log.builderParameters.push(args[1]);
        }
        return builder;
      });
    }
    return builder;
  });
  return repositoryWith<Entity>({
    find: jest.fn((options: { where?: unknown }) => {
      log.finderWheres.push(options.where);
      return Promise.resolve([]);
    }),
    findOne: jest.fn((options: { where?: unknown }) => {
      log.finderWheres.push(options.where);
      return Promise.resolve(null);
    }),
    createQueryBuilder,
  });
}

/** A repository that holds nothing for anyone. */
function emptyRepository<Entity extends object>(): Repository<Entity> {
  return recordingRepository<Entity>();
}

type ContributorClass = new (
  ...repositories: unknown[]
) => DataExportContribution;

/** A contributor whose every repository is empty. */
function withEmptyRepositories(
  contributorClass: (typeof MORE_EXPORT_CONTRIBUTORS)[number],
): DataExportContribution {
  const constructable = contributorClass as unknown as ContributorClass;
  const repositories = Array.from({ length: constructable.length }, () =>
    emptyRepository(),
  );
  return new constructable(...repositories);
}

/** The six core categories' contributions, read off a service whose
 *  repositories are never touched (`coreContributions` only builds closures). */
function coreArchiveKeys(): string[] {
  const constructable = AccountExportService as unknown as new (
    ...dependencies: unknown[]
  ) => AccountExportService;
  const service = new constructable(
    ...Array.from({ length: constructable.length }, () => ({})),
  ) as unknown as { coreContributions(): DataExportContribution[] };
  return service
    .coreContributions()
    .map((contribution) => contribution.archiveKey);
}

/** The request category ids the export page offers (`dataExport.data.ts`). */
const REQUEST_CATEGORIES = [
  'profile',
  'subprofiles',
  'nowHistory',
  'messages',
  'forumPosts',
  'communities',
  'events',
  'goTogether',
  'connections',
  'reports',
  'housing',
  'listings',
  'magazine',
  'reviews',
  'volunteering',
  'governance',
  'membershipCards',
  'activityLog',
  'saved',
  'notifications',
  'consent',
  'media',
];

describe('ENG-495b contributor registration', () => {
  const contributors = MORE_EXPORT_CONTRIBUTORS.map(withEmptyRepositories);

  it('registers every entity-audit contributor in NEW_DOMAIN_EXPORT_CONTRIBUTORS', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toEqual(
      expect.arrayContaining([...MORE_EXPORT_CONTRIBUTORS]),
    );
  });

  it('rides only on request categories the export page already offers', () => {
    for (const contributor of contributors) {
      expect(REQUEST_CATEGORIES).toContain(contributor.category);
    }
  });

  it('gives every archive key a csv file, in registration order', () => {
    const archiveKeys = contributors.map(
      (contributor) => contributor.archiveKey,
    );
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    const firstIndex = csvKeys.indexOf(archiveKeys[0] ?? '');

    expect(firstIndex).toBeGreaterThan(-1);
    expect(csvKeys.slice(firstIndex, firstIndex + archiveKeys.length)).toEqual(
      archiveKeys,
    );
  });

  it('never reuses an archive key, the six core categories included', () => {
    const allKeys = [
      ...coreArchiveKeys(),
      ...NEW_DOMAIN_EXPORT_CONTRIBUTORS.map(
        (contributorClass) =>
          withEmptyRepositories(
            contributorClass as unknown as (typeof MORE_EXPORT_CONTRIBUTORS)[number],
          ).archiveKey,
      ),
    ];

    expect(allKeys).toEqual(expect.arrayContaining(['profile', 'posts']));
    expect(new Set(allKeys).size).toBe(allKeys.length);
  });

  it('pairs each class with the category and archive key the report documents', () => {
    const pairs = MORE_EXPORT_CONTRIBUTORS.map(withEmptyRepositories).map(
      (contributor) => [contributor.category, contributor.archiveKey],
    );

    expect(pairs).toEqual([
      ['profile', 'preferences'],
      ['profile', 'profileSections'],
      ['profile', 'handles'],
      ['profile', 'board'],
      ['profile', 'verification'],
      ['profile', 'joinApplication'],
      ['profile', 'staffRoles'],
      ['messages', 'messageActivity'],
      ['forumPosts', 'forumActivity'],
      ['communities', 'communityMemberships'],
      ['communities', 'communityActivity'],
      ['communities', 'communityRequests'],
      ['communities', 'feedPreferences'],
      ['events', 'eventPreferences'],
      ['events', 'eventParticipation'],
      ['connections', 'connectionNotes'],
      ['connections', 'suggestionDismissals'],
      ['connections', 'invitesSent'],
      ['activityLog', 'accountRequests'],
      ['activityLog', 'recognition'],
      ['activityLog', 'watchHistory'],
      ['saved', 'savedLists'],
      ['saved', 'collections'],
      ['saved', 'drafts'],
      ['housing', 'groupListings'],
      ['housing', 'landlords'],
      ['reviews', 'landlordRecommendations'],
      ['reviews', 'resourceFeedback'],
      ['listings', 'listingActivity'],
      ['listings', 'safeSpaces'],
      ['listings', 'barter'],
      ['listings', 'work'],
      ['magazine', 'magazineContributions'],
      ['magazine', 'magazinePayments'],
      ['governance', 'governanceActivity'],
      ['reports', 'appeals'],
      ['membershipCards', 'cardScans'],
      ['volunteering', 'volunteeringRoles'],
      ['subprofiles', 'personaActivity'],
      ['subprofiles', 'personaContent'],
    ]);
  });

  it('builds an empty list or null for a member with no rows anywhere', async () => {
    for (const contributor of contributors) {
      const result = await contributor.buildContribution(MEMBER_ID);
      expect(result === null || (Array.isArray(result) && !result.length)).toBe(
        true,
      );
    }
  });
});

/**
 * How one constructor repository must be filtered to the member: the
 * `where` of each finder call in order, the conditions of its query builder,
 * or `dependent` for a repository read only once its parent returned rows
 * (covered by the class's own test).
 */
type OwnerFilter = { finds: unknown[] } | { builder: string[] } | 'dependent';

const finds = (...wheres: unknown[]): OwnerFilter => ({ finds: wheres });
const builder = (...conditions: string[]): OwnerFilter => ({
  builder: conditions,
});
const byColumn = (column: string) => ({ [column]: MEMBER_ID });
const either = (...columns: string[]) => columns.map(byColumn);

/** Every contributor's owner filter, one entry per constructor repository. */
const OWNER_FILTERS: [
  (typeof MORE_EXPORT_CONTRIBUTORS)[number],
  OwnerFilter[],
][] = [
  [MemberPreferencesExportContributor, [finds(byColumn('userId'))]],
  [
    ProfileSectionsExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('ownerId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
    ],
  ],
  [
    HandlesExportContributor,
    [finds(byColumn('userId')), finds(byColumn('previousOwnerUserId'))],
  ],
  [
    BoardExportContributor,
    [finds(byColumn('userId')), finds(byColumn('responderId'))],
  ],
  [
    VerificationExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
    ],
  ],
  [JoinApplicationExportContributor, [builder('invite.acceptedBy = :userId')]],
  [StaffRolesExportContributor, [finds(byColumn('userId'))]],
  [
    MessageActivityExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(either('inviterId', 'inviteeId')),
      finds(byColumn('userId')),
    ],
  ],
  [
    ForumActivityExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      builder('edit.editorId = :userId', 'post.authorId = :userId'),
      finds(byColumn('coAuthorId')),
      builder('thread.authorId = :userId'),
      builder('thread.authorId = :userId'),
    ],
  ],
  [CommunityMembershipsExportContributor, [finds(byColumn('userId'))]],
  [
    CommunityActivityExportContributor,
    [
      finds(byColumn('userId')),
      finds(either('invitedByUserId', 'invitedUserId')),
      finds(byColumn('createdByUserId')),
      builder('edit.editorId = :userId', 'post.authorId = :userId'),
      builder('edit.editorId = :userId', 'reply.authorId = :userId'),
    ],
  ],
  [
    CommunityRequestsExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('requestedByUserId')),
      finds(byColumn('requestedByUserId')),
      finds(byColumn('requestedByUserId')),
      finds(byColumn('memberId')),
    ],
  ],
  [
    FeedPreferencesExportContributor,
    [finds(byColumn('userId')), finds(byColumn('userId'))],
  ],
  [EventPreferencesExportContributor, [finds(byColumn('userId'))]],
  [
    EventParticipationExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(either('inviterId', 'inviteeId')),
      finds(either('inviterId', 'inviteeId')),
      finds(byColumn('authorId')),
      finds(byColumn('uploaderId')),
      finds(byColumn('hostId')),
    ],
  ],
  [ConnectionNotesExportContributor, [finds(byColumn('authorId'))]],
  [SuggestionDismissalsExportContributor, [finds(byColumn('userId'))]],
  [InvitesSentExportContributor, [finds(byColumn('inviterId'))]],
  [
    AccountRequestsExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
    ],
  ],
  [
    RecognitionExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
    ],
  ],
  [WatchHistoryExportContributor, [finds(byColumn('userId'))]],
  [SavedListsExportContributor, [finds(byColumn('userId')), 'dependent']],
  [CollectionsExportContributor, [finds(byColumn('ownerId')), 'dependent']],
  [DraftsExportContributor, [finds(byColumn('userId'))]],
  [GroupListingsExportContributor, [finds(byColumn('postedByUserId'))]],
  [
    LandlordsExportContributor,
    [finds(byColumn('userId')), finds(byColumn('submittedByUserId'))],
  ],
  [LandlordRecommendationsExportContributor, [finds(byColumn('authorUserId'))]],
  [
    ResourceFeedbackExportContributor,
    [finds(byColumn('memberId')), finds(byColumn('memberId'))],
  ],
  [
    ListingActivityExportContributor,
    [
      finds(byColumn('claimantId')),
      finds(byColumn('suggestedByUserId')),
      finds(byColumn('offereeId')),
      finds(either('userId', 'invitedByUserId')),
      finds(byColumn('senderId')),
      finds(byColumn('askerId'), byColumn('answeredById')),
      finds(byColumn('voterId')),
      finds(byColumn('userId')),
    ],
  ],
  [
    SafeSpacesExportContributor,
    [
      finds(byColumn('nominatorId')),
      finds(byColumn('flaggerId')),
      finds(byColumn('voucherId')),
    ],
  ],
  [
    BarterExportContributor,
    [finds(byColumn('ownerId')), finds(byColumn('proposerId'))],
  ],
  [
    WorkExportContributor,
    [
      finds(byColumn('ownerId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      finds(either('submittedById', 'ownerUserId')),
      finds(byColumn('posterId')),
      finds(byColumn('applicantId')),
    ],
  ],
  [
    MagazineContributionsExportContributor,
    [
      finds(byColumn('authorId')),
      finds(byColumn('authorId')),
      finds(byColumn('authorId')),
      finds(byColumn('submitterId')),
      finds(byColumn('userId')),
      finds(byColumn('userId')),
      'dependent',
    ],
  ],
  [MagazinePaymentsExportContributor, [builder('piece.writerId = :userId')]],
  [
    GovernanceActivityExportContributor,
    [
      finds(byColumn('memberId')),
      finds(byColumn('submittedById')),
      finds(byColumn('authorId')),
      finds(byColumn('memberId')),
      finds(byColumn('nominatorId')),
      finds(byColumn('submitterId')),
    ],
  ],
  [AppealsExportContributor, [finds(byColumn('appellantId'))]],
  [CardScansExportContributor, [finds(byColumn('userId')), 'dependent']],
  [
    VolunteeringRolesExportContributor,
    [
      finds(byColumn('posterId')),
      finds(byColumn('userId')),
      finds(byColumn('memberId')),
    ],
  ],
  [
    PersonaActivityExportContributor,
    [
      finds(byColumn('userId')),
      finds(byColumn('endorserId')),
      finds(byColumn('followerId')),
      finds(either('invitedByUserId', 'invitedUserId')),
    ],
  ],
  [
    PersonaContentExportContributor,
    [
      builder('(subprofile.userId = :userId OR coOwner.id IS NOT NULL)'),
      builder('(subprofile.userId = :userId OR coOwner.id IS NOT NULL)'),
      builder('(subprofile.userId = :userId OR coOwner.id IS NOT NULL)'),
      builder('(subprofile.userId = :userId OR coOwner.id IS NOT NULL)'),
    ],
  ],
];

describe('owner filters', () => {
  it('lists every registered entity-audit contributor', () => {
    expect(OWNER_FILTERS.map(([contributorClass]) => contributorClass)).toEqual(
      [...MORE_EXPORT_CONTRIBUTORS],
    );
  });

  it.each(
    OWNER_FILTERS.map(
      ([contributorClass, filters]) =>
        [contributorClass.name, contributorClass, filters] as const,
    ),
  )(
    '%s reads every repository by the member column alone',
    async (_name, contributorClass, filters) => {
      const constructable = contributorClass as unknown as ContributorClass;
      expect(filters).toHaveLength(constructable.length);
      const logs: RepositoryLog[] = filters.map(() => ({
        finderWheres: [],
        builderConditions: [],
        builderParameters: [],
      }));
      const contributor = new constructable(
        ...logs.map((log) => recordingRepository(log)),
      );

      await contributor.buildContribution(MEMBER_ID);

      filters.forEach((filter, index) => {
        const log = logs[index];
        if (filter === 'dependent' || !log) return;
        if ('finds' in filter) {
          expect(log.finderWheres).toEqual(filter.finds);
          return;
        }
        expect(log.builderConditions).toEqual(filter.builder);
        for (const parameters of log.builderParameters) {
          expect(parameters).toEqual({ userId: MEMBER_ID });
        }
      });
    },
  );
});

describe('MemberPreferencesExportContributor', () => {
  it('exports the settings row with its timestamp as an ISO string', async () => {
    const findOne = jest.fn().mockResolvedValue({
      userId: 'user-1',
      outAtWork: 'private',
      transSupport: ['name'],
      safeOnly: true,
      skills: [],
      focusAreas: [],
      publicProfileEnabled: false,
      loginAlertsEnabled: true,
      hidePushPreviews: true,
      hideDatingContent: false,
      hideMentalHealthContent: true,
      hideSexualityIdentityContent: false,
      hideFromSuggestions: true,
      groupAddPolicy: 'invite_only',
      shareReadReceipts: false,
      shareTyping: true,
      sharePresence: false,
      whoCanMessage: 'connections',
      updatedAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    const contributor = new MemberPreferencesExportContributor(
      repositoryWith({ findOne }),
    );

    const result = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >;

    expect(findOne).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
    expect(result).toMatchObject({
      outAtWork: 'private',
      hideMentalHealthContent: true,
      groupAddPolicy: 'invite_only',
      updatedAt: '2026-03-01T10:00:00.000Z',
    });
    expect(result).not.toHaveProperty('userId');
  });
});

describe('ForumActivityExportContributor', () => {
  it("lists each poll on the member's threads with its options in order", async () => {
    const pollLog: RepositoryLog = {
      finderWheres: [],
      builderConditions: [],
      builderParameters: [],
    };
    const contributor = new ForumActivityExportContributor(
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      recordingRepository(pollLog, [
        {
          id: 'poll-1',
          threadId: 'thread-1',
          allowMultiple: false,
          closesAt: null,
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      ]),
      recordingRepository(undefined, [
        { pollId: 'poll-1', label: 'Saturday', position: 0, voteCount: 4 },
        { pollId: 'poll-1', label: 'Sunday', position: 1, voteCount: 2 },
        { pollId: 'poll-2', label: 'Elsewhere', position: 0, voteCount: 9 },
      ]),
    );

    const result = await contributor.buildContribution(MEMBER_ID);

    expect(pollLog.builderConditions).toEqual(['thread.authorId = :userId']);
    expect(result).toEqual([
      {
        type: 'poll',
        id: 'poll-1',
        threadId: 'thread-1',
        allowMultiple: false,
        closesAt: null,
        options: [
          { label: 'Saturday', position: 0, voteCount: 4 },
          { label: 'Sunday', position: 1, voteCount: 2 },
        ],
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('CommunityRequestsExportContributor', () => {
  it('keeps the decline reason meant for the applicant and leaves the internal note behind', async () => {
    const contributor = new CommunityRequestsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            id: 'join-1',
            communityId: 'community-1',
            userId: 'user-1',
            note: 'I run the book swap',
            involvement: 'participate',
            status: 'declined',
            declineKind: 'not_right_now',
            declineReason: 'We are full this month',
            reapplyAfter: null,
            claimedByUserId: 'moderator-1',
            claimedAt: new Date('2026-01-02T00:00:00.000Z'),
            internalNote: 'moderator-only context',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      }),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
    );

    const [row] = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(row).toMatchObject({
      type: 'joinRequest',
      note: 'I run the book swap',
      declineReason: 'We are full this month',
      reapplyAfter: null,
    });
    expect(row).not.toHaveProperty('internalNote');
    expect(row).not.toHaveProperty('claimedByUserId');
  });
});

describe('EventParticipationExportContributor', () => {
  it("keeps the member's own co-host invite message and drops the inviter's", async () => {
    const createdAt = new Date('2026-04-01T00:00:00.000Z');
    const cohostInviteFind = jest.fn().mockResolvedValue([
      {
        eventId: 'event-1',
        inviterId: 'user-1',
        inviteeId: 'member-2',
        role: 'Door',
        commitment: 'Two hours',
        message: 'Would love your help',
        replyByDate: null,
        status: 'pending',
        createdAt,
      },
      {
        eventId: 'event-2',
        inviterId: 'member-3',
        inviteeId: 'user-1',
        role: 'Host',
        commitment: 'All evening',
        message: "member-3's own words",
        replyByDate: null,
        status: 'pending',
        createdAt,
      },
    ]);
    const contributor = new EventParticipationExportContributor(
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      repositoryWith({ find: cohostInviteFind }),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
    );

    const result = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(cohostInviteFind).toHaveBeenCalledWith({
      where: [{ inviterId: 'user-1' }, { inviteeId: 'user-1' }],
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      expect.objectContaining({
        direction: 'sent',
        counterpartyId: 'member-2',
        message: 'Would love your help',
      }),
      expect.objectContaining({
        direction: 'received',
        counterpartyId: 'member-3',
        message: null,
      }),
    ]);
  });
});

describe('InvitesSentExportContributor', () => {
  it('leaves the invite code and the invitee email out of the archive', async () => {
    const contributor = new InvitesSentExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            id: 'invite-1',
            inviterId: 'user-1',
            code: 'SECRET-CODE',
            email: 'friend@example.com',
            note: 'See you there',
            vouch: 'Known them for years',
            personal: true,
            status: 'accepted',
            acceptedBy: 'member-9',
            usedAt: new Date('2026-05-02T00:00:00.000Z'),
            expiresAt: null,
            createdAt: new Date('2026-05-01T00:00:00.000Z'),
          },
        ]),
      }),
    );

    const [row] = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(row).toMatchObject({
      vouch: 'Known them for years',
      acceptedByUserId: 'member-9',
      usedAt: '2026-05-02T00:00:00.000Z',
      expiresAt: null,
    });
    expect(JSON.stringify(row)).not.toContain('SECRET-CODE');
    expect(JSON.stringify(row)).not.toContain('friend@example.com');
  });
});

describe('SavedListsExportContributor', () => {
  it('groups saved item ids under their list and reports sharing without the token', async () => {
    const contributor = new SavedListsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            id: 'list-1',
            userId: 'user-1',
            name: 'Weekend',
            isDefault: false,
            shareToken: 'share-token-value',
            sharedAt: new Date('2026-06-02T00:00:00.000Z'),
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
            updatedAt: new Date('2026-06-02T00:00:00.000Z'),
          },
        ]),
      }),
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          { listId: 'list-1', savedItemId: 'saved-1' },
          { listId: 'list-1', savedItemId: 'saved-2' },
        ]),
      }),
    );

    const [row] = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(row).toMatchObject({
      isShared: true,
      savedItemIds: ['saved-1', 'saved-2'],
    });
    expect(JSON.stringify(row)).not.toContain('share-token-value');
  });
});

describe('GovernanceActivityExportContributor', () => {
  const nomination = (overrides: Record<string, unknown>) => ({
    id: 'nomination-1',
    nominatorId: 'user-1',
    nomineeName: 'Rui',
    nomineeUserId: null,
    nomineeContact: 'rui@example.com',
    reason: 'Runs the food bank',
    status: 'pending',
    reviewedBy: 'staff-1',
    reviewNote: 'staff-only note',
    reviewedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  });

  it("names a member nominee by id alone and never carries a nominee's contact", async () => {
    const contributor = new GovernanceActivityExportContributor(
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      repositoryWith({
        find: jest
          .fn()
          .mockResolvedValue([
            nomination({}),
            nomination({ id: 'nomination-2', nomineeUserId: 'member-4' }),
          ]),
      }),
      emptyRepository(),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => [row.nomineeUserId, row.nomineeName])).toEqual([
      [null, 'Rui'],
      ['member-4', null],
    ]);
    expect(JSON.stringify(rows)).not.toContain('rui@example.com');
    expect(JSON.stringify(rows)).not.toContain('staff-only note');
  });
});

describe('CardScansExportContributor', () => {
  it('skips the scan query for a member who holds no card', async () => {
    const scanFind = jest.fn();
    const contributor = new CardScansExportContributor(
      emptyRepository(),
      repositoryWith({ find: scanFind }),
    );

    expect(await contributor.buildContribution('user-1')).toEqual([]);
    expect(scanFind).not.toHaveBeenCalled();
  });

  it("lists the scans of the member's cards without the scanning host", async () => {
    const scanFind = jest.fn().mockResolvedValue([
      {
        id: 'scan-1',
        cardId: 'card-1',
        eventId: 'event-1',
        scannedByUserId: 'host-1',
        result: 'valid',
        scannedAt: new Date('2026-08-01T20:00:00.000Z'),
      },
    ]);
    const contributor = new CardScansExportContributor(
      repositoryWith({ find: jest.fn().mockResolvedValue([{ id: 'card-1' }]) }),
      repositoryWith({ find: scanFind }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(scanFind).toHaveBeenCalledWith({
      where: { cardId: In(['card-1']) },
      order: { scannedAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'scan-1',
        cardId: 'card-1',
        eventId: 'event-1',
        result: 'valid',
        scannedAt: '2026-08-01T20:00:00.000Z',
      },
    ]);
  });
});

describe('ListingActivityExportContributor', () => {
  it("exports a listing draft's content and leaves its resume token behind", async () => {
    const contributor = new ListingActivityExportContributor(
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      emptyRepository(),
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            id: 'draft-1',
            userId: 'user-1',
            payload: { name: 'Café Lume' },
            resumeToken: 'resume-token-value',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
            updatedAt: new Date('2026-09-02T00:00:00.000Z'),
          },
        ]),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        type: 'draft',
        id: 'draft-1',
        payload: { name: 'Café Lume' },
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    ]);
  });
});

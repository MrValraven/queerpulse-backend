import { Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { FlatmateLikeDecision } from '../flatmate-profiles/entities/flatmate-like.entity';
import {
  FlatmateLikesExportContributor,
  HiddenMembersExportContributor,
  HousingSavedSearchesExportContributor,
  MutesExportContributor,
  NotificationPreferencesExportContributor,
  PolicyStatusExportContributor,
  PushDevicesExportContributor,
  SessionsExportContributor,
} from './data-export-contributors-account';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

/** A repository stub exposing only the given finder methods. */
function repositoryWith<Entity extends object>(
  methods: Partial<Record<'find' | 'findOne', jest.Mock>>,
): Repository<Entity> {
  return methods as unknown as Repository<Entity>;
}

describe('ENG-495 account contributor registration', () => {
  it('registers every account contributor in NEW_DOMAIN_EXPORT_CONTRIBUTORS', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toEqual(
      expect.arrayContaining([
        SessionsExportContributor,
        PushDevicesExportContributor,
        NotificationPreferencesExportContributor,
        MutesExportContributor,
        HiddenMembersExportContributor,
        FlatmateLikesExportContributor,
        HousingSavedSearchesExportContributor,
        PolicyStatusExportContributor,
      ]),
    );
  });

  it('uses the category ids and archive keys the frontend builds against, each with a csv file', () => {
    const pairs = [
      new SessionsExportContributor(repositoryWith({})),
      new PushDevicesExportContributor(repositoryWith({})),
      new NotificationPreferencesExportContributor(
        repositoryWith({}),
        repositoryWith({}),
      ),
      new MutesExportContributor(repositoryWith({})),
      new HiddenMembersExportContributor(repositoryWith({})),
      new FlatmateLikesExportContributor(repositoryWith({})),
      new HousingSavedSearchesExportContributor(repositoryWith({})),
      new PolicyStatusExportContributor(repositoryWith({})),
    ].map((contributor) => [contributor.category, contributor.archiveKey]);

    expect(pairs).toEqual([
      ['activityLog', 'sessions'],
      ['notifications', 'pushDevices'],
      ['notifications', 'notificationPreferences'],
      ['connections', 'mutes'],
      ['connections', 'hiddenMembers'],
      ['housing', 'flatmateLikes'],
      ['housing', 'savedSearches'],
      ['consent', 'policyStatus'],
    ]);
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    for (const [, archiveKey] of pairs) {
      expect(csvKeys).toContain(archiveKey);
    }
  });
});

describe('SessionsExportContributor', () => {
  const tokenRow = (overrides: Partial<RefreshToken>): RefreshToken =>
    ({
      id: 'token-1',
      familyId: 'family-1',
      deviceLabel: 'Firefox on Linux',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0',
      sessionStartedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: null,
      expiresAt: new Date('2026-01-31T00:00:00.000Z'),
      revokedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as RefreshToken;

  it('reads only the columns that describe a session, leaving the token hash in the database', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new SessionsExportContributor(repositoryWith({ find }));

    await contributor.buildContribution('user-1');

    const [options] = find.mock.calls[0] as [
      { select: Record<string, boolean>; where: unknown },
    ];
    expect(options.where).toEqual({ userId: 'user-1' });
    expect(options.select).not.toHaveProperty('tokenHash');
    expect(options.select).not.toHaveProperty('replacedBy');
  });

  it('folds each token family into one session described by its newest row', async () => {
    const contributor = new SessionsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          tokenRow({
            id: 'token-1',
            revokedAt: new Date('2026-01-01T00:15:00.000Z'),
          }),
          tokenRow({
            id: 'token-2',
            createdAt: new Date('2026-01-01T00:15:00.000Z'),
            lastSeenAt: new Date('2026-01-01T00:15:00.000Z'),
            revokedAt: new Date('2026-01-02T09:00:00.000Z'),
          }),
        ]),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        id: 'token-2',
        deviceLabel: 'Firefox on Linux',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/130.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-01-01T00:15:00.000Z',
        expiresAt: '2026-01-31T00:00:00.000Z',
        revokedAt: '2026-01-02T09:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('family-1');
  });

  it('orders sessions by when they began and falls back to the mint time for last use', async () => {
    const contributor = new SessionsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          tokenRow({
            id: 'late-session',
            familyId: 'family-late',
            sessionStartedAt: new Date('2026-03-01T00:00:00.000Z'),
            createdAt: new Date('2026-03-05T00:00:00.000Z'),
          }),
          tokenRow({
            id: 'early-session',
            familyId: 'family-early',
            sessionStartedAt: new Date('2026-02-01T00:00:00.000Z'),
            createdAt: new Date('2026-03-06T00:00:00.000Z'),
          }),
        ]),
      }),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => [row.id, row.lastUsedAt])).toEqual([
      ['early-session', '2026-03-06T00:00:00.000Z'],
      ['late-session', '2026-03-05T00:00:00.000Z'],
    ]);
  });
});

describe('PushDevicesExportContributor', () => {
  it('never reads the endpoint or keys', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new PushDevicesExportContributor(
      repositoryWith({ find }),
    );

    await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      select: { id: true, userAgent: true, createdAt: true, lastUsedAt: true },
      where: { userId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
  });

  it('exports each device with a readable label and a null last use when unset', async () => {
    const contributor = new PushDevicesExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            id: 'push-1',
            userAgent: null,
            createdAt: new Date('2026-04-01T00:00:00.000Z'),
            lastUsedAt: null,
          },
        ]),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        id: 'push-1',
        deviceLabel: null,
        userAgent: null,
        createdAt: '2026-04-01T00:00:00.000Z',
        lastUsedAt: null,
      },
    ]);
  });
});

describe('NotificationPreferencesExportContributor', () => {
  it('exports the category switches and the quiet hours as stored', async () => {
    const contributor = new NotificationPreferencesExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          {
            userId: 'user-1',
            category: 'messages',
            inApp: true,
            push: false,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ]),
      }),
      repositoryWith({
        findOne: jest.fn().mockResolvedValue({
          userId: 'user-1',
          isQuietHoursEnabled: true,
          quietHoursStartMinute: 1320,
          quietHoursEndMinute: 480,
          timeZone: 'Europe/Lisbon',
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          updatedAt: new Date('2026-01-04T00:00:00.000Z'),
        }),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        type: 'category',
        category: 'messages',
        inApp: true,
        push: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        type: 'delivery',
        isQuietHoursEnabled: true,
        quietHoursStartMinute: 1320,
        quietHoursEndMinute: 480,
        timeZone: 'Europe/Lisbon',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
    ]);
  });

  it('leaves out the delivery row when quiet hours were never set', async () => {
    const contributor = new NotificationPreferencesExportContributor(
      repositoryWith({ find: jest.fn().mockResolvedValue([]) }),
      repositoryWith({ findOne: jest.fn().mockResolvedValue(null) }),
    );

    await expect(contributor.buildContribution('user-1')).resolves.toEqual([]);
  });
});

describe('MutesExportContributor', () => {
  it('reads only the mutes the member placed', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'mute-1',
        muterId: 'user-1',
        mutedId: 'other-1',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
    const contributor = new MutesExportContributor(repositoryWith({ find }));

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { muterId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'mute-1',
        mutedUserId: 'other-1',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('HiddenMembersExportContributor', () => {
  it('reads only the hides the member placed', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'hidden-1',
        ownerId: 'user-1',
        hiddenFromUserId: 'other-1',
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
      },
    ]);
    const contributor = new HiddenMembersExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { ownerId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'hidden-1',
        hiddenFromUserId: 'other-1',
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('FlatmateLikesExportContributor', () => {
  it('reads only the decisions the member made', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'like-1',
        fromUserId: 'user-1',
        toProfileId: 'profile-9',
        decision: FlatmateLikeDecision.Like,
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        updatedAt: new Date('2026-05-04T00:00:00.000Z'),
      },
    ]);
    const contributor = new FlatmateLikesExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { fromUserId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'like-1',
        toProfileId: 'profile-9',
        decision: FlatmateLikeDecision.Like,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
      },
    ]);
  });
});

describe('HousingSavedSearchesExportContributor', () => {
  it("exports the member's saved searches with their criteria", async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'search-1',
        memberId: 'user-1',
        name: 'Arroios under 700',
        criteria: { city: 'Lisboa', maxRentEuros: 700 },
        alertsEnabled: true,
        createdAt: new Date('2026-05-05T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
      },
    ]);
    const contributor = new HousingSavedSearchesExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { memberId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'search-1',
        name: 'Arroios under 700',
        criteria: { city: 'Lisboa', maxRentEuros: 700 },
        alertsEnabled: true,
        createdAt: '2026-05-05T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:00.000Z',
      },
    ]);
  });
});

describe('PolicyStatusExportContributor', () => {
  it('reads only the policy stamps from the users row', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const contributor = new PolicyStatusExportContributor(
      repositoryWith({ findOne }),
    );

    await expect(contributor.buildContribution('user-1')).resolves.toBeNull();
    expect(findOne).toHaveBeenCalledWith({
      select: {
        id: true,
        termsVersion: true,
        ageAttestedAt: true,
        guidelinesVersion: true,
        guidelinesAcceptedAt: true,
        affirmingPledgeAcceptedAt: true,
        underAgeDisclosedAt: true,
      },
      where: { id: 'user-1' },
    });
  });

  it('exports the stamps as ISO dates and keeps unset ones null', async () => {
    const contributor = new PolicyStatusExportContributor(
      repositoryWith({
        findOne: jest.fn().mockResolvedValue({
          id: 'user-1',
          termsVersion: '2.4',
          ageAttestedAt: new Date('2026-01-01T00:00:00.000Z'),
          guidelinesVersion: '1.0',
          guidelinesAcceptedAt: new Date('2026-01-02T00:00:00.000Z'),
          affirmingPledgeAcceptedAt: null,
          underAgeDisclosedAt: null,
        }),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual({
      termsVersion: '2.4',
      ageAttestedAt: '2026-01-01T00:00:00.000Z',
      guidelinesVersion: '1.0',
      guidelinesAcceptedAt: '2026-01-02T00:00:00.000Z',
      affirmingPledgeAcceptedAt: null,
      underAgeDisclosedAt: null,
    });
  });
});

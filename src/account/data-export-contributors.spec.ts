import { Repository } from 'typeorm';
import { EventMatchEntry } from '../go-together/entities/event-match-entry.entity';
import { FriendMatchProfile } from '../go-together/entities/friend-match-profile.entity';
import { MatchAvoidance } from '../go-together/entities/match-avoidance.entity';
import { MatchFeedback } from '../go-together/entities/match-feedback.entity';
import { MatchGroupFeedback } from '../go-together/entities/match-group-feedback.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { MyCardsService } from '../membership-cards/my-cards.service';
import {
  GoTogetherExportContributor,
  ListingsExportContributor,
  MembershipCardsExportContributor,
} from './data-export-contributors';

describe('ListingsExportContributor', () => {
  const listingRow = (overrides: Partial<Listing>): Listing =>
    ({
      id: 'listing-1',
      ref: 'QPL-2026-0001',
      slug: 'lux-cafe',
      name: 'Lux Café',
      status: ListingStatus.Live,
      ownerId: 'user-1',
      suggestedByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    }) as Listing;

  it('reads the listings the member owns and the ones they suggested', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: [{ ownerId: 'user-1' }, { suggestedByUserId: 'user-1' }],
      order: { createdAt: 'ASC' },
    });
  });

  it('marks each row as owned or suggested by the member', async () => {
    const find = jest.fn().mockResolvedValue([
      listingRow({ id: 'owned-listing', ownerId: 'user-1' }),
      listingRow({
        id: 'held-suggestion',
        ownerId: null,
        suggestedByUserId: 'user-1',
      }),
      listingRow({
        id: 'claimed-suggestion',
        ownerId: 'claimant-1',
        suggestedByUserId: 'user-1',
      }),
    ]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      expect.objectContaining({ id: 'owned-listing', relationship: 'owner' }),
      expect.objectContaining({
        id: 'held-suggestion',
        relationship: 'suggested',
      }),
      expect.objectContaining({
        id: 'claimed-suggestion',
        relationship: 'suggested',
      }),
    ]);
  });

  it('reports a listing the member both suggested and now owns as owned', async () => {
    const find = jest
      .fn()
      .mockResolvedValue([
        listingRow({ ownerId: 'user-1', suggestedByUserId: 'user-1' }),
      ]);
    const contributor = new ListingsExportContributor({
      find,
    } as unknown as Repository<Listing>);

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      expect.objectContaining({ relationship: 'owner' }),
    ]);
  });
});

describe('MembershipCardsExportContributor', () => {
  it('registers under the membershipCards category/archive key', () => {
    const myCards = { forUser: jest.fn() } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);
    expect(contributor.category).toBe('membershipCards');
    expect(contributor.archiveKey).toBe('membershipCards');
  });

  it("includes the caller's membership cards, delegating to MyCardsService.forUser", async () => {
    const cards = [
      {
        id: 'card-1',
        serial: 'AQ-7K4M2',
        status: 'active',
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        communityName: 'Azores Queer',
        communitySlug: 'azores-queer',
        role: 'member',
        holderName: 'Anika Kovač',
        program: {
          isEnabled: true,
          skin: 'plum',
          accentToken: 'accent',
          crestUrl: null,
          cardName: 'Sócie',
          validityMonths: null,
          allowsPrint: false,
          allowsWallet: false,
          allowsPublicBadge: true,
          serialPrefix: 'AQ',
        },
      },
    ];
    const forUser = jest.fn().mockResolvedValue(cards);
    const myCards = { forUser } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    const result = await contributor.buildContribution('user-1');

    expect(forUser).toHaveBeenCalledWith('user-1');
    expect(result).toEqual([
      expect.objectContaining({
        serial: 'AQ-7K4M2',
        communitySlug: 'azores-queer',
      }),
    ]);
  });

  it('returns an empty archive for a member holding no cards', async () => {
    const myCards = {
      forUser: jest.fn().mockResolvedValue([]),
    } as unknown as MyCardsService;
    const contributor = new MembershipCardsExportContributor(myCards);

    await expect(contributor.buildContribution('user-2')).resolves.toEqual([]);
  });
});

describe('GoTogetherExportContributor', () => {
  const USER_ID = 'user-1';

  function build(overrides: {
    profile?: FriendMatchProfile | null;
    entries?: EventMatchEntry[];
    given?: MatchFeedback[];
    groupAnswers?: MatchGroupFeedback[];
    avoided?: MatchAvoidance[];
  }) {
    const findOneProfile = jest
      .fn()
      .mockResolvedValue(overrides.profile ?? null);
    const findEntries = jest.fn().mockResolvedValue(overrides.entries ?? []);
    const findFeedback = jest.fn().mockResolvedValue(overrides.given ?? []);
    const findGroupFeedback = jest
      .fn()
      .mockResolvedValue(overrides.groupAnswers ?? []);
    const findAvoidances = jest.fn().mockResolvedValue(overrides.avoided ?? []);
    const contributor = new GoTogetherExportContributor(
      { findOne: findOneProfile } as unknown as Repository<FriendMatchProfile>,
      { find: findEntries } as unknown as Repository<EventMatchEntry>,
      { find: findFeedback } as unknown as Repository<MatchFeedback>,
      { find: findGroupFeedback } as unknown as Repository<MatchGroupFeedback>,
      { find: findAvoidances } as unknown as Repository<MatchAvoidance>,
    );
    return {
      contributor,
      findOneProfile,
      findEntries,
      findFeedback,
      findGroupFeedback,
      findAvoidances,
    };
  }

  it('registers under the goTogether category and go-together archive key', () => {
    const { contributor } = build({});
    expect(contributor.category).toBe('goTogether');
    expect(contributor.archiveKey).toBe('go-together');
  });

  it('reads only rows keyed to the requesting member', async () => {
    const {
      contributor,
      findOneProfile,
      findEntries,
      findFeedback,
      findGroupFeedback,
      findAvoidances,
    } = build({});

    await contributor.buildContribution(USER_ID);

    expect(findOneProfile).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    expect(findEntries).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findFeedback).toHaveBeenCalledWith({
      where: { raterId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findGroupFeedback).toHaveBeenCalledWith({
      where: { raterId: USER_ID },
      order: { createdAt: 'ASC' },
    });
    expect(findAvoidances).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      order: { createdAt: 'ASC' },
    });
  });

  it('returns the questionnaire as null when the member never filled one in', async () => {
    const { contributor } = build({ profile: null });

    const result = (await contributor.buildContribution(USER_ID)) as {
      questionnaire: unknown;
    };

    expect(result.questionnaire).toBeNull();
  });

  it('includes the questionnaire answers and consent timestamp when a profile exists', async () => {
    const profile = {
      userId: USER_ID,
      answers: { area: 'Arroios' },
      questionnaireVersion: 3,
      consentedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    } as unknown as FriendMatchProfile;
    const { contributor } = build({ profile });

    const result = (await contributor.buildContribution(USER_ID)) as {
      questionnaire: unknown;
    };

    expect(result.questionnaire).toEqual({
      answers: { area: 'Arroios' },
      questionnaireVersion: 3,
      consentedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('maps each opt-in with lensConsentedAt, checkedInAt and leftEventAt', async () => {
    const entry = {
      eventId: 'event-1',
      status: 'grouped',
      pairStatus: 'accepted',
      lens: 'exclude',
      lensConsentedAt: new Date('2026-02-01T00:00:00.000Z'),
      hostAnswers: { q1: 'answer' },
      groupId: 'group-1',
      checkedInAt: new Date('2026-02-02T18:00:00.000Z'),
      leftEventAt: new Date('2026-02-02T22:00:00.000Z'),
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    } as unknown as EventMatchEntry;
    const { contributor } = build({ entries: [entry] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      optIns: unknown[];
    };

    expect(result.optIns).toEqual([
      {
        eventId: 'event-1',
        status: 'grouped',
        pairStatus: 'accepted',
        lens: 'exclude',
        lensConsentedAt: '2026-02-01T00:00:00.000Z',
        hostAnswers: { q1: 'answer' },
        groupId: 'group-1',
        checkedInAt: '2026-02-02T18:00:00.000Z',
        leftEventAt: '2026-02-02T22:00:00.000Z',
        createdAt: '2026-01-15T00:00:00.000Z',
      },
    ]);
  });

  it('maps an opt-in that was never checked in or left as null timestamps', async () => {
    const entry = {
      eventId: 'event-1',
      status: 'waiting',
      pairStatus: 'none',
      lens: null,
      lensConsentedAt: null,
      hostAnswers: {},
      groupId: null,
      checkedInAt: null,
      leftEventAt: null,
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    } as unknown as EventMatchEntry;
    const { contributor } = build({ entries: [entry] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      optIns: Array<{
        lensConsentedAt: unknown;
        checkedInAt: unknown;
        leftEventAt: unknown;
      }>;
    };

    expect(result.optIns[0]).toMatchObject({
      lensConsentedAt: null,
      checkedInAt: null,
      leftEventAt: null,
    });
  });

  it('lists the meet-again verdicts this member gave, attributed to the other person', async () => {
    const given = {
      groupId: 'group-1',
      raterId: USER_ID,
      rateeId: 'user-other',
      verdict: 'yes',
      createdAt: new Date('2026-02-03T00:00:00.000Z'),
      updatedAt: new Date('2026-02-03T00:00:00.000Z'),
    } as unknown as MatchFeedback;
    const { contributor, findFeedback } = build({ given: [given] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      meetAgainAnswersGiven: unknown[];
    };

    expect(findFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ where: { raterId: USER_ID } }),
    );
    expect(result.meetAgainAnswersGiven).toEqual([
      {
        groupId: 'group-1',
        aboutUserId: 'user-other',
        verdict: 'yes',
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
    ]);
  });

  it('lists the group-as-a-whole answers this member gave', async () => {
    const groupAnswer = {
      groupId: 'group-1',
      raterId: USER_ID,
      clicked: 'yes',
      goAgain: true,
      createdAt: new Date('2026-02-04T00:00:00.000Z'),
      updatedAt: new Date('2026-02-04T00:00:00.000Z'),
    } as unknown as MatchGroupFeedback;
    const { contributor } = build({ groupAnswers: [groupAnswer] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      groupAnswersGiven: unknown[];
    };

    expect(result.groupAnswersGiven).toEqual([
      {
        groupId: 'group-1',
        clicked: 'yes',
        goAgain: true,
        updatedAt: '2026-02-04T00:00:00.000Z',
      },
    ]);
  });

  it('lists the "Not for me" avoidances this member set', async () => {
    const avoided = {
      userId: USER_ID,
      avoidedUserId: 'user-avoided',
      createdAt: new Date('2026-02-05T00:00:00.000Z'),
    } as unknown as MatchAvoidance;
    const { contributor } = build({ avoided: [avoided] });

    const result = (await contributor.buildContribution(USER_ID)) as {
      notForMe: unknown[];
    };

    expect(result.notForMe).toEqual([
      { userId: 'user-avoided', createdAt: '2026-02-05T00:00:00.000Z' },
    ]);
  });
});

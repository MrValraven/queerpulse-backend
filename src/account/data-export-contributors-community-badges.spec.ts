import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import {
  CommunityBadgesExportContributor,
  CommunityEventsAttendedExportContributor,
  CommunityGiftsReceivedExportContributor,
  CommunityGiftsSentExportContributor,
} from './data-export-contributors-community-badges';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const USER_ID = '73000000-0000-4000-8000-000000000013';

describe('community badges export contributors', () => {
  let query: jest.Mock;
  let dataSource: DataSource;
  let badgesContributor: CommunityBadgesExportContributor;
  let eventsAttendedContributor: CommunityEventsAttendedExportContributor;
  let giftsReceivedContributor: CommunityGiftsReceivedExportContributor;
  let giftsSentContributor: CommunityGiftsSentExportContributor;

  beforeEach(() => {
    query = jest.fn();
    dataSource = { query } as unknown as DataSource;
    badgesContributor = new CommunityBadgesExportContributor(dataSource);
    eventsAttendedContributor = new CommunityEventsAttendedExportContributor(
      dataSource,
    );
    giftsReceivedContributor = new CommunityGiftsReceivedExportContributor(
      dataSource,
    );
    giftsSentContributor = new CommunityGiftsSentExportContributor(dataSource);
  });

  it('rides on communities under four keys appended after quizshowGames', () => {
    for (const contributor of [
      badgesContributor,
      eventsAttendedContributor,
      giftsReceivedContributor,
      giftsSentContributor,
    ]) {
      expect(contributor.category).toBe('communities');
    }
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    const start = csvKeys.indexOf('quizshowGames');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(csvKeys.slice(start + 1, start + 5)).toEqual([
      'communityBadges',
      'communityEventsAttended',
      'communityGiftsReceived',
      'communityGiftsSent',
    ]);
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toEqual(
      expect.arrayContaining([
        CommunityBadgesExportContributor,
        CommunityEventsAttendedExportContributor,
        CommunityGiftsReceivedExportContributor,
        CommunityGiftsSentExportContributor,
      ]),
    );
    expect([
      badgesContributor.archiveKey,
      eventsAttendedContributor.archiveKey,
      giftsReceivedContributor.archiveKey,
      giftsSentContributor.archiveKey,
    ]).toEqual([
      'communityBadges',
      'communityEventsAttended',
      'communityGiftsReceived',
      'communityGiftsSent',
    ]);
  });

  it('lists the four contributors in order beside the quizshow games', () => {
    const order = [
      CommunityBadgesExportContributor,
      CommunityEventsAttendedExportContributor,
      CommunityGiftsReceivedExportContributor,
      CommunityGiftsSentExportContributor,
    ].map((contributorClass) =>
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(contributorClass),
    );
    const [badgesAt = -1] = order;
    expect(badgesAt).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([badgesAt, badgesAt + 1, badgesAt + 2, badgesAt + 3]);
  });

  it('writes the events attended tally for each community the member is in', async () => {
    query.mockResolvedValueOnce([
      {
        community_id: 'c1',
        slug: 'night-swim',
        name: 'Night swim',
        events_attended_count: 4,
      },
    ]);
    expect(await eventsAttendedContributor.buildContribution(USER_ID)).toEqual([
      {
        communityId: 'c1',
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        eventsAttended: 4,
      },
    ]);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('"m"."user_id" = $1');
    expect(call[0]).toContain('ORDER BY "m"."joined_at", "m"."id"');
    expect(call[1]).toEqual([USER_ID]);
  });

  it('writes earned badges with the worn flag', async () => {
    query.mockResolvedValueOnce([
      {
        community_id: 'c1',
        community_slug: 'night-swim',
        community_name: 'Night swim',
        badge_id: 'b1',
        badge_name: 'Regular',
        icon_key: 'star',
        tint: 'coral',
        rule_type: 'events_checked_in',
        threshold: 5,
        is_enabled: true,
        awarded_at: new Date('2026-11-01T10:00:00.000Z'),
        is_worn: true,
      },
    ]);
    expect(await badgesContributor.buildContribution(USER_ID)).toEqual([
      {
        communityId: 'c1',
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        badgeId: 'b1',
        badgeName: 'Regular',
        iconKey: 'star',
        tint: 'coral',
        ruleType: 'events_checked_in',
        threshold: 5,
        isEnabled: true,
        awardedAt: '2026-11-01T10:00:00.000Z',
        isWorn: true,
      },
    ]);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('"a"."user_id" = $1');
    expect(call[0]).toContain(
      'COALESCE("m"."worn_badge_id" = "b"."id", false)',
    );
    expect(call[1]).toEqual([USER_ID]);
  });

  it('names an erased sender as null on a received gift', async () => {
    query.mockResolvedValueOnce([
      {
        id: 'g1',
        community_id: 'c1',
        community_slug: 'night-swim',
        community_name: 'Night swim',
        gift_key: 'flower',
        note: 'Thank you for the help',
        sender_name: null,
        sent_at: new Date('2026-11-02T09:00:00.000Z'),
        hidden_at: new Date('2026-11-03T09:00:00.000Z'),
        removed_at: null,
      },
    ]);
    expect(await giftsReceivedContributor.buildContribution(USER_ID)).toEqual([
      {
        id: 'g1',
        communityId: 'c1',
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        giftKey: 'flower',
        note: 'Thank you for the help',
        senderName: null,
        sentAt: '2026-11-02T09:00:00.000Z',
        hiddenAt: '2026-11-03T09:00:00.000Z',
        removedAt: null,
      },
    ]);
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('"g"."recipient_id" = $1');
    expect(call[0]).toContain('LEFT JOIN "profiles" "p"');
  });

  it('lists sent gifts by sender only', async () => {
    query.mockResolvedValueOnce([
      {
        id: 'g2',
        community_id: 'c1',
        community_slug: 'night-swim',
        community_name: 'Night swim',
        gift_key: 'flower',
        note: null,
        sent_at: new Date('2026-11-04T09:00:00.000Z'),
        removed_at: new Date('2026-11-05T09:00:00.000Z'),
      },
    ]);
    const rows = await giftsSentContributor.buildContribution(USER_ID);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"g"."sender_id" = $1'),
      [USER_ID],
    );
    expect(rows).toEqual([
      {
        id: 'g2',
        communityId: 'c1',
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        giftKey: 'flower',
        note: null,
        sentAt: '2026-11-04T09:00:00.000Z',
        removedAt: '2026-11-05T09:00:00.000Z',
      },
    ]);
    expect(Object.keys((rows as object[])[0] ?? {})).not.toContain(
      'recipientId',
    );
  });
});

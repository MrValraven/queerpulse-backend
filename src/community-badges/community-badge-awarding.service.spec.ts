import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import type { NotificationsService } from '../notifications/notifications.service';
import {
  COMMUNITY_FOR_AWARDING_SQL,
  CommunityBadgeAwardingService,
  ENABLED_BADGES_FOR_AWARDING_SQL,
} from './community-badge-awarding.service';
import {
  AWARD_QUALIFYING_MEMBERS_SQL,
  MARK_AWARDS_NOTIFIED_SQL,
  MEMBER_BADGE_COUNTS_SQL,
} from './community-badge-counts';

interface StagedCommunity {
  id: string;
  slug?: string;
  name?: string;
  parent_id: string | null;
}

interface StagedBadge {
  id: string;
  name: string;
  starter_key: string | null;
  icon_key: string;
  tint: string;
  backfill_requested_at: Date | null;
}

interface StagedAward {
  id: string;
  badge_id: string;
  user_id: string;
}

function badgeRow(overrides: Partial<StagedBadge> = {}): StagedBadge {
  return {
    id: 'badge-1',
    name: 'Regular',
    starter_key: 'regular',
    icon_key: 'calendar',
    tint: 'jade',
    backfill_requested_at: null,
    ...overrides,
  };
}

describe('CommunityBadgeAwardingService', () => {
  let communityRows: StagedCommunity[];
  let badgeRows: StagedBadge[];
  let insertedRows: StagedAward[];
  let countsRows: Record<string, number>[];
  let dataSource: {
    query: jest.Mock<Promise<unknown[]>, [string, unknown[]?]>;
  };
  let notifications: { createForRecipients: jest.Mock };
  let service: CommunityBadgeAwardingService;

  function stageCommunity(community: StagedCommunity): void {
    communityRows = [community];
  }
  function stageBadges(badges: StagedBadge[]): void {
    badgeRows = badges;
  }
  function stageInserted(rows: StagedAward[]): void {
    insertedRows = rows;
  }
  function queriesMatching(fragment: string): [string, unknown[]?][] {
    return dataSource.query.mock.calls.filter(([sql]) =>
      sql.includes(fragment),
    );
  }
  function answerBySqlText(
    sql: string,
    _parameters?: unknown[],
  ): Promise<unknown[]> {
    if (sql === COMMUNITY_FOR_AWARDING_SQL) {
      return Promise.resolve(communityRows);
    }
    if (sql === ENABLED_BADGES_FOR_AWARDING_SQL) {
      return Promise.resolve(badgeRows);
    }
    if (sql === AWARD_QUALIFYING_MEMBERS_SQL) {
      return Promise.resolve(insertedRows);
    }
    if (sql === MEMBER_BADGE_COUNTS_SQL) {
      return Promise.resolve(countsRows);
    }
    return Promise.resolve([]);
  }

  beforeEach(() => {
    communityRows = [
      { id: 'c1', slug: 'night-swim', name: 'Night swim', parent_id: null },
    ];
    badgeRows = [badgeRow()];
    insertedRows = [];
    countsRows = [];
    dataSource = { query: jest.fn(answerBySqlText) };
    notifications = { createForRecipients: jest.fn().mockResolvedValue([]) };
    service = new CommunityBadgeAwardingService(
      dataSource as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('awards and notifies a member crossing a threshold through new activity', async () => {
    stageCommunity({
      id: 'c1',
      slug: 'night-swim',
      name: 'Night swim',
      parent_id: null,
    });
    stageBadges([badgeRow({ id: 'badge-1', backfill_requested_at: null })]);
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    notifications.createForRecipients.mockResolvedValue(['u1']);
    expect(
      await service.evaluateMember({
        communityId: 'c1',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(1);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['u1'],
      NotificationType.CommunityBadgeEarned,
      {
        communitySlug: 'night-swim',
        communityName: 'Night swim',
        badgeId: 'badge-1',
        badgeName: 'Regular',
        starterKey: 'regular',
        iconKey: 'calendar',
        tint: 'jade',
      },
    );
    expect(dataSource.query).toHaveBeenCalledWith(MARK_AWARDS_NOTIFIED_SQL, [
      'badge-1',
      ['u1'],
    ]);
  });

  it('runs the award for one member over every enabled badge', async () => {
    await service.evaluateMember({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      AWARD_QUALIFYING_MEMBERS_SQL,
      ['c1', 'u1', null, false],
    );
  });

  it('awards a badge with a pending backfill silently on new activity', async () => {
    stageBadges([
      badgeRow({ id: 'badge-1', backfill_requested_at: new Date() }),
    ]);
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    expect(
      await service.evaluateMember({
        communityId: 'c1',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(1);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('writes no notification in silent mode', async () => {
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    await service.evaluateMember({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: false,
    });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(queriesMatching('"is_notified" = true')).toHaveLength(0);
  });

  it('runs no count for a space or a community without enabled badges', async () => {
    stageCommunity({ id: 's1', parent_id: 'c1' });
    expect(
      await service.evaluateMember({
        communityId: 's1',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(0);
    expect(
      queriesMatching('INSERT INTO "community_badge_awards"'),
    ).toHaveLength(0);

    stageCommunity({ id: 'c1', parent_id: null });
    stageBadges([]);
    expect(
      await service.evaluateMember({
        communityId: 'c1',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(0);
    expect(
      queriesMatching('INSERT INTO "community_badge_awards"'),
    ).toHaveLength(0);
  });

  it('runs no count for a missing community', async () => {
    communityRows = [];
    expect(
      await service.evaluateMember({
        communityId: 'gone',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(0);
    expect(
      queriesMatching('INSERT INTO "community_badge_awards"'),
    ).toHaveLength(0);
  });

  it('leaves is_notified false for a recipient the bell filtered', async () => {
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    notifications.createForRecipients.mockResolvedValue([]);
    await service.evaluateMember({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
    expect(dataSource.query).not.toHaveBeenCalledWith(
      MARK_AWARDS_NOTIFIED_SQL,
      expect.anything(),
    );
  });

  it('keeps the awards and logs the error class when the bell fails', async () => {
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    notifications.createForRecipients.mockRejectedValue(
      new TypeError('boom for u1'),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn');
    expect(
      await service.evaluateMember({
        communityId: 'c1',
        userId: 'u1',
        shouldNotify: true,
      }),
    ).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'Community badge notification failed for community c1: TypeError',
    );
  });

  it('passes the badge filter and readiness flag to the batch award', async () => {
    await service.awardCommunity({
      communityId: 'c1',
      badgeIds: ['badge-1'],
      shouldNotify: false,
      onlyReadyBadges: false,
    });
    expect(dataSource.query).toHaveBeenCalledWith(
      AWARD_QUALIFYING_MEMBERS_SQL,
      ['c1', null, ['badge-1'], false],
    );
  });

  it('groups a batch award into one notification per badge', async () => {
    stageBadges([
      badgeRow({ id: 'badge-1' }),
      badgeRow({
        id: 'badge-2',
        name: 'Old friend',
        starter_key: 'old_friend',
        icon_key: 'clock',
        tint: 'plum',
      }),
    ]);
    stageInserted([
      { id: 'award-1', badge_id: 'badge-1', user_id: 'u1' },
      { id: 'award-2', badge_id: 'badge-1', user_id: 'u2' },
      { id: 'award-3', badge_id: 'badge-2', user_id: 'u1' },
    ]);
    notifications.createForRecipients.mockImplementation((userIds: string[]) =>
      Promise.resolve(userIds),
    );
    expect(
      await service.awardCommunity({
        communityId: 'c1',
        badgeIds: null,
        shouldNotify: true,
        onlyReadyBadges: true,
      }),
    ).toBe(3);
    expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['u1', 'u2'],
      NotificationType.CommunityBadgeEarned,
      expect.objectContaining({ badgeId: 'badge-1' }),
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['u1'],
      NotificationType.CommunityBadgeEarned,
      expect.objectContaining({ badgeId: 'badge-2', badgeName: 'Old friend' }),
    );
    expect(dataSource.query).toHaveBeenCalledWith(MARK_AWARDS_NOTIFIED_SQL, [
      'badge-1',
      ['u1', 'u2'],
    ]);
    expect(dataSource.query).toHaveBeenCalledWith(MARK_AWARDS_NOTIFIED_SQL, [
      'badge-2',
      ['u1'],
    ]);
  });

  it('runs every query of a batch award on the given manager and stays silent', async () => {
    stageInserted([{ id: 'award-1', badge_id: 'badge-1', user_id: 'u1' }]);
    notifications.createForRecipients.mockResolvedValue(['u1']);
    const manager = { query: jest.fn() };
    manager.query.mockImplementation(answerBySqlText);
    expect(
      await service.awardCommunity(
        {
          communityId: 'c1',
          badgeIds: null,
          shouldNotify: true,
          onlyReadyBadges: true,
        },
        manager,
      ),
    ).toBe(1);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(AWARD_QUALIFYING_MEMBERS_SQL, [
      'c1',
      null,
      null,
      true,
    ]);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalledWith(
      MARK_AWARDS_NOTIFIED_SQL,
      expect.anything(),
    );
  });

  it('reads member counts as numbers and null off the roster', async () => {
    countsRows = [
      {
        tenure_days: 400,
        events_checked_in: 2,
        volunteer_hours: 7,
        posts_and_replies: 11,
      },
    ];
    expect(await service.memberCounts('c1', 'u1')).toEqual({
      tenureDays: 400,
      eventsCheckedIn: 2,
      volunteerHours: 7,
      postsAndReplies: 11,
    });
    expect(dataSource.query).toHaveBeenCalledWith(MEMBER_BADGE_COUNTS_SQL, [
      'c1',
      'u1',
    ]);

    countsRows = [];
    expect(await service.memberCounts('c1', 'u2')).toBeNull();
  });
});

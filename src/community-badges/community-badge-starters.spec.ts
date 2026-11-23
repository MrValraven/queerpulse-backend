import {
  COMMUNITY_BADGE_STARTER_INSERT_SQL,
  seedCommunityBadgeStarters,
} from './community-badge-starters';

describe('seedCommunityBadgeStarters', () => {
  it('seeds the four starters in one statement, in catalogue order', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await seedCommunityBadgeStarters(manager, 'c1');
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.query).toHaveBeenCalledWith(
      COMMUNITY_BADGE_STARTER_INSERT_SQL,
      [
        'c1',
        ['regular', 'old_friend', 'helping_hands', 'in_the_conversation'],
        ['Regular', 'Old friend', 'Helping hands', 'In the conversation'],
        ['calendar', 'clock', 'life_buoy', 'message_circle'],
        ['jade', 'plum', 'amber', 'accent'],
        [
          'events_checked_in',
          'tenure_days',
          'volunteer_hours',
          'posts_and_replies',
        ],
        [3, 365, 5, 10],
        [0, 1, 2, 3],
      ],
    );
  });

  it('marks every starter for a silent backfill and skips existing rows', () => {
    const sql = COMMUNITY_BADGE_STARTER_INSERT_SQL.replace(/\s+/g, ' ');
    expect(sql).toContain('true, NULL, now(),');
    expect(sql).toContain('::"community_badges_rule_type_enum"');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });
});

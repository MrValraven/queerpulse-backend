import {
  AWARD_QUALIFYING_MEMBERS_SQL,
  COMMUNITY_MEMBER_COUNTS_CTE,
  MARK_AWARDS_NOTIFIED_SQL,
  MEMBER_BADGE_COUNTS_SQL,
  progressForRule,
} from './community-badge-counts';
import { CommunityBadgeRuleType } from './community-badges.catalog';

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('community badge counts', () => {
  it.each([
    ['tenure_days', 400],
    ['events_checked_in', 2],
    ['volunteer_hours', 7],
    ['posts_and_replies', 11],
  ])('reads the %s count', (ruleType, expected) => {
    expect(
      progressForRule(
        {
          tenureDays: 400,
          eventsCheckedIn: 2,
          volunteerHours: 7,
          postsAndReplies: 11,
        },
        ruleType as CommunityBadgeRuleType,
      ),
    ).toBe(expected);
  });

  it('counts only top-level communities, live content and the attendance tally', () => {
    const sql = collapsed(AWARD_QUALIFYING_MEMBERS_SQL);
    expect(sql).toContain('"c"."parent_id" IS NULL');
    expect(sql).toContain(
      '"roster"."events_attended_count" AS "events_checked_in"',
    );
    expect(sql).not.toContain('event_rsvps');
    expect(sql).toContain('"p"."deleted_at" IS NULL');
    expect(sql).toContain('"rp"."deleted_at" IS NULL');
    expect(sql).toContain('"cm"."removed_at" IS NOT NULL');
    expect(sql).toContain('floor(sum("s"."hours_contributed"))');
    expect(sql).toContain('ON CONFLICT ("badge_id", "user_id") DO NOTHING');
    expect(sql).not.toContain('recognition');
  });

  it('reads removals under the post and reply codes only', () => {
    const sql = collapsed(COMMUNITY_MEMBER_COUNTS_CTE);
    expect(sql).toContain(`"cm"."subject_type" IN ('post', 'reply')`);
    expect(sql).not.toContain('hidden_at');
  });

  it('filters the badge list, the readiness flag and the roster member', () => {
    const sql = collapsed(AWARD_QUALIFYING_MEMBERS_SQL);
    expect(sql).toContain('($2::uuid IS NULL OR "m"."user_id" = $2::uuid)');
    expect(sql).toContain('($3::uuid[] IS NULL OR "b"."id" = ANY($3::uuid[]))');
    expect(sql).toContain(
      '(NOT $4::boolean OR "b"."backfill_requested_at" IS NULL)',
    );
    expect(sql).toContain('"b"."is_enabled"');
    expect(sql).toContain('SELECT "id", "badge_id", "user_id" FROM "inserted"');
    expect(sql).not.toContain('worn_badge_id');
  });

  it('builds the member read on the shared CTE', () => {
    expect(
      MEMBER_BADGE_COUNTS_SQL.startsWith(COMMUNITY_MEMBER_COUNTS_CTE),
    ).toBe(true);
    expect(collapsed(MEMBER_BADGE_COUNTS_SQL)).toContain(
      'SELECT "tenure_days", "events_checked_in", "volunteer_hours", "posts_and_replies" FROM "member_counts"',
    );
    expect(
      AWARD_QUALIFYING_MEMBERS_SQL.startsWith(COMMUNITY_MEMBER_COUNTS_CTE),
    ).toBe(true);
  });

  it('marks one badge notified for the accepted recipients', () => {
    expect(MARK_AWARDS_NOTIFIED_SQL).toBe(
      'UPDATE "community_badge_awards" SET "is_notified" = true WHERE "badge_id" = $1 AND "user_id" = ANY($2::uuid[])',
    );
  });
});

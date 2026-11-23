import type { DataSource } from 'typeorm';
import {
  COMMUNITY_NAME_MARKS_FOR_POST_SQL,
  COMMUNITY_NAME_MARKS_SQL,
  CommunityNameMarksService,
} from './community-name-marks.service';

/** Whitespace collapsed, so a pin reads the same across line wraps. */
function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('CommunityNameMarksService', () => {
  let dataSource: { query: jest.Mock };
  let service: CommunityNameMarksService;

  beforeEach(() => {
    dataSource = { query: jest.fn().mockResolvedValue([]) };
    service = new CommunityNameMarksService(
      dataSource as unknown as DataSource,
    );
  });

  it('maps a worn, earned, enabled badge to flair and a fresh visible gift to the mark', async () => {
    dataSource.query.mockResolvedValue([
      {
        user_id: 'u1',
        badge_name: 'Regular',
        starter_key: 'regular',
        icon_key: 'calendar',
        tint: 'jade',
        has_flair: true,
        has_recent_gift: true,
      },
    ]);
    const marks = await service.marksFor('c1', ['u1', 'u1']);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledWith(COMMUNITY_NAME_MARKS_SQL, [
      'c1',
      ['u1'],
    ]);
    expect(marks.get('u1')).toEqual({
      flair: {
        name: 'Regular',
        starterKey: 'regular',
        iconKey: 'calendar',
        tint: 'jade',
      },
      hasRecentGift: true,
    });
  });

  it('returns no flair for a worn badge that is disabled or unearned', async () => {
    dataSource.query.mockResolvedValue([
      {
        user_id: 'u1',
        badge_name: null,
        starter_key: null,
        icon_key: null,
        tint: null,
        has_flair: false,
        has_recent_gift: false,
      },
    ]);
    expect((await service.marksFor('c1', ['u1'])).get('u1')).toEqual({
      flair: null,
      hasRecentGift: false,
    });
  });

  it('returns no flair when the award join is missing even with badge columns present', async () => {
    dataSource.query.mockResolvedValue([
      {
        user_id: 'u1',
        badge_name: 'Regular',
        starter_key: 'regular',
        icon_key: 'calendar',
        tint: 'jade',
        has_flair: false,
        has_recent_gift: true,
      },
    ]);
    expect((await service.marksFor('c1', ['u1'])).get('u1')).toEqual({
      flair: null,
      hasRecentGift: true,
    });
  });

  it('leaves a member off the roster out of the map', async () => {
    dataSource.query.mockResolvedValue([]);
    const marks = await service.marksFor('c1', ['u1', 'u2']);
    expect(marks.size).toBe(0);
    expect(dataSource.query).toHaveBeenCalledWith(COMMUNITY_NAME_MARKS_SQL, [
      'c1',
      ['u1', 'u2'],
    ]);
  });

  it('runs no query for a global post or an empty page', async () => {
    expect((await service.marksFor(null, ['u1'])).size).toBe(0);
    expect((await service.marksFor('c1', [])).size).toBe(0);
    expect((await service.marksForPost('p1', [])).size).toBe(0);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('reads the marks for a post in one query with deduplicated ids', async () => {
    dataSource.query.mockResolvedValue([
      {
        user_id: 'u2',
        badge_name: null,
        starter_key: null,
        icon_key: null,
        tint: null,
        has_flair: false,
        has_recent_gift: true,
      },
    ]);
    const marks = await service.marksForPost('p1', ['u1', 'u2', 'u1']);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(dataSource.query).toHaveBeenCalledWith(
      COMMUNITY_NAME_MARKS_FOR_POST_SQL,
      ['p1', ['u1', 'u2']],
    );
    expect(marks.get('u2')).toEqual({ flair: null, hasRecentGift: true });
    expect(marks.has('u1')).toBe(false);
  });

  it('reads only enabled badges in top-level communities with the gift window rule', () => {
    const sql = collapsed(COMMUNITY_NAME_MARKS_SQL);
    expect(sql).toContain('"c"."parent_id" IS NULL');
    expect(sql).toContain('AND "b"."is_enabled"');
    expect(sql).toContain('"g"."removed_at" IS NULL');
    expect(sql).toContain('"g"."hidden_by_recipient_at" IS NULL');
    expect(sql).toContain(`"g"."sent_at" > now() - interval '7 days'`);
    expect(sql).toContain(
      '("b"."id" IS NOT NULL AND "a"."id" IS NOT NULL) AS "has_flair"',
    );
    expect(sql).toContain(
      'WHERE "m"."community_id" = $1 AND "m"."user_id" = ANY($2::uuid[])',
    );
  });

  it('scopes the post read to the community that owns the post', () => {
    const sql = collapsed(COMMUNITY_NAME_MARKS_FOR_POST_SQL);
    expect(sql).toContain(
      'WHERE "m"."community_id" = (SELECT "community_id" FROM "community_posts" WHERE "id" = $1) AND "m"."user_id" = ANY($2::uuid[])',
    );
    expect(sql).toContain('"c"."parent_id" IS NULL');
    expect(sql).toContain('AND "b"."is_enabled"');
  });
});

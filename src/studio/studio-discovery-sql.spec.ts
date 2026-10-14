import {
  CURATED_PICKS_FROM_SQL,
  CURATED_PICKS_ORDER_SQL,
  LISTENABLE_ARTIST_SQL,
  STUDIO_ARTIST_KIND_LIST_SQL,
  artistRefFromColumns,
  listenableReleaseSql,
  notBlockedEitherWaySql,
  openUpcomingEventSql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

describe('Studio discovery SQL', () => {
  it('lists every artist kind of the format map for an IN clause', () => {
    expect(STUDIO_ARTIST_KIND_LIST_SQL).toBe(
      STUDIO_ARTIST_PERSONA_KINDS.map((kind) => `'${kind}'`).join(', '),
    );
    expect(STUDIO_ARTIST_KIND_LIST_SQL).toContain(`'podcaster'`);
    expect(STUDIO_ARTIST_KIND_LIST_SQL).toContain(`'burlesque'`);
  });

  it('checks blocks in both directions under its own alias', () => {
    const predicate = notBlockedEitherWaySql(
      '$1',
      '"persona"."user_id"',
      'persona_block',
    );
    expect(predicate).toContain('NOT EXISTS');
    expect(predicate).toContain('FROM "blocks" "persona_block"');
    expect(predicate).toContain(
      '"persona_block"."blocker_id" = $1 AND "persona_block"."blocked_id" = "persona"."user_id"',
    );
    expect(predicate).toContain(
      '"persona_block"."blocked_id" = $1 AND "persona_block"."blocker_id" = "persona"."user_id"',
    );
  });

  it('spells a listenable release as published, a listenable persona and no block either way', () => {
    const predicate = listenableReleaseSql('release', 'persona', '$1');
    expect(predicate).toContain(`"release"."status" = 'published'`);
    expect(predicate).toContain(`"persona"."visibility" = 'open'`);
    expect(predicate).toContain('content_moderation');
    expect(predicate).toContain('FROM "blocks" "persona_block"');
    expect(predicate).toContain(
      '"persona_block"."blocker_id" = $1 AND "persona_block"."blocked_id" = "persona"."user_id"',
    );
  });

  it('finds a listenable artist among Studio artist kinds only, blocks applied', () => {
    expect(LISTENABLE_ARTIST_SQL).toContain(`"artist"."id" = $2`);
    expect(LISTENABLE_ARTIST_SQL).toContain(
      `"artist"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})`,
    );
    expect(LISTENABLE_ARTIST_SQL).toContain('FROM "blocks" "artist_block"');
  });

  it('selects the five persona columns under a prefix and reads them back', () => {
    const columns = personaColumnsSql('credited', 'credited');
    expect(columns).toContain('"credited"."id" AS "credited_id"');
    expect(columns).toContain(
      '"credited"."display_name" AS "credited_display_name"',
    );
    expect(columns).toContain(
      '"credited"."avatar_url" AS "credited_avatar_url"',
    );
    expect(columns).not.toContain('user_id');

    expect(
      personaColumnsFromRow(
        {
          credited_id: 'persona-1',
          credited_handle: 'night-shift',
          credited_display_name: 'Night Shift',
          credited_kind: 'dj',
          credited_avatar_url: null,
        },
        'credited',
      ),
    ).toEqual({
      id: 'persona-1',
      handle: 'night-shift',
      displayName: 'Night Shift',
      kind: 'dj',
      avatarUrl: null,
    });
  });

  it('builds a Studio artist reference from persona columns, with no owner field', () => {
    expect(
      artistRefFromColumns({
        id: 'persona-1',
        handle: null,
        displayName: 'Night Shift',
        kind: 'dj',
        avatarUrl: null,
      }),
    ).toEqual({
      id: 'persona-1',
      handle: '',
      name: 'Night Shift',
      kind: 'dj',
      avatarUrl: null,
    });
  });

  it('spells an event every member may browse: published, upcoming, open to browse, unmoderated and hosted outside any space', () => {
    const predicate = openUpcomingEventSql('event');
    expect(predicate).toContain(`"event"."status" = 'published'`);
    expect(predicate).toContain('"event"."start_at" > now()');
    expect(predicate).toContain(
      `"event"."visibility" IN ('public', 'members')`,
    );
    expect(predicate).toContain('FROM "content_moderation" "event_moderation"');
    expect(predicate).toContain(`"event_moderation"."subject_type" = 'event'`);
    expect(predicate).toContain(
      '"event_moderation"."hidden_at" IS NOT NULL OR "event_moderation"."removed_at" IS NOT NULL',
    );
    expect(predicate).toContain(
      '("event"."community_id" IS NULL OR NOT EXISTS (SELECT 1 FROM "communities" "event_space" WHERE "event_space"."id" = "event"."community_id" AND "event_space"."parent_id" IS NOT NULL))',
    );
    expect(predicate).not.toContain('blocks');
  });

  it('joins each pick to its release and persona and orders shelf by shelf', () => {
    expect(CURATED_PICKS_FROM_SQL).toContain(
      'FROM "studio_curated_picks" "pick"',
    );
    expect(CURATED_PICKS_FROM_SQL).toContain(
      'INNER JOIN "studio_releases" "release" ON "release"."id" = "pick"."release_id"',
    );
    expect(CURATED_PICKS_FROM_SQL).toContain(
      'INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"',
    );
    expect(CURATED_PICKS_ORDER_SQL).toBe(
      'ORDER BY "pick"."shelf" ASC, "pick"."position" ASC',
    );
  });
});

import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { STUDIO_ARTIST_KIND_LIST_SQL } from './studio-discovery-sql';
import { personaMemberUserIdsSql } from './studio-persona-members';
import { playableTrackSql } from './studio-playlist-visibility';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_LANDING_EVENT_TIME_ZONE,
  STUDIO_LANDING_INELIGIBLE_REASONS,
  grantHoldingPersonaMembersSql,
  landingArtistPersonaSql,
  landingImageUrl,
  landingLiveArtistSql,
  landingPreviewEligibleSql,
  landingPreviewIneligibleReasonSql,
  landingPreviewRulesSql,
} from './studio-landing-sql';

const API_BASE = 'https://api.example.test';
const MEMBER_AVATAR_KEY =
  'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-9999-000000000000.jpg';
const PERSONA_KEY =
  'persona/dd000000-0000-4000-8000-000000000001/dd000000-0000-4000-8000-000000000002.jpg';

describe('Studio landing SQL', () => {
  it('reads an artist kind, a listenable persona and an active creator', () => {
    const sql = landingArtistPersonaSql('persona');
    expect(sql).toContain(
      `"persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})`,
    );
    expect(sql).toContain(listenablePersonaSql('persona'));
    expect(sql).toContain(`"persona_creator"."id" = "persona"."user_id"`);
    expect(sql).toContain(`"persona_creator"."status" = 'active'`);
    expect(sql).not.toContain('blocks');
  });

  it('adds a published release for a live artist', () => {
    const sql = landingLiveArtistSql('persona');
    expect(sql).toContain(landingArtistPersonaSql('persona'));
    expect(sql).toContain(
      `"persona_live_release"."subprofile_id" = "persona"."id"`,
    );
    expect(sql).toContain(`"persona_live_release"."status" = 'published'`);
  });

  it('lists the six rules in the contract order', () => {
    expect(
      landingPreviewRulesSql('track', 'release', 'persona').map(
        (rule) => rule.reason,
      ),
    ).toEqual([...STUDIO_LANDING_INELIGIBLE_REASONS]);
    expect([...STUDIO_LANDING_INELIGIBLE_REASONS]).toEqual([
      'not_playable',
      'persona_not_eligible',
      'podcast',
      'content_warnings',
      'explicit',
      'open_claim',
    ]);
  });

  it('spells each rule as the contract does', () => {
    expect(
      landingPreviewRulesSql('track', 'release', 'persona').map(
        (rule) => rule.conditionSql,
      ),
    ).toEqual([
      playableTrackSql('track', 'release', 'persona'),
      landingArtistPersonaSql('persona'),
      `"release"."type" <> 'podcast'`,
      `cardinality("track"."content_warnings") = 0 AND cardinality("track"."staff_content_warnings") = 0`,
      `"track"."is_explicit" = false`,
      expect.stringContaining(
        'FROM "studio_copyright_claims" "track_open_claim"',
      ),
    ]);
  });

  it('joins every rule into the eligible test', () => {
    const eligibleSql = landingPreviewEligibleSql(
      'track',
      'release',
      'persona',
    );
    for (const rule of landingPreviewRulesSql('track', 'release', 'persona')) {
      expect(eligibleSql).toContain(rule.conditionSql);
    }
    expect(eligibleSql).toContain(
      `"track_open_claim"."status" IN ('submitted', 'accepted', 'countered')`,
    );
    expect(eligibleSql).toContain(
      `"track_open_claim"."track_id" = "track"."id"`,
    );
    expect(eligibleSql).toContain(`"release"."type" <> 'podcast'`);
    expect(eligibleSql).toContain(`"track"."is_explicit" = false`);
    expect(eligibleSql).toContain(`"track"."withheld_at" IS NULL`);
    expect(eligibleSql.startsWith('((')).toBe(true);
    expect(eligibleSql).not.toContain('blocks');
  });

  it('reads the first failing rule as the reason', () => {
    const reasonSql = landingPreviewIneligibleReasonSql(
      'track',
      'release',
      'persona',
    );
    expect(reasonSql.startsWith('CASE WHEN NOT COALESCE((')).toBe(true);
    const positions = STUDIO_LANDING_INELIGIBLE_REASONS.map((reason) =>
      reasonSql.indexOf(`THEN '${reason}'`),
    );
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(
      positions,
    );
    expect(reasonSql.indexOf(`THEN 'not_playable'`)).toBeLessThan(
      reasonSql.indexOf(`THEN 'open_claim'`),
    );
    expect(reasonSql).toMatch(/ELSE NULL END$/);
  });

  it('reads the grant holders among the persona members who are active', () => {
    const sql = grantHoldingPersonaMembersSql('$1', 'preview');
    expect(sql).toContain(personaMemberUserIdsSql('$1'));
    expect(sql).toContain('SELECT "preview_owner"."user_id" AS "user_id"');
    expect(sql).toContain('INNER JOIN "studio_access_grants" "preview_grant"');
    expect(sql).toContain(
      '"preview_grant"."user_id" = "preview_owner"."user_id"',
    );
    expect(sql).toContain('INNER JOIN "users"');
    expect(sql).toContain(`"status" = 'active'`);
    expect(sql.trim().startsWith('(')).toBe(true);
    expect(sql.trim().endsWith(')')).toBe(true);
  });

  it('counts the month in Lisbon time', () => {
    expect(STUDIO_LANDING_EVENT_TIME_ZONE).toBe('Europe/Lisbon');
  });

  describe('landingImageUrl', () => {
    beforeEach(() => {
      setImageUrlBase(API_BASE);
    });

    afterEach(() => {
      resetImageUrlBaseForTesting();
    });

    it.each<[string, string | null, string, string | null]>([
      [
        'a member key on an unlinked persona',
        MEMBER_AVATAR_KEY,
        'unlinked',
        null,
      ],
      [
        'a member key on a linked persona',
        MEMBER_AVATAR_KEY,
        'linked',
        `${API_BASE}/files/${MEMBER_AVATAR_KEY}`,
      ],
      [
        'a persona-scoped key',
        PERSONA_KEY,
        'unlinked',
        `${API_BASE}/files/${PERSONA_KEY}`,
      ],
      [
        'an https URL',
        'https://images.example/avatar.jpg',
        'unlinked',
        'https://images.example/avatar.jpg',
      ],
      ['nothing', null, 'linked', null],
    ])(
      'nulls a member key on an unlinked persona and serves it on a linked one: %s',
      (_label, value, linkVisibility, expected) => {
        expect(landingImageUrl(value, linkVisibility)).toBe(expected);
      },
    );
  });
});

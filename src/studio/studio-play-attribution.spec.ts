import {
  studioPersonaTrackIdsSql,
  studioTrackArtistIdsSql,
} from './studio-play-attribution';

describe('Studio play attribution', () => {
  it('reads the release persona and the accepted credits of the track, deduplicated', () => {
    const sql = studioTrackArtistIdsSql('track');
    expect(sql).toMatch(/^\(/);
    expect(sql).toContain('"attributed_release"."id" = "track"."release_id"');
    expect(sql).toContain('"attributed_credit"."track_id" = "track"."id"');
    expect(sql).toContain(`"attributed_credit"."status" = 'accepted'`);
    expect(sql).toMatch(/\bUNION\b(?!\s+ALL)/);
  });

  it('reads the own tracks and the accepted credited tracks of a persona', () => {
    const sql = studioPersonaTrackIdsSql('$1');
    expect(sql.match(/\$1/g)).toHaveLength(2);
    expect(sql).toContain(`"credited"."status" = 'accepted'`);
    expect(sql).toMatch(/\bUNION\b(?!\s+ALL)/);
  });
});

import {
  ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL,
  ADMIN_SPOTLIGHT_SQL,
  DELETE_SPOTLIGHT_SQL,
  INSERT_SPOTLIGHT_SQL,
  SPOTLIGHT_PLACEMENT_STATE_SQL,
  UPDATE_SPOTLIGHT_NOTE_SQL,
  spotlightArtistPersonaSql,
} from './admin-studio-spotlight-sql';

describe('Studio spotlight staff SQL', () => {
  it('places only linked, listenable Studio artist personas with a published release', () => {
    const personaSql = spotlightArtistPersonaSql('persona');
    expect(personaSql).toContain(`"persona"."link_visibility" = 'linked'`);
    expect(personaSql).toContain('"persona"."kind" IN (');
    expect(personaSql).toContain('content_moderation');
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).toContain(
      `"status" = 'published'`,
    );
    expect(SPOTLIGHT_PLACEMENT_STATE_SQL).toContain(`"status" = 'published'`);
  });

  it('matches persona names and handles and never a member column', () => {
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).toContain('display_name');
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).toContain('handle');
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).toContain("ESCAPE '\\'");
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).toContain(' LIKE ');
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).not.toMatch(
      /"user_id"|first_name|last_name|"profiles"/,
    );
  });

  it('ranks positions 1..n per slot on the wire', () => {
    expect(ADMIN_SPOTLIGHT_SQL).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "spotlight"."slot"',
    );
    expect(ADMIN_SPOTLIGHT_SQL).toContain(
      'CAST("ranked"."slot_rank" AS int) AS "position"',
    );
  });

  it('keeps the curator id off every read', () => {
    expect(ADMIN_SPOTLIGHT_SQL).not.toContain('created_by_id');
    expect(ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL).not.toContain('created_by_id');
  });

  it('appends after the highest position in the slot', () => {
    expect(INSERT_SPOTLIGHT_SQL).toContain('COALESCE((SELECT MAX("position")');
  });

  it('wraps the removal so the removed row comes back as a row', () => {
    expect(DELETE_SPOTLIGHT_SQL).toMatch(/^WITH "removed" AS \(DELETE/);
  });

  it('edits the note without touching the pick date', () => {
    expect(UPDATE_SPOTLIGHT_NOTE_SQL).not.toContain('created_at');
  });
});

import { DataSource } from 'typeorm';
import {
  artistRefFromColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
} from './studio-discovery-sql';
import {
  FOUNDING_ARTISTS_SQL,
  FOUNDING_SHELF_VISIBLE_SQL,
  StudioFoundingArtistsService,
} from './studio-founding-artists.service';
import { landingArtistPersonaSql } from './studio-landing-sql';

const VIEWER_ID = '8d000000-0000-4000-8000-000000000001';

const artistRow = (index: number): Record<string, unknown> => ({
  artist_id: `8d000000-0000-4000-8000-00000000010${index}`,
  artist_handle: `artist-${index}`,
  artist_display_name: `Artist ${index}`,
  artist_kind: 'dj',
  artist_avatar_url: null,
});

describe('StudioFoundingArtistsService', () => {
  let query: jest.Mock;
  let service: StudioFoundingArtistsService;

  const answerWith = (
    artistRows: Record<string, unknown>[],
    switchRows: { is_shelf_visible: boolean | null }[],
  ): void => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(sql === FOUNDING_ARTISTS_SQL ? artistRows : switchRows),
    );
  };

  beforeEach(() => {
    query = jest.fn();
    service = new StudioFoundingArtistsService({
      query,
    } as unknown as DataSource);
  });

  it('lists the founding artists the viewer can see in position order', async () => {
    expect(FOUNDING_ARTISTS_SQL).toContain(landingArtistPersonaSql('persona'));
    expect(FOUNDING_ARTISTS_SQL).toContain(
      notBlockedEitherWaySql('$1', '"persona"."user_id"', 'founding_block'),
    );
    expect(FOUNDING_ARTISTS_SQL).toMatch(
      /ORDER BY "founding"\."position" ASC, "founding"\."id" ASC$/,
    );
    answerWith([artistRow(1), artistRow(2)], [{ is_shelf_visible: true }]);

    const founding = await service.getFoundingArtists(VIEWER_ID);

    expect(query).toHaveBeenCalledWith(FOUNDING_ARTISTS_SQL, [VIEWER_ID]);
    expect(founding.artists).toEqual(
      [artistRow(1), artistRow(2)].map((row) =>
        artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
      ),
    );
  });

  it('passes the shelf switch and reads a missing settings row as visible', async () => {
    expect(FOUNDING_SHELF_VISIBLE_SQL).toContain('COALESCE(');
    expect(FOUNDING_SHELF_VISIBLE_SQL).toContain('"settings"."id" = 1');
    expect(FOUNDING_SHELF_VISIBLE_SQL).toContain('true\n)');

    answerWith([], [{ is_shelf_visible: false }]);
    expect((await service.getFoundingArtists(VIEWER_ID)).isShelfVisible).toBe(
      false,
    );

    answerWith([], [{ is_shelf_visible: true }]);
    expect((await service.getFoundingArtists(VIEWER_ID)).isShelfVisible).toBe(
      true,
    );

    answerWith([], [{ is_shelf_visible: null }]);
    expect((await service.getFoundingArtists(VIEWER_ID)).isShelfVisible).toBe(
      true,
    );

    answerWith([], []);
    expect((await service.getFoundingArtists(VIEWER_ID)).isShelfVisible).toBe(
      true,
    );
  });

  it('sends the list whatever the shelf switch says', async () => {
    answerWith([artistRow(1)], [{ is_shelf_visible: false }]);

    const founding = await service.getFoundingArtists(VIEWER_ID);

    expect(founding.isShelfVisible).toBe(false);
    expect(founding.artists.map((artist) => artist.handle)).toEqual([
      'artist-1',
    ]);
  });
});

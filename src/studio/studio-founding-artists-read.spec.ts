import { EntityManager } from 'typeorm';
import {
  FOUNDING_ARTIST_IDS_SQL,
  findFoundingArtistIds,
} from './studio-founding-artists-read';
import { STUDIO_ARTIST_KIND_LIST_SQL } from './studio-discovery-sql';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('findFoundingArtistIds', () => {
  let query: jest.Mock;
  let manager: EntityManager;

  beforeEach(() => {
    query = jest.fn();
    manager = { query } as unknown as EntityManager;
  });

  it('reads the founding ids of artist kinds in one query', async () => {
    query.mockResolvedValue([{ subprofile_id: PERSONA_ID }]);

    const foundingIds = await findFoundingArtistIds(manager, [
      PERSONA_ID,
      OTHER_ID,
    ]);

    expect(foundingIds).toEqual(new Set([PERSONA_ID]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(FOUNDING_ARTIST_IDS_SQL, [
      [PERSONA_ID, OTHER_ID],
    ]);
  });

  it('limits the read to Studio artist kinds on the founding table', () => {
    expect(FOUNDING_ARTIST_IDS_SQL).toContain('"studio_founding_artists"');
    expect(FOUNDING_ARTIST_IDS_SQL).toContain(
      '"founding"."subprofile_id" = ANY($1::uuid[])',
    );
    expect(FOUNDING_ARTIST_IDS_SQL).toContain(
      `"persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})`,
    );
  });

  it('skips the query for an empty list', async () => {
    expect(await findFoundingArtistIds(manager, [])).toEqual(new Set<string>());
    expect(query).not.toHaveBeenCalled();
  });
});

import { DataSource } from 'typeorm';
import { StudioCatalogService } from './studio-catalog.service';
import {
  LISTENABLE_PICKS_SQL,
  LISTENABLE_SPOTLIGHT_SQL,
  StudioCurationService,
} from './studio-curation.service';
import { StudioReleaseCard } from './studio-response';
import { StudioSpotlightSlot } from './studio.constants';

const VIEWER_ID = 'c6000000-0000-4000-8000-000000000001';
const FIRST_RELEASE = 'c6000000-0000-4000-8000-000000000011';
const SECOND_RELEASE = 'c6000000-0000-4000-8000-000000000012';
const THIRD_RELEASE = 'c6000000-0000-4000-8000-000000000013';
const FOURTH_RELEASE = 'c6000000-0000-4000-8000-000000000014';
const FIFTH_RELEASE = 'c6000000-0000-4000-8000-000000000015';
const SIXTH_RELEASE = 'c6000000-0000-4000-8000-000000000016';
const MONTH_PERSONA = 'c6000000-0000-4000-8000-000000000021';
const FIRST_STAR_PERSONA = 'c6000000-0000-4000-8000-000000000022';
const SECOND_STAR_PERSONA = 'c6000000-0000-4000-8000-000000000023';

const card = (releaseId: string): StudioReleaseCard =>
  ({
    id: releaseId,
    title: `Release ${releaseId.slice(-2)}`,
  }) as StudioReleaseCard;

const spotlightRow = (
  slot: StudioSpotlightSlot,
  personaId: string,
  note: string | null,
  latestReleaseId: string,
) => ({
  slot,
  note,
  artist_id: personaId,
  artist_handle: `artist-${personaId.slice(-2)}`,
  artist_display_name: `Artist ${personaId.slice(-2)}`,
  artist_kind: 'dj',
  artist_avatar_url: null,
  latest_release_id: latestReleaseId,
});

const artistOf = (personaId: string) => ({
  id: personaId,
  handle: `artist-${personaId.slice(-2)}`,
  name: `Artist ${personaId.slice(-2)}`,
  kind: 'dj',
  avatarUrl: null,
});

describe('StudioCurationService', () => {
  let query: jest.Mock;
  let pickRows: object[];
  let spotlightRows: object[];
  let catalog: { cardsByReleaseId: jest.Mock };
  let service: StudioCurationService;

  beforeEach(() => {
    pickRows = [];
    spotlightRows = [];
    query = jest.fn((sql: string) =>
      Promise.resolve(
        sql === LISTENABLE_SPOTLIGHT_SQL ? spotlightRows : pickRows,
      ),
    );
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(releaseIds.map((releaseId) => [releaseId, card(releaseId)])),
        ),
      ),
    };
    service = new StudioCurationService(
      { query } as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
    );
  });

  it('keeps shelf order and adds each note to its card', async () => {
    pickRows = [
      { shelf: 'featured', release_id: FIRST_RELEASE, note: 'Out tonight' },
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
      { shelf: 'staff_picks', release_id: THIRD_RELEASE, note: 'A slow one' },
      { shelf: 'new_this_week', release_id: FIRST_RELEASE, note: null },
    ];

    const curation = await service.getCuration(VIEWER_ID);

    expect(curation.featured).toEqual({
      ...card(FIRST_RELEASE),
      note: 'Out tonight',
    });
    expect(curation.staffPicks.map((pick) => [pick.id, pick.note])).toEqual([
      [SECOND_RELEASE, null],
      [THIRD_RELEASE, 'A slow one'],
    ]);
    expect(curation.newThisWeek.map((pick) => pick.id)).toEqual([
      FIRST_RELEASE,
    ]);
    expect(catalog.cardsByReleaseId).toHaveBeenCalledWith([
      FIRST_RELEASE,
      SECOND_RELEASE,
      THIRD_RELEASE,
    ]);
  });

  // The frontend shows the newest release in the hero when this is null.
  it('answers a null featured pick when none is listenable for this viewer', async () => {
    pickRows = [
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
    ];
    const curation = await service.getCuration(VIEWER_ID);
    expect(curation.featured).toBeNull();
    expect(curation.staffPicks).toHaveLength(1);
  });

  it('skips a pick whose card could not be built and keeps the rest', async () => {
    pickRows = [
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
      { shelf: 'staff_picks', release_id: THIRD_RELEASE, note: null },
    ];
    catalog.cardsByReleaseId.mockResolvedValue(
      new Map([[THIRD_RELEASE, card(THIRD_RELEASE)]]),
    );
    const curation = await service.getCuration(VIEWER_ID);
    expect(curation.staffPicks.map((pick) => pick.id)).toEqual([THIRD_RELEASE]);
  });

  it('answers empty shelves and no spotlight when nothing is listenable', async () => {
    await expect(service.getCuration(VIEWER_ID)).resolves.toEqual({
      featured: null,
      staffPicks: [],
      newThisWeek: [],
      artistOfTheMonth: null,
      newStars: [],
    });
  });

  it('adds the artist of the month with the newest release this viewer can hear in the one card read', async () => {
    pickRows = [
      { shelf: 'staff_picks', release_id: FIRST_RELEASE, note: null },
      { shelf: 'new_this_week', release_id: SECOND_RELEASE, note: null },
    ];
    spotlightRows = [
      spotlightRow(
        'artist_of_the_month',
        MONTH_PERSONA,
        'Our month',
        FOURTH_RELEASE,
      ),
    ];

    const curation = await service.getCuration(VIEWER_ID);

    expect(catalog.cardsByReleaseId).toHaveBeenCalledTimes(1);
    expect(catalog.cardsByReleaseId).toHaveBeenCalledWith([
      FIRST_RELEASE,
      SECOND_RELEASE,
      FOURTH_RELEASE,
    ]);
    expect(curation.artistOfTheMonth).toEqual({
      artist: artistOf(MONTH_PERSONA),
      note: 'Our month',
      latestRelease: card(FOURTH_RELEASE),
    });
  });

  it('lists new stars in position order with their notes and no release card', async () => {
    spotlightRows = [
      spotlightRow('new_stars', FIRST_STAR_PERSONA, 'First set', FIFTH_RELEASE),
      spotlightRow('new_stars', SECOND_STAR_PERSONA, null, SIXTH_RELEASE),
    ];

    const curation = await service.getCuration(VIEWER_ID);

    expect(curation.newStars).toEqual([
      { artist: artistOf(FIRST_STAR_PERSONA), note: 'First set' },
      { artist: artistOf(SECOND_STAR_PERSONA), note: null },
    ]);
    expect(curation.artistOfTheMonth).toBeNull();
    expect(catalog.cardsByReleaseId).toHaveBeenCalledWith([]);
  });

  it('answers a null artist of the month when its release card could not be built', async () => {
    spotlightRows = [
      spotlightRow('artist_of_the_month', MONTH_PERSONA, null, FOURTH_RELEASE),
    ];
    catalog.cardsByReleaseId.mockResolvedValue(new Map());

    const curation = await service.getCuration(VIEWER_ID);

    expect(curation.artistOfTheMonth).toBeNull();
  });

  it('reads the picks and the spotlights with the viewer', async () => {
    await service.getCuration(VIEWER_ID);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith(LISTENABLE_PICKS_SQL, [VIEWER_ID]);
    expect(query).toHaveBeenCalledWith(LISTENABLE_SPOTLIGHT_SQL, [VIEWER_ID]);
  });

  it('reads only spotlights this viewer can hear and never who placed them', () => {
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain('INNER JOIN LATERAL');
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain('content_moderation');
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain('FROM "blocks" "persona_block"');
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain(
      `AND "persona"."link_visibility" = 'linked'`,
    );
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain('LIMIT 1');
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain(
      'ORDER BY "release"."published_at" DESC',
    );
    expect(LISTENABLE_SPOTLIGHT_SQL).toContain(
      'ORDER BY "spotlight"."slot" ASC, "spotlight"."position" ASC',
    );
    expect(LISTENABLE_SPOTLIGHT_SQL).not.toContain('created_by_id');
    expect(LISTENABLE_SPOTLIGHT_SQL).not.toMatch(/"user_id" AS/);
  });

  it('reads only picks this viewer can hear, in shelf position order', async () => {
    await service.getCuration(VIEWER_ID);
    expect(query).toHaveBeenCalledWith(LISTENABLE_PICKS_SQL, [VIEWER_ID]);
    expect(LISTENABLE_PICKS_SQL).toContain(`"release"."status" = 'published'`);
    expect(LISTENABLE_PICKS_SQL).toContain('content_moderation');
    expect(LISTENABLE_PICKS_SQL).toContain('FROM "blocks" "persona_block"');
    expect(LISTENABLE_PICKS_SQL).toContain(
      'ORDER BY "pick"."shelf" ASC, "pick"."position" ASC',
    );
    expect(LISTENABLE_PICKS_SQL).not.toContain('created_by_id');
  });
});

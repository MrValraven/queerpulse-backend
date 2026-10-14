import { DataSource } from 'typeorm';
import { StudioCatalogService } from './studio-catalog.service';
import {
  LISTENABLE_PICKS_SQL,
  StudioCurationService,
} from './studio-curation.service';
import { StudioReleaseCard } from './studio-response';

const VIEWER_ID = 'c6000000-0000-4000-8000-000000000001';
const FIRST_RELEASE = 'c6000000-0000-4000-8000-000000000011';
const SECOND_RELEASE = 'c6000000-0000-4000-8000-000000000012';
const THIRD_RELEASE = 'c6000000-0000-4000-8000-000000000013';

const card = (releaseId: string): StudioReleaseCard =>
  ({
    id: releaseId,
    title: `Release ${releaseId.slice(-2)}`,
  }) as StudioReleaseCard;

describe('StudioCurationService', () => {
  let query: jest.Mock;
  let catalog: { cardsByReleaseId: jest.Mock };
  let service: StudioCurationService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
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
    query.mockResolvedValue([
      { shelf: 'featured', release_id: FIRST_RELEASE, note: 'Out tonight' },
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
      { shelf: 'staff_picks', release_id: THIRD_RELEASE, note: 'A slow one' },
      { shelf: 'new_this_week', release_id: FIRST_RELEASE, note: null },
    ]);

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
    query.mockResolvedValue([
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
    ]);
    const curation = await service.getCuration(VIEWER_ID);
    expect(curation.featured).toBeNull();
    expect(curation.staffPicks).toHaveLength(1);
  });

  it('skips a pick whose card could not be built and keeps the rest', async () => {
    query.mockResolvedValue([
      { shelf: 'staff_picks', release_id: SECOND_RELEASE, note: null },
      { shelf: 'staff_picks', release_id: THIRD_RELEASE, note: null },
    ]);
    catalog.cardsByReleaseId.mockResolvedValue(
      new Map([[THIRD_RELEASE, card(THIRD_RELEASE)]]),
    );
    const curation = await service.getCuration(VIEWER_ID);
    expect(curation.staffPicks.map((pick) => pick.id)).toEqual([THIRD_RELEASE]);
  });

  it('answers three empty shelves when nothing is listenable', async () => {
    await expect(service.getCuration(VIEWER_ID)).resolves.toEqual({
      featured: null,
      staffPicks: [],
      newThisWeek: [],
    });
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

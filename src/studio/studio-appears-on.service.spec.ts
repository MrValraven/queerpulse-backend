import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  APPEARS_ON_SQL,
  StudioAppearsOnService,
} from './studio-appears-on.service';
import { StudioCatalogService } from './studio-catalog.service';
import { encodeStudioCursor } from './studio-cursor';
import { episodeReleasedSql } from './studio-episode-rule';
import { LISTENABLE_ARTIST_SQL } from './studio-discovery-sql';
import { playableTrackAudioSql } from './studio-playlist-visibility';
import { StudioReleaseCard } from './studio-response';

const VIEWER_ID = 'f9000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'f9000000-0000-4000-8000-000000000002';

const appearsOnRow = (index: number) => ({
  release_id: `f9000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
  published_at: new Date(Date.UTC(2026, 9, 1, 0, 0, 59 - index)),
  roles: ['producer', 'featured', 'drums'],
});

describe('StudioAppearsOnService', () => {
  let query: jest.Mock;
  let catalog: { cardsByReleaseId: jest.Mock };
  let service: StudioAppearsOnService;

  beforeEach(() => {
    query = jest.fn((sql: string) =>
      Promise.resolve(sql === LISTENABLE_ARTIST_SQL ? [{ found: 1 }] : []),
    );
    catalog = {
      cardsByReleaseId: jest.fn((releaseIds: string[]) =>
        Promise.resolve(
          new Map(
            releaseIds.map((releaseId) => [
              releaseId,
              { id: releaseId } as StudioReleaseCard,
            ]),
          ),
        ),
      ),
    };
    service = new StudioAppearsOnService(
      { query } as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
    );
  });

  it('pages listenable releases crediting the persona, 24 at a time, roles in vocabulary order', async () => {
    const rows = Array.from({ length: 25 }, (_unused, index) =>
      appearsOnRow(index),
    );
    query.mockImplementation((sql: string) =>
      Promise.resolve(sql === LISTENABLE_ARTIST_SQL ? [{ found: 1 }] : rows),
    );

    const page = await service.listAppearsOn(VIEWER_ID, PERSONA_ID, undefined);

    expect(query).toHaveBeenLastCalledWith(APPEARS_ON_SQL, [
      VIEWER_ID,
      PERSONA_ID,
      null,
      null,
      25,
    ]);
    expect(page.items).toHaveLength(24);
    expect(page.items[0]).toEqual({
      id: rows[0]!.release_id,
      roles: ['featured', 'producer'],
    });
    expect(page.pageInfo).toEqual({
      hasMore: true,
      nextCursor: encodeStudioCursor({
        publishedAt: rows[23]!.published_at,
        id: rows[23]!.release_id,
      }),
    });
  });

  it('seeks past a cursor', async () => {
    const cursorDate = new Date('2026-10-01T00:00:00.000Z');
    await service.listAppearsOn(
      VIEWER_ID,
      PERSONA_ID,
      encodeStudioCursor({ publishedAt: cursorDate, id: PERSONA_ID }),
    );
    expect(query).toHaveBeenLastCalledWith(APPEARS_ON_SQL, [
      VIEWER_ID,
      PERSONA_ID,
      cursorDate,
      PERSONA_ID,
      25,
    ]);
  });

  it('answers 404 for a persona that is not a listenable artist', async () => {
    query.mockResolvedValue([]);
    await expect(
      service.listAppearsOn(VIEWER_ID, PERSONA_ID, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads accepted credits on listenable releases only', () => {
    expect(APPEARS_ON_SQL).toContain(`"credit"."status" = 'accepted'`);
    expect(APPEARS_ON_SQL).toContain('"credit"."subprofile_id" = $2');
    expect(APPEARS_ON_SQL).toContain(`"release"."status" = 'published'`);
    expect(APPEARS_ON_SQL).toContain(
      `(${playableTrackAudioSql('track', 'release')})`,
    );
    expect(APPEARS_ON_SQL).toContain('"track"."duration_seconds" IS NOT NULL');
    expect(APPEARS_ON_SQL).toContain('FROM "blocks" "persona_block"');
    expect(APPEARS_ON_SQL).toContain(
      'array_agg(DISTINCT CAST("credit"."role" AS text))',
    );
    expect(APPEARS_ON_SQL).toContain(
      'ORDER BY "release"."published_at" DESC, "release"."id" DESC',
    );
  });

  // Studio artist kinds: a show appears once a credited episode is out.
  it('counts a credit on a published episode only', () => {
    expect(APPEARS_ON_SQL).toContain(episodeReleasedSql('track', 'release'));
  });
});

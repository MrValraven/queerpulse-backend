import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioCatalogService } from './studio-catalog.service';
import {
  CURATED_PICKS_FROM_SQL,
  CURATED_PICKS_ORDER_SQL,
  listenableReleaseSql,
} from './studio-discovery-sql';
import { StudioReleaseCard } from './studio-response';
import { StudioCurationShelf } from './studio.constants';

/** One pick on the wire: the release card plus the staff note (the
 *  contract's `StudioCuratedPick`). */
export type StudioCuratedPickCard = StudioReleaseCard & { note: string | null };

/** `GET /studio/curation`. A null `featured` sends the hero to the newest
 *  release. */
export interface StudioCuration {
  featured: StudioCuratedPickCard | null;
  staffPicks: StudioCuratedPickCard[];
  newThisWeek: StudioCuratedPickCard[];
}

interface ListenablePickRow {
  shelf: StudioCurationShelf;
  release_id: string;
  note: string | null;
}

/** `$1` the viewer. Every pick whose release this viewer can hear, shelf by
 *  shelf in position order. Who added a pick is never read. */
export const LISTENABLE_PICKS_SQL = `SELECT "pick"."shelf"::text AS "shelf",
       "pick"."release_id" AS "release_id",
       "pick"."note" AS "note"
  ${CURATED_PICKS_FROM_SQL}
 WHERE ${listenableReleaseSql('release', 'persona', '$1')}
 ${CURATED_PICKS_ORDER_SQL}`;

/**
 * Studio discovery: the staff shelves and the featured hero for one viewer.
 * A pick that fails the listenable rule for this viewer (unpublished, taken
 * down, persona out of reach, creator blocked either way) is skipped on read
 * and stays in the table, so it returns as soon as the release does.
 */
@Injectable()
export class StudioCurationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
  ) {}

  async getCuration(viewerId: string): Promise<StudioCuration> {
    const rows: ListenablePickRow[] = await this.dataSource.query(
      LISTENABLE_PICKS_SQL,
      [viewerId],
    );
    const cardsByReleaseId = await this.catalog.cardsByReleaseId([
      ...new Set(rows.map((row) => row.release_id)),
    ]);
    const picksOn = (shelf: StudioCurationShelf): StudioCuratedPickCard[] =>
      rows
        .filter((row) => row.shelf === shelf)
        .flatMap((row) => {
          const releaseCard = cardsByReleaseId.get(row.release_id);
          return releaseCard ? [{ ...releaseCard, note: row.note }] : [];
        });
    return {
      featured: picksOn('featured')[0] ?? null,
      staffPicks: picksOn('staff_picks'),
      newThisWeek: picksOn('new_this_week'),
    };
  }
}

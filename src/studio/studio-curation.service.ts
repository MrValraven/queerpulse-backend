import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  artistRefFromColumns,
  CURATED_PICKS_FROM_SQL,
  CURATED_PICKS_ORDER_SQL,
  listenableReleaseSql,
  personaColumnsFromRow,
  personaColumnsSql,
  STUDIO_ARTIST_KIND_LIST_SQL,
} from './studio-discovery-sql';
import { StudioArtistRef, StudioReleaseCard } from './studio-response';
import { StudioCurationShelf, StudioSpotlightSlot } from './studio.constants';

/** One pick on the wire: the release card plus the staff note (the
 *  contract's `StudioCuratedPick`). */
export type StudioCuratedPickCard = StudioReleaseCard & { note: string | null };

/** One spotlight artist on the wire: the persona plus the staff note. */
export interface StudioSpotlightArtistCard {
  artist: StudioArtistRef;
  note: string | null;
}

/** Artist of the month carries the newest release this viewer can hear. */
export interface StudioArtistOfTheMonthCard extends StudioSpotlightArtistCard {
  latestRelease: StudioReleaseCard;
}

/** `GET /studio/curation`. A null `featured` sends the hero to the newest
 *  release. */
export interface StudioCuration {
  featured: StudioCuratedPickCard | null;
  staffPicks: StudioCuratedPickCard[];
  newThisWeek: StudioCuratedPickCard[];
  artistOfTheMonth: StudioArtistOfTheMonthCard | null;
  newStars: StudioSpotlightArtistCard[];
}

interface ListenablePickRow {
  shelf: StudioCurationShelf;
  release_id: string;
  note: string | null;
}

type ListenableSpotlightRow = Readonly<Record<string, unknown>> & {
  slot: StudioSpotlightSlot;
  note: string | null;
  latest_release_id: string;
};

/** `$1` the viewer. Every pick whose release this viewer can hear, shelf by
 *  shelf in position order. Who added a pick is never read. */
export const LISTENABLE_PICKS_SQL = `SELECT "pick"."shelf"::text AS "shelf",
       "pick"."release_id" AS "release_id",
       "pick"."note" AS "note"
  ${CURATED_PICKS_FROM_SQL}
 WHERE ${listenableReleaseSql('release', 'persona', '$1')}
 ${CURATED_PICKS_ORDER_SQL}`;

/** `$1` the viewer. Every spotlight whose persona this viewer can hear,
 *  each with the id of that persona's newest release the viewer can hear,
 *  slot by slot in position order. The lateral join drops a persona with no
 *  such release: a block either way, a hidden, removed or taken down
 *  persona, or no published release. Only a persona linked to its member is
 *  read, the rule the staff search places by. Who placed a spotlight is
 *  never read. */
export const LISTENABLE_SPOTLIGHT_SQL = `SELECT "spotlight"."slot"::text AS "slot",
       "spotlight"."note" AS "note",
       ${personaColumnsSql('persona', 'artist')},
       "latest_release"."id" AS "latest_release_id"
  FROM "studio_spotlight_artists" "spotlight"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "spotlight"."subprofile_id"
  INNER JOIN LATERAL (
    SELECT "release"."id"
      FROM "studio_releases" "release"
     WHERE "release"."subprofile_id" = "persona"."id"
       AND ${listenableReleaseSql('release', 'persona', '$1')}
     ORDER BY "release"."published_at" DESC NULLS LAST, "release"."id" DESC
     LIMIT 1
  ) "latest_release" ON true
 WHERE "persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
   AND "persona"."link_visibility" = '${SubprofileLinkVisibility.Linked}'
 ORDER BY "spotlight"."slot" ASC, "spotlight"."position" ASC, "spotlight"."id" ASC`;

function spotlightArtistCard(
  row: ListenableSpotlightRow,
): StudioSpotlightArtistCard {
  return {
    artist: artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
    note: row.note,
  };
}

/**
 * Studio discovery: the staff shelves, the featured hero, Artist of the
 * month and New stars for one viewer. A pick that fails the listenable rule
 * for this viewer (unpublished, taken down, persona out of reach, creator
 * blocked either way) is skipped on read and stays in the table, so it
 * returns as soon as the release does. A spotlight whose persona this viewer
 * cannot hear follows the same rule: skipped on read, kept in the table.
 */
@Injectable()
export class StudioCurationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
  ) {}

  async getCuration(viewerId: string): Promise<StudioCuration> {
    const [pickRows, spotlightRows] = await Promise.all([
      this.dataSource.query<ListenablePickRow[]>(LISTENABLE_PICKS_SQL, [
        viewerId,
      ]),
      this.dataSource.query<ListenableSpotlightRow[]>(
        LISTENABLE_SPOTLIGHT_SQL,
        [viewerId],
      ),
    ]);
    const artistOfTheMonthRow = spotlightRows.find(
      (row) => row.slot === 'artist_of_the_month',
    );
    const cardsByReleaseId = await this.catalog.cardsByReleaseId([
      ...new Set([
        ...pickRows.map((row) => row.release_id),
        ...(artistOfTheMonthRow ? [artistOfTheMonthRow.latest_release_id] : []),
      ]),
    ]);
    const picksOn = (shelf: StudioCurationShelf): StudioCuratedPickCard[] =>
      pickRows
        .filter((row) => row.shelf === shelf)
        .flatMap((row) => {
          const releaseCard = cardsByReleaseId.get(row.release_id);
          return releaseCard ? [{ ...releaseCard, note: row.note }] : [];
        });
    const artistOfTheMonthRelease = artistOfTheMonthRow
      ? cardsByReleaseId.get(artistOfTheMonthRow.latest_release_id)
      : undefined;
    return {
      featured: picksOn('featured')[0] ?? null,
      staffPicks: picksOn('staff_picks'),
      newThisWeek: picksOn('new_this_week'),
      artistOfTheMonth:
        artistOfTheMonthRow && artistOfTheMonthRelease
          ? {
              ...spotlightArtistCard(artistOfTheMonthRow),
              latestRelease: artistOfTheMonthRelease,
            }
          : null,
      newStars: spotlightRows
        .filter((row) => row.slot === 'new_stars')
        .map(spotlightArtistCard),
    };
  }
}

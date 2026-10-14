import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioCatalogService } from './studio-catalog.service';
import {
  LISTENABLE_ARTIST_SQL,
  listenableReleaseSql,
} from './studio-discovery-sql';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';
import { orderedCreditRoles } from './studio-persona-credit-response';
import { playableTrackAudioSql } from './studio-playlist-visibility';
import { StudioPage, StudioReleaseCard } from './studio-response';
import { STUDIO_DISCOVERY_LIMITS, StudioCreditRole } from './studio.constants';

/** A release card plus the distinct roles the persona holds across its
 *  tracks. */
export type StudioAppearsOnCard = StudioReleaseCard & {
  roles: StudioCreditRole[];
};

/**
 * `$1` the viewer, `$2` the persona, `$3`/`$4` the cursor or nulls, `$5`
 * the page size plus one. Listenable releases where the persona holds an
 * accepted credit on any playable track, newest first. `published_at` holds
 * milliseconds, the cursor's own precision.
 */
export const APPEARS_ON_SQL = `SELECT "release"."id" AS "release_id",
       "release"."published_at" AS "published_at",
       array_agg(DISTINCT CAST("credit"."role" AS text)) AS "roles"
  FROM "studio_persona_credits" "credit"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "credit"."subprofile_id" = $2
   AND "credit"."status" = 'accepted'
   AND (${playableTrackAudioSql('track', 'release')})
   AND ${listenableReleaseSql('release', 'persona', '$1')}
   AND ($3::timestamptz IS NULL
     OR ("release"."published_at", "release"."id") < ($3::timestamptz, $4::uuid))
 GROUP BY "release"."id", "release"."published_at"
 ORDER BY "release"."published_at" DESC, "release"."id" DESC
 LIMIT $5`;

interface AppearsOnRow {
  release_id: string;
  published_at: Date;
  roles: string[];
}

/** Studio discovery: the artist page "Appears on" grid. The 404 check runs
 *  first, so nothing is read for a persona the viewer cannot see. */
@Injectable()
export class StudioAppearsOnService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
  ) {}

  async listAppearsOn(
    viewerId: string,
    subprofileId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioAppearsOnCard>> {
    const found: unknown[] = await this.dataSource.query(
      LISTENABLE_ARTIST_SQL,
      [viewerId, subprofileId],
    );
    if (!found.length) {
      throw new NotFoundException('Artist not found');
    }
    const pageSize = STUDIO_DISCOVERY_LIMITS.appearsOnPerPage;
    const rows: AppearsOnRow[] = await this.dataSource.query(APPEARS_ON_SQL, [
      viewerId,
      subprofileId,
      ...keysetCursorParameters(cursor),
      pageSize + 1,
    ]);
    return toKeysetPage(
      rows,
      pageSize,
      (row) => ({ publishedAt: row.published_at, id: row.release_id }),
      async (pageRows) => {
        const cardsByReleaseId = await this.catalog.cardsByReleaseId(
          pageRows.map((row) => row.release_id),
        );
        return pageRows.flatMap((row) => {
          const releaseCard = cardsByReleaseId.get(row.release_id);
          const roles = orderedCreditRoles(row.roles);
          return releaseCard && roles.length ? [{ ...releaseCard, roles }] : [];
        });
      },
    );
  }
}

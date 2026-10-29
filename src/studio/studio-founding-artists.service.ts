import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  artistRefFromColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { landingArtistPersonaSql } from './studio-landing-sql';
import { StudioFoundingArtists } from './studio-landing-response';

/**
 * `$1` the viewer. Contract 11.1: every founding artist row whose persona
 * passes `landingArtistPersonaSql` and sits clear of a block either way with
 * the viewer, in the staff order. Ties on the position end on the row id.
 */
export const FOUNDING_ARTISTS_SQL = `SELECT ${personaColumnsSql('persona', 'artist')}
  FROM "studio_founding_artists" "founding"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "founding"."subprofile_id"
 WHERE ${landingArtistPersonaSql('persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'founding_block')}
 ORDER BY "founding"."position" ASC, "founding"."id" ASC`;

/**
 * The shelf switch. `studio_landing_settings` holds the single row 1, and a
 * missing row reads as visible.
 */
export const FOUNDING_SHELF_VISIBLE_SQL = `SELECT COALESCE(
  (SELECT "settings"."is_founding_shelf_visible"
     FROM "studio_landing_settings" "settings"
    WHERE "settings"."id" = 1),
  true
) AS "is_shelf_visible"`;

/**
 * Studio landing v2 (contracts 11.1 and 11.2): the member read of the
 * founding artists behind `GET /studio/founding-artists`. The list goes out
 * whatever the shelf switch says, because the frontend reads the id set for
 * the badge on every artist card; the switch hides the shelf and the badge
 * stays.
 */
@Injectable()
export class StudioFoundingArtistsService {
  constructor(private readonly dataSource: DataSource) {}

  async getFoundingArtists(viewerId: string): Promise<StudioFoundingArtists> {
    const [artistRows, switchRows] = await Promise.all([
      this.dataSource.query<Record<string, unknown>[]>(FOUNDING_ARTISTS_SQL, [
        viewerId,
      ]),
      this.dataSource.query<{ is_shelf_visible: boolean | null }[]>(
        FOUNDING_SHELF_VISIBLE_SQL,
      ),
    ]);
    return {
      isShelfVisible: switchRows[0]?.is_shelf_visible ?? true,
      artists: artistRows.map((row) =>
        artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
      ),
    };
  }
}

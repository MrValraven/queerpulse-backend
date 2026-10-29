import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { notBlockedEitherWaySql } from './studio-discovery-sql';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';
import { toStudioPlaylistPerson } from './studio-playlist-response';
import {
  chosenPersonaShowableSql,
  personaIdentityBlockedBySql,
  personaMemberUserIdsSql,
} from './studio-persona-members';
import { RELEASE_FOR_VIEWER_SQL } from './studio-purchase-rows';
import { STUDIO_PURCHASE_LIMITS } from './studio-purchase-rules';
import { StudioWallEntry } from './studio-purchases-response';
import { StudioPage } from './studio-response';
import {
  SupporterPersonaRow,
  toStudioSupporterIdentity,
} from './studio-supporters';
import { SUPPORTER_PERSONAS_SQL } from './studio-supporters.service';
import { studioError } from './studio.constants';

/**
 * Contract section 5. `$1` the release, `$2` the viewer, `$3` and `$4` the
 * cursor position (`decided_at`, purchase id) or two nulls, `$5` the page
 * size plus one. One row per shown identity, at its newest confirmed
 * purchase, newest first. No amount column is selected.
 */
export const RELEASE_WALL_SQL = `WITH "eligible" AS (
  SELECT "purchase"."id", "purchase"."buyer_user_id", "purchase"."is_shown_as_persona",
         "purchase"."shown_as_subprofile_id", "purchase"."decided_at",
         CASE WHEN "purchase"."is_shown_as_persona"
              THEN 'persona:' || "purchase"."shown_as_subprofile_id"::text
              ELSE 'account:' || "purchase"."buyer_user_id"::text
         END AS "identity_key"
    FROM "studio_purchases" "purchase"
    INNER JOIN "studio_releases" "release" ON "release"."id" = $1::uuid
    INNER JOIN "users" "buyer"
            ON "buyer"."id" = "purchase"."buyer_user_id"
           AND "buyer"."status" = 'active'
   WHERE "purchase"."status" = 'confirmed'
     AND "purchase"."is_on_wall"
     AND (
       "purchase"."release_id" = $1::uuid
       OR "purchase"."track_id" IN (SELECT "wall_track"."id" FROM "studio_tracks" "wall_track" WHERE "wall_track"."release_id" = $1::uuid)
     )
     AND EXISTS (SELECT 1 FROM "studio_access_grants" "wall_grant" WHERE "wall_grant"."user_id" = "purchase"."buyer_user_id")
     AND ${notBlockedEitherWaySql('$2::uuid', '"purchase"."buyer_user_id"', 'wall_block')}
     AND "purchase"."buyer_user_id" NOT IN ${personaMemberUserIdsSql('"release"."subprofile_id"')}
     AND (
       NOT "purchase"."is_shown_as_persona"
       OR (
         "purchase"."shown_as_subprofile_id" IS NOT NULL
         AND "purchase"."buyer_user_id" IN ${personaMemberUserIdsSql('"purchase"."shown_as_subprofile_id"')}
         AND ${chosenPersonaShowableSql('"purchase"."shown_as_subprofile_id"')}
         AND NOT ${personaIdentityBlockedBySql('($2::uuid)', '"purchase"."shown_as_subprofile_id"')}
       )
     )
),
"one_per_identity" AS (
  SELECT DISTINCT ON ("identity_key") *
    FROM "eligible"
   ORDER BY "identity_key", "decided_at" DESC, "id" DESC
)
SELECT "id", "buyer_user_id", "is_shown_as_persona", "shown_as_subprofile_id", "decided_at"
  FROM "one_per_identity"
 WHERE $3::timestamptz IS NULL OR ("decided_at", "id") < ($3::timestamptz, $4::uuid)
 ORDER BY "decided_at" DESC, "id" DESC
 LIMIT $5`;

/** One `RELEASE_WALL_SQL` row. The buyer id stays on the server: it only
 *  feeds the member lookup. */
export interface ReleaseWallRow {
  id: string;
  buyer_user_id: string;
  is_shown_as_persona: boolean;
  shown_as_subprofile_id: string | null;
  decided_at: Date | string;
}

/**
 * The supporter wall of a release, contract sections 3.5 and 5. A viewer who
 * can read the release (a persona member, or a listener the release is
 * listenable for) sees the members who bought the release or a track
 * currently on it, had the purchase confirmed and chose to appear on the
 * wall. Each buyer account is active, holds a Studio grant and sits outside
 * the release persona's members today; no block stands either way between
 * viewer and buyer; a chosen persona still exists, still counts the buyer as
 * a member, carries no removal or moderator hide, and the viewer has not
 * identity-blocked it; a persona choice whose persona is gone drops the
 * entry and the account never appears in its place. Each shown identity (an
 * account, or a persona shared by co-owners) appears once, at its newest
 * confirmed purchase, ordered by decision time then purchase id, 24 per
 * page. Amounts are never selected. The account key is `account:` plus the
 * purchase id of the identity's newest entry, so no user id reaches the
 * wire.
 */
@Injectable()
export class StudioPurchaseWallService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /** Route 9: 404 `studio_purchase_item_not_found` for a release the viewer
   *  cannot read, before the wall read. */
  async listWall(
    viewerId: string,
    releaseId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioWallEntry>> {
    const releaseRows: { release_id: string }[] = await this.dataSource.query(
      RELEASE_FOR_VIEWER_SQL,
      [releaseId, viewerId],
    );
    const release = releaseRows[0];
    if (!release) {
      throw studioError('studio_purchase_item_not_found');
    }
    const pageSize = STUDIO_PURCHASE_LIMITS.wallPerPage;
    const rows: ReleaseWallRow[] = await this.dataSource.query(
      RELEASE_WALL_SQL,
      [
        release.release_id,
        viewerId,
        ...keysetCursorParameters(cursor),
        pageSize + 1,
      ],
    );
    return toKeysetPage(
      rows,
      pageSize,
      (row) => ({ publishedAt: new Date(row.decided_at), id: row.id }),
      (pageRows) => this.toWallEntries(pageRows),
    );
  }

  /** One member lookup for the account entries and one persona read for the
   *  persona entries. A persona that no longer resolves drops its entry. */
  private async toWallEntries(
    rows: ReleaseWallRow[],
  ): Promise<StudioWallEntry[]> {
    const accountBuyerIds = [
      ...new Set(
        rows
          .filter((row) => !row.is_shown_as_persona)
          .map((row) => row.buyer_user_id),
      ),
    ];
    const members = await new MemberLookup(this.profiles).byUserIds(
      accountBuyerIds,
    );
    const personasById = await this.personasById(rows);
    return rows.flatMap((row): StudioWallEntry[] => {
      if (!row.is_shown_as_persona) {
        return [
          {
            key: `account:${row.id}`,
            identity: {
              kind: 'account',
              member: toStudioPlaylistPerson(members.get(row.buyer_user_id)),
            },
          },
        ];
      }
      if (row.shown_as_subprofile_id === null) {
        return [];
      }
      const identity = toStudioSupporterIdentity(
        row.shown_as_subprofile_id,
        undefined,
        personasById,
      );
      return identity
        ? [{ key: `persona:${row.shown_as_subprofile_id}`, identity }]
        : [];
    });
  }

  private async personasById(
    rows: ReleaseWallRow[],
  ): Promise<Map<string, SupporterPersonaRow>> {
    const personaIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.is_shown_as_persona && row.shown_as_subprofile_id !== null
            ? [row.shown_as_subprofile_id]
            : [],
        ),
      ),
    ];
    if (!personaIds.length) {
      return new Map();
    }
    const personaRows: SupporterPersonaRow[] = await this.dataSource.query(
      SUPPORTER_PERSONAS_SQL,
      [personaIds],
    );
    return new Map(
      personaRows.map((personaRow) => [personaRow.id, personaRow]),
    );
  }
}

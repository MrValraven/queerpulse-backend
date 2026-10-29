import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { ModAuditService } from '../moderation/mod-audit.service';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import { listsEveryIdOnce } from './admin-studio-curation.service';
import {
  AdminLandingPreviewRow,
  AdminLandingTrackOptionRow,
  AdminStudioLandingPreview,
  AdminStudioLandingTrackOption,
  markPreviewsOnLanding,
  toAdminStudioLandingPreview,
  toAdminStudioLandingTrackOption,
} from './admin-studio-landing-response';
import { StudioLandingPreview } from './entities/studio-landing-preview.entity';
import {
  personaColumnsSql,
  STUDIO_ARTIST_KIND_LIST_SQL,
} from './studio-discovery-sql';
import { invalidateStudioLandingMemo } from './studio-landing-memo';
import {
  grantHoldingPersonaMembersSql,
  landingPreviewIneligibleReasonSql,
} from './studio-landing-sql';
import {
  STUDIO_DISCOVERY_LIMITS,
  STUDIO_LIMITS,
  studioError,
  studioErrorWithDetails,
} from './studio.constants';
import {
  STUDIO_LANDING_PREVIEW_REQUESTED,
  StudioLandingPreviewRequestedEvent,
} from './studio.events';

/** The partial unique index that keeps one open request per track. */
const OPEN_TRACK_CONSTRAINT = 'UQ_studio_landing_previews_open_track';

/** The statuses that hold a place on the staff list and count toward the cap. */
const OPEN_STATUSES_SQL = `('pending', 'approved')`;

/** Every preview write that reads the open rows takes this first, so a
 *  request, a second request and a reorder run one at a time: the cap and
 *  the next position read what the last write committed. The scenes lock
 *  shape; staff-only and tiny. */
export const LOCK_PREVIEWS_SQL =
  'LOCK TABLE "studio_landing_previews" IN SHARE ROW EXCLUSIVE MODE';

/** Contract 9.1 staff columns over `PREVIEWS_FROM_SQL`, read by
 *  `toAdminStudioLandingPreview`. The reason is the first failing rule of
 *  contract 1.2, NULL for a track that may play. */
export const ADMIN_PREVIEW_COLUMNS_SQL = `"preview"."id" AS "id",
       "preview"."status"::text AS "status",
       "preview"."position" AS "position",
       "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "track"."duration_seconds" AS "track_duration_seconds",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."cover_key" AS "release_cover_key",
       ${personaColumnsSql('persona', 'artist')},
       ${landingPreviewIneligibleReasonSql('track', 'release', 'persona')} AS "ineligible_reason",
       "preview"."requested_by_id" AS "requested_by_id",
       "preview"."created_at" AS "requested_at",
       "preview"."decided_by_id" AS "decided_by_id",
       "preview"."decided_at" AS "decided_at"`;

/** The release persona is the artist of a preview. */
const PREVIEWS_FROM_SQL = `FROM "studio_landing_previews" "preview"
 INNER JOIN "studio_tracks" "track" ON "track"."id" = "preview"."track_id"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"`;

/** Open rows (pending, approved) in landing order. */
const OPEN_PREVIEWS_SQL = `SELECT ${ADMIN_PREVIEW_COLUMNS_SQL}
  ${PREVIEWS_FROM_SQL}
 WHERE "preview"."status" IN ${OPEN_STATUSES_SQL}
 ORDER BY "preview"."position" ASC, "preview"."id" ASC`;

/** `$1` the limit. Decided rows (declined, withdrawn), newest decision first. */
const DECIDED_PREVIEWS_SQL = `SELECT ${ADMIN_PREVIEW_COLUMNS_SQL}
  ${PREVIEWS_FROM_SQL}
 WHERE "preview"."status" IN ('declined', 'withdrawn')
 ORDER BY "preview"."decided_at" DESC NULLS LAST, "preview"."id" ASC
 LIMIT $1`;

/** `$1` a preview id. The single-row variant of the staff list. */
const PREVIEW_BY_ID_SQL = `SELECT ${ADMIN_PREVIEW_COLUMNS_SQL}
  ${PREVIEWS_FROM_SQL}
 WHERE "preview"."id" = $1`;

/** `$1` a track. One row `{ ineligible_reason, release_persona_id }`, or
 *  none for an unknown track. */
export const TRACK_ELIGIBILITY_SQL = `SELECT ${landingPreviewIneligibleReasonSql('track', 'release', 'persona')} AS "ineligible_reason",
       "release"."subprofile_id" AS "release_persona_id"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "track"."id" = $1`;

/** `$1` a track. One row: the open rows in all and the open rows for that
 *  track, so the contract 9.2 checks 2 and 3 read one snapshot. */
export const OPEN_PREVIEW_COUNT_SQL = `SELECT COUNT(*)::int AS "open_count",
       (COUNT(*) FILTER (WHERE "open_preview"."track_id" = $1))::int AS "track_open_count"
  FROM "studio_landing_previews" "open_preview"
 WHERE "open_preview"."status" IN ${OPEN_STATUSES_SQL}`;

/** `$1` a persona. One row while a member of the persona holds a Studio
 *  grant on an active account, so somebody can answer the request. */
export const REACHABLE_OWNER_SQL = `SELECT 1 FROM ${grantHoldingPersonaMembersSql('$1', 'reachable')} "reachable_owner" LIMIT 1`;

/** `$1` the track, `$2` the staff member. A pending row after the last open
 *  position. The aggregate always answers one row. */
const INSERT_PREVIEW_SQL = `INSERT INTO "studio_landing_previews" ("track_id", "status", "position", "requested_by_id")
SELECT $1::uuid, 'pending'::"studio_landing_previews_status_enum", COALESCE(MAX("position"), 0) + 1, $2::uuid
  FROM "studio_landing_previews"
 WHERE "status" IN ${OPEN_STATUSES_SQL}
RETURNING "id"`;

const OPEN_PREVIEW_IDS_SQL = `SELECT "id" FROM "studio_landing_previews"
 WHERE "status" IN ${OPEN_STATUSES_SQL}`;

/** `$1` the open ids in the new order. Positions rewrite to 1..n in one
 *  statement. */
const REORDER_PREVIEWS_SQL = `UPDATE "studio_landing_previews" AS "preview" SET "position" = "ordered"."position", "updated_at" = now() FROM unnest($1::uuid[]) WITH ORDINALITY AS "ordered"("id", "position") WHERE "preview"."id" = "ordered"."id"`;

/** `$1` the LIKE pattern, `$2` the limit. Contract 9.1 track search: tracks
 *  of published releases by an artist kind, matched on the folded track
 *  title, release title or persona name. */
const TRACK_SEARCH_SQL = `SELECT "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "track"."duration_seconds" AS "track_duration_seconds",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."cover_key" AS "release_cover_key",
       ${personaColumnsSql('persona', 'artist')},
       ${landingPreviewIneligibleReasonSql('track', 'release', 'persona')} AS "ineligible_reason",
       EXISTS (
         SELECT 1 FROM "studio_landing_previews" "open_preview"
          WHERE "open_preview"."track_id" = "track"."id"
            AND "open_preview"."status" IN ${OPEN_STATUSES_SQL}
       ) AS "has_open_preview"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."status" = 'published'
   AND "persona"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
   AND (${foldedHaystack('track', ['title'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
     OR ${foldedHaystack('release', ['title'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
     OR ${foldedHaystack('persona', ['display_name'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\')
 ORDER BY "release"."published_at" DESC NULLS LAST, "track"."position" ASC, "track"."id" ASC
 LIMIT $2`;

/**
 * Studio landing v2, the staff side of the track previews (contract 9.2 and
 * 9.3). Staff ask an artist to show a track: one transaction under
 * `LOCK_PREVIEWS_SQL` checks the track against the landing rules, the one
 * open request per track, the cap of open rows and a reachable owner, then
 * files a pending row after the last open position. Once it commits the
 * request goes to the owners (`STUDIO_LANDING_PREVIEW_REQUESTED`). Staff
 * remove a row in any status at any time and reorder the open rows. Owners
 * approve, decline and withdraw through `StudioLandingPreviewsService`.
 * Every write bumps the landing memo after it resolves.
 */
@Injectable()
export class AdminStudioLandingPreviewsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly modAudit: ModAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Open rows by position, then up to `landingDecidedPreviewsShown`
   *  decided rows, newest decision first. */
  async listPreviews(): Promise<AdminStudioLandingPreview[]> {
    const openRows: AdminLandingPreviewRow[] =
      await this.dataSource.query(OPEN_PREVIEWS_SQL);
    const decidedRows: AdminLandingPreviewRow[] = await this.dataSource.query(
      DECIDED_PREVIEWS_SQL,
      [STUDIO_LIMITS.landingDecidedPreviewsShown],
    );
    return this.toPreviews([...openRows, ...decidedRows], openRows);
  }

  async searchTracks(
    query: string,
  ): Promise<{ items: AdminStudioLandingTrackOption[] }> {
    const rows: AdminLandingTrackOptionRow[] = await this.dataSource.query(
      TRACK_SEARCH_SQL,
      [
        `%${escapeLikeTerm(query.trim())}%`,
        STUDIO_DISCOVERY_LIMITS.adminSearchResults,
      ],
    );
    return { items: rows.map((row) => toAdminStudioLandingTrackOption(row)) };
  }

  async requestPreview(
    staffUserId: string,
    trackId: string,
  ): Promise<AdminStudioLandingPreview> {
    let previewId: string;
    try {
      previewId = await this.dataSource.transaction(async (manager) => {
        await manager.query(LOCK_PREVIEWS_SQL);
        const eligibilityRows: {
          ineligible_reason: string | null;
          release_persona_id: string;
        }[] = await manager.query(TRACK_ELIGIBILITY_SQL, [trackId]);
        const eligibility = eligibilityRows[0];
        if (!eligibility) {
          throw studioErrorWithDetails(
            'studio_landing_preview_track_not_eligible',
            { ineligibleReason: 'not_playable' },
          );
        }
        if (eligibility.ineligible_reason !== null) {
          throw studioErrorWithDetails(
            'studio_landing_preview_track_not_eligible',
            { ineligibleReason: eligibility.ineligible_reason },
          );
        }
        const countRows: { open_count: number; track_open_count: number }[] =
          await manager.query(OPEN_PREVIEW_COUNT_SQL, [trackId]);
        const openCount = countRows[0]?.open_count ?? 0;
        const trackOpenCount = countRows[0]?.track_open_count ?? 0;
        if (trackOpenCount > 0) {
          throw studioError('studio_landing_preview_exists');
        }
        if (openCount >= STUDIO_LIMITS.landingOpenPreviewsMax) {
          throw studioError('studio_landing_previews_full');
        }
        const reachableRows: unknown[] = await manager.query(
          REACHABLE_OWNER_SQL,
          [eligibility.release_persona_id],
        );
        if (reachableRows.length === 0) {
          throw studioError('studio_landing_preview_no_reachable_owner');
        }
        const insertedRows: { id: string }[] = await manager.query(
          INSERT_PREVIEW_SQL,
          [trackId, staffUserId],
        );
        const inserted = insertedRows[0];
        if (!inserted) {
          throw new Error('Preview insert returned no row');
        }
        return inserted.id;
      });
    } catch (error) {
      // A request that committed first surfaces as the unique violation; it
      // answers the same 409 the open row check gives.
      if (isUniqueViolation(error, OPEN_TRACK_CONSTRAINT)) {
        throw studioError('studio_landing_preview_exists');
      }
      throw error;
    }
    const requestedEvent: StudioLandingPreviewRequestedEvent = { previewId };
    this.eventEmitter.emit(STUDIO_LANDING_PREVIEW_REQUESTED, requestedEvent);
    invalidateStudioLandingMemo();
    return this.loadPreviewOrThrow(previewId);
  }

  /** Staff removal: deletes the row whatever its status. No notification. */
  async removePreview(previewId: string): Promise<void> {
    const result = await this.dataSource
      .getRepository(StudioLandingPreview)
      .delete({ id: previewId });
    if (!result.affected) {
      throw studioError('studio_landing_preview_not_found');
    }
    invalidateStudioLandingMemo();
  }

  /** Every open preview exactly once; answers the open rows in the new order. */
  async reorderPreviews(
    previewIds: string[],
  ): Promise<AdminStudioLandingPreview[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PREVIEWS_SQL);
      const openRows: { id: string }[] =
        await manager.query(OPEN_PREVIEW_IDS_SQL);
      if (
        !listsEveryIdOnce(
          openRows.map((row) => row.id),
          previewIds,
        )
      ) {
        throw studioError('studio_landing_order_mismatch');
      }
      await manager.query(REORDER_PREVIEWS_SQL, [previewIds]);
    });
    invalidateStudioLandingMemo();
    const openRows: AdminLandingPreviewRow[] =
      await this.dataSource.query(OPEN_PREVIEWS_SQL);
    return this.toPreviews(openRows, openRows);
  }

  /** The single-row variant of `listPreviews`. An approved row reads its
   *  landing place from the open rows; any other status is off the landing. */
  private async loadPreviewOrThrow(
    previewId: string,
  ): Promise<AdminStudioLandingPreview> {
    const rows: AdminLandingPreviewRow[] = await this.dataSource.query(
      PREVIEW_BY_ID_SQL,
      [previewId],
    );
    const row = rows[0];
    if (!row) {
      throw studioError('studio_landing_preview_not_found');
    }
    const openRows: AdminLandingPreviewRow[] =
      row.status === 'approved'
        ? await this.dataSource.query(OPEN_PREVIEWS_SQL)
        : [];
    const [preview] = await this.toPreviews([row], openRows);
    if (!preview) {
      throw studioError('studio_landing_preview_not_found');
    }
    return preview;
  }

  /** Maps rows with one batched name read over the requesting staff and the
   *  deciding owners; `isOnLanding` comes from the open rows in landing
   *  order. */
  private async toPreviews(
    rows: readonly AdminLandingPreviewRow[],
    openRows: readonly AdminLandingPreviewRow[],
  ): Promise<AdminStudioLandingPreview[]> {
    const idsOnLanding = markPreviewsOnLanding(openRows);
    const userIds = rows.flatMap((row) =>
      [row.requested_by_id, row.decided_by_id].filter(
        (userId): userId is string => userId !== null,
      ),
    );
    const userNames = await this.modAudit.namesForUserIds(userIds);
    return rows.map((row) =>
      toAdminStudioLandingPreview(row, userNames, idsOnLanding.has(row.id)),
    );
  }
}

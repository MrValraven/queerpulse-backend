import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { personaColumnsSql } from './studio-discovery-sql';
import { invalidateStudioLandingMemo } from './studio-landing-memo';
import {
  OwnerPreviewRow,
  StudioLandingPreviewOwnerItem,
  StudioLandingPreviewOwnerList,
  toStudioLandingPreviewOwnerItem,
} from './studio-landing-response';
import { landingPreviewEligibleSql } from './studio-landing-sql';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  StudioErrorCode,
  StudioLandingPreviewStatus,
  isStudioArtistPersonaKind,
  studioError,
} from './studio.constants';
import {
  STUDIO_LANDING_PREVIEW_APPROVED,
  StudioLandingPreviewApprovedEvent,
} from './studio.events';

/** The columns of one owner row, read the same way by the list and the row read. */
const OWNER_PREVIEW_COLUMNS_SQL = `"preview"."id" AS "id",
       "preview"."status"::text AS "status",
       "preview"."created_at" AS "requested_at",
       "preview"."decided_at" AS "decided_at",
       CASE WHEN "release"."subprofile_id" = $1 THEN 'main' ELSE 'credited' END AS "relation",
       "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "track"."duration_seconds" AS "track_duration_seconds",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."cover_key" AS "release_cover_key",
       ${personaColumnsSql('persona', 'main_artist')},
       COALESCE(${landingPreviewEligibleSql('track', 'release', 'persona')}, false) AS "is_eligible"
  FROM "studio_landing_previews" "preview"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "preview"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"`;

/** `$1` the persona: an accepted credit of that persona on the row's track. */
const ACCEPTED_CREDIT_SQL = `EXISTS (
          SELECT 1 FROM "studio_persona_credits" "credit"
           WHERE "credit"."track_id" = "track"."id"
             AND "credit"."subprofile_id" = $1
             AND "credit"."status" = 'accepted')`;

/** `$1` the persona. Its kind decides whether it has an approvals list at all. */
export const OWNER_PERSONA_SQL = `SELECT "persona"."id" AS "id", "persona"."kind"::text AS "kind"
  FROM "subprofiles" "persona"
 WHERE "persona"."id" = $1`;

/**
 * Contract 10 list, `$1` the persona: pending rows of its own releases, then
 * approved rows of its own releases (`main`) or of tracks it holds an
 * accepted credit on (`credited`). A persona both main and credited reads
 * `main`. Pending rows come first by request time, approved rows by decision
 * time, newest first.
 */
export const OWNER_PREVIEW_LIST_SQL = `SELECT ${OWNER_PREVIEW_COLUMNS_SQL}
 WHERE ("preview"."status" = 'pending' AND "release"."subprofile_id" = $1)
    OR ("preview"."status" = 'approved' AND ("release"."subprofile_id" = $1 OR ${ACCEPTED_CREDIT_SQL}))
 ORDER BY ("preview"."status" = 'pending') DESC,
          CASE WHEN "preview"."status" = 'pending' THEN "preview"."created_at" END ASC,
          "preview"."decided_at" DESC NULLS LAST,
          "preview"."id" ASC`;

/**
 * Contract delta 4, `$1` the persona, `$2` the preview: the row in any
 * status, while the persona has a link to it (the release persona or an
 * accepted credit on the track). No row means no link.
 */
export const OWNER_PREVIEW_ROW_SQL = `SELECT ${OWNER_PREVIEW_COLUMNS_SQL}
 WHERE "preview"."id" = $2
   AND ("release"."subprofile_id" = $1 OR ${ACCEPTED_CREDIT_SQL})`;

/**
 * Contract 9.3 guarded write: `$1` the preview, `$2` the new status, `$3` the
 * deciding member, `$4` the status the row must still hold. The row lock
 * makes a second writer wait, then re-check `$4` against the first writer's
 * result, so exactly one owner decides. Wrapped in a CTE so the raw query
 * answers plain rows: one `id` when this call decided, none otherwise.
 */
export const OWNER_PREVIEW_UPDATE_SQL = `WITH "decided" AS (
  UPDATE "studio_landing_previews"
     SET "status" = $2::"studio_landing_previews_status_enum",
         "decided_by_id" = $3,
         "decided_at" = now(),
         "updated_at" = now()
   WHERE "id" = $1
     AND "status" = $4::"studio_landing_previews_status_enum"
  RETURNING "id"
)
SELECT "id" FROM "decided"`;

interface OwnerPreviewAction {
  /** The status the row must hold for the action to apply. */
  requiredStatus: StudioLandingPreviewStatus;
  nextStatus: StudioLandingPreviewStatus;
  /** Approve and decline belong to the release persona alone. */
  isMainPersonaOnly: boolean;
  /** The refusal when the row holds another status. */
  wrongStatusCode: StudioErrorCode;
}

const APPROVE_ACTION: OwnerPreviewAction = {
  requiredStatus: 'pending',
  nextStatus: 'approved',
  isMainPersonaOnly: true,
  wrongStatusCode: 'studio_landing_preview_not_pending',
};

const DECLINE_ACTION: OwnerPreviewAction = {
  requiredStatus: 'pending',
  nextStatus: 'declined',
  isMainPersonaOnly: true,
  wrongStatusCode: 'studio_landing_preview_not_pending',
};

const WITHDRAW_ACTION: OwnerPreviewAction = {
  requiredStatus: 'approved',
  nextStatus: 'withdrawn',
  isMainPersonaOnly: false,
  wrongStatusCode: 'studio_landing_preview_not_approved',
};

/**
 * Studio landing v2, contract 9.3 and 10: the artist dashboard approvals. A
 * member of the release persona approves or declines a pending preview; a
 * member of the release persona or of a persona with an accepted credit on
 * the track withdraws an approved one. The first owner to act decides
 * through the guarded update (`OWNER_PREVIEW_UPDATE_SQL`), and every later
 * caller reads 409. The deciding member is stored in `decided_by_id` and
 * stays server-side: no answer carries a member field. Every write bumps the
 * landing memo once it has committed, and only a won approval emits
 * `STUDIO_LANDING_PREVIEW_APPROVED`.
 */
@Injectable()
export class StudioLandingPreviewsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Contract 10 list. A persona of a kind outside the Studio artist kinds lists nothing. */
  async listForPersona(
    viewerId: string,
    subprofileId: string,
  ): Promise<StudioLandingPreviewOwnerList> {
    const persona = await this.ownedPersona(viewerId, subprofileId);
    if (!isStudioArtistPersonaKind(persona.kind)) {
      return { items: [] };
    }
    const rows: OwnerPreviewRow[] = await this.dataSource.query(
      OWNER_PREVIEW_LIST_SQL,
      [persona.id],
    );
    return { items: rows.map((row) => toStudioLandingPreviewOwnerItem(row)) };
  }

  approve(
    viewerId: string,
    subprofileId: string,
    previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.decide(viewerId, subprofileId, previewId, APPROVE_ACTION);
  }

  decline(
    viewerId: string,
    subprofileId: string,
    previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.decide(viewerId, subprofileId, previewId, DECLINE_ACTION);
  }

  withdraw(
    viewerId: string,
    subprofileId: string,
    previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.decide(viewerId, subprofileId, previewId, WITHDRAW_ACTION);
  }

  /**
   * Membership comes before any read, as `StudioStatsService.getArtistStats`
   * does; an unknown persona answers the same 404.
   */
  private async ownedPersona(
    viewerId: string,
    subprofileId: string,
  ): Promise<{ id: string; kind: string }> {
    if (!(await this.ownership.isPersonaMember(viewerId, subprofileId))) {
      throw new NotFoundException('Artist not found');
    }
    const rows: { id: string; kind: string }[] = await this.dataSource.query(
      OWNER_PERSONA_SQL,
      [subprofileId],
    );
    const persona = rows[0];
    if (!persona) {
      throw new NotFoundException('Artist not found');
    }
    return persona;
  }

  private async linkedRow(
    personaId: string,
    previewId: string,
  ): Promise<OwnerPreviewRow | undefined> {
    const rows: OwnerPreviewRow[] = await this.dataSource.query(
      OWNER_PREVIEW_ROW_SQL,
      [personaId, previewId],
    );
    return rows[0];
  }

  /**
   * Contract delta 4: no link is 404; approve or decline from a credited
   * persona is 403; a row in another status is 409. A guarded update that
   * changes nothing re-reads the row, so a caller who lost the race to
   * another owner reads 409 (or 404 when staff removed the row meanwhile).
   */
  private async decide(
    viewerId: string,
    subprofileId: string,
    previewId: string,
    action: OwnerPreviewAction,
  ): Promise<StudioLandingPreviewOwnerItem> {
    const persona = await this.ownedPersona(viewerId, subprofileId);
    if (!isStudioArtistPersonaKind(persona.kind)) {
      throw studioError('studio_landing_preview_not_found');
    }
    const currentRow = await this.linkedRow(persona.id, previewId);
    if (!currentRow) {
      throw studioError('studio_landing_preview_not_found');
    }
    if (action.isMainPersonaOnly && currentRow.relation !== 'main') {
      throw studioError('studio_landing_preview_main_persona_only');
    }
    const decidedRows: { id: string }[] = await this.dataSource.query(
      OWNER_PREVIEW_UPDATE_SQL,
      [currentRow.id, action.nextStatus, viewerId, action.requiredStatus],
    );
    if (decidedRows.length === 0) {
      const rowAfterRace = await this.linkedRow(persona.id, previewId);
      if (!rowAfterRace) {
        throw studioError('studio_landing_preview_not_found');
      }
      throw studioError(action.wrongStatusCode);
    }
    invalidateStudioLandingMemo();
    if (action.nextStatus === 'approved') {
      this.eventEmitter.emit(STUDIO_LANDING_PREVIEW_APPROVED, {
        previewId: currentRow.id,
        approverUserId: viewerId,
      } satisfies StudioLandingPreviewApprovedEvent);
    }
    const decidedRow = await this.linkedRow(persona.id, previewId);
    if (!decidedRow) {
      throw studioError('studio_landing_preview_not_found');
    }
    return toStudioLandingPreviewOwnerItem(decidedRow);
  }
}

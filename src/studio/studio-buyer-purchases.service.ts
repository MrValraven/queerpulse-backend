import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { SUBPROFILE_MODERATION_SUBJECT_TYPE } from '../subprofiles/subprofile-takedown';
import { Profile } from '../users/entities/profile.entity';
import { StudioPurchaseStatus } from './entities/studio-purchase.entity';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';
import {
  KEPT_TRACKS_OF_PURCHASES_SQL,
  KeptTrackRow,
  toKeptDownloadTrack,
} from './studio-kept-tracks';
import {
  chosenPersonaShowableSql,
  personaMemberUserIdsSql,
} from './studio-persona-members';
import {
  PURCHASE_ROW_SELECT_SQL,
  PurchaseRow,
  toStudioPurchaseArtist,
  toStudioPurchaseItem,
} from './studio-purchase-rows';
import {
  STUDIO_PURCHASE_LIMITS,
  studioDownloadFormat,
  studioLiveDownloadRefusal,
} from './studio-purchase-rules';
import {
  StudioBuyerPurchase,
  StudioPurchaseDownloadTrack,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';
import { SUPPORTER_PERSONAS_SQL } from './studio-supporters.service';
import {
  SupporterPersonaRow,
  toStudioSupporterIdentity,
} from './studio-supporters';

/**
 * `$1` the buyer, `$2` the purchase ids. The buyer filter is part of the
 * statement, so a purchase of another member never comes back.
 */
export const BUYER_PURCHASES_BY_IDS_SQL = `${PURCHASE_ROW_SELECT_SQL}
 WHERE "purchase"."buyer_user_id" = $1::uuid
   AND "purchase"."id" = ANY($2::uuid[])`;

/**
 * Contract 3.6. `$1` the buyer, `$2` the status or null (every status), `$3`
 * and `$4` the cursor position or nulls, `$5` the page size plus one. Newest
 * first on `IDX_studio_purchases_buyer_created_at`; `created_at` holds
 * milliseconds, the cursor's own precision.
 */
export const BUYER_PURCHASES_PAGE_SQL = `${PURCHASE_ROW_SELECT_SQL}
 WHERE "purchase"."buyer_user_id" = $1::uuid
   AND ($2::text IS NULL OR "purchase"."status"::text = $2::text)
   AND ($3::timestamptz IS NULL
     OR ("purchase"."created_at", "purchase"."id") < ($3::timestamptz, $4::uuid))
 ORDER BY "purchase"."created_at" DESC, "purchase"."id" DESC
 LIMIT $5`;

/**
 * Contract 3.2 `downloads` for purchases with no kept rows. `$1` the purchase
 * ids. For each confirmed purchase with a live item: a release purchase lists
 * the tracks of its release now, a track purchase its track, by position. The
 * release status, the persona's `removed_at` and the persona moderation flag
 * (a moderator hide or removal, the `chosenPersonaShowableSql` rule) ride on
 * every row for `studioLiveDownloadRefusal`.
 */
export const LIVE_DOWNLOAD_TRACKS_SQL = `SELECT "purchase"."id" AS "purchase_id",
       "track"."id" AS "track_id",
       "track"."position" AS "position",
       "track"."title" AS "title",
       "track"."duration_seconds" AS "duration_seconds",
       "track"."audio_key" AS "audio_key",
       "track"."audio_content_type" AS "audio_content_type",
       "track"."withheld_at" AS "withheld_at",
       "release"."status"::text AS "release_status",
       "persona"."removed_at" AS "persona_removed_at",
       EXISTS (
         SELECT 1 FROM "content_moderation" "persona_moderation"
          WHERE "persona_moderation"."subject_type" = '${SUBPROFILE_MODERATION_SUBJECT_TYPE}'
            AND "persona_moderation"."subject_id" = "persona"."id"::text
            AND (
              "persona_moderation"."hidden_at" IS NOT NULL
              OR "persona_moderation"."removed_at" IS NOT NULL
            )
       ) AS "is_persona_moderated"
  FROM "studio_purchases" "purchase"
  INNER JOIN "studio_tracks" "track"
    ON ("purchase"."item_kind"::text = 'release' AND "track"."release_id" = "purchase"."release_id")
    OR ("purchase"."item_kind"::text = 'track' AND "track"."id" = "purchase"."track_id")
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "purchase"."id" = ANY($1::uuid[])
   AND "purchase"."status"::text = '${StudioPurchaseStatus.Confirmed}'
 ORDER BY "purchase"."id" ASC, "track"."position" ASC, "track"."id" ASC`;

/**
 * `$1` the persona ids the buyer chose to show, `$2` the buyer: the rows of
 * `SUPPORTER_PERSONAS_SQL` that still pass `chosenPersonaShowableSql` and
 * still count the buyer as a member (the `MEMBER_PERSONAS_SQL` options the
 * wall state resolves against). A persona that is removed, under a moderator
 * takedown or left by the buyer is absent, so its purchase asks the buyer to
 * pick again.
 */
export const WALL_PERSONAS_SQL = `SELECT "shown_persona".*
  FROM (${SUPPORTER_PERSONAS_SQL}) "shown_persona"
 WHERE ${chosenPersonaShowableSql('"shown_persona"."id"')}
   AND $2::uuid IN ${personaMemberUserIdsSql('"shown_persona"."id"')}`;

interface LiveDownloadTrackRow {
  purchase_id: string;
  track_id: string;
  position: number;
  title: string;
  duration_seconds: number | null;
  audio_key: string | null;
  audio_content_type: string | null;
  withheld_at: Date | null;
  release_status: string;
  persona_removed_at: Date | null;
  is_persona_moderated: boolean;
}

function toIsoString(value: Date | string): string {
  return new Date(value).toISOString();
}

function toLiveDownloadTrack(
  row: LiveDownloadTrackRow,
): StudioPurchaseDownloadTrack {
  return {
    trackId: row.track_id,
    position: row.position,
    title: row.title,
    durationSeconds: row.duration_seconds,
    format: studioDownloadFormat(row.audio_content_type),
    unavailableReason: studioLiveDownloadRefusal({
      releaseStatus: row.release_status,
      isPersonaRemoved: row.persona_removed_at !== null,
      isPersonaModerated: row.is_persona_moderated,
      isTrackWithheld: row.withheld_at !== null,
      audioKey: row.audio_key,
      audioContentType: row.audio_content_type,
    }),
  };
}

function groupByPurchaseId<Row extends { purchase_id: string }, Item>(
  rows: Row[],
  toItem: (row: Row) => Item,
): Map<string, Item[]> {
  const itemsByPurchaseId = new Map<string, Item[]>();
  for (const row of rows) {
    const purchaseItems = itemsByPurchaseId.get(row.purchase_id) ?? [];
    purchaseItems.push(toItem(row));
    itemsByPurchaseId.set(row.purchase_id, purchaseItems);
  }
  return itemsByPurchaseId;
}

/**
 * The one builder for every `StudioBuyerPurchase` (create, offer, buyer
 * list), so the purchase looks the same on every surface. Per call it reads
 * the purchase rows, the kept rows of the confirmed ones, the live tracks of
 * the confirmed ones without kept rows, the buyer's profile and the chosen
 * wall personas. No response carries the buyer's user id.
 */
@Injectable()
export class StudioBuyerPurchasesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /** The caller's own purchases among `purchaseIds`, in the order given. An
   *  id that is unknown or belongs to another member is left out. */
  async readByIds(
    userId: string,
    purchaseIds: string[],
  ): Promise<StudioBuyerPurchase[]> {
    if (!purchaseIds.length) {
      return [];
    }
    const rows: PurchaseRow[] = await this.dataSource.query(
      BUYER_PURCHASES_BY_IDS_SQL,
      [userId, purchaseIds],
    );
    const purchasesById = new Map(
      (await this.buildPurchases(userId, rows)).map((purchase) => [
        purchase.id,
        purchase,
      ]),
    );
    return purchaseIds.flatMap((purchaseId) => {
      const purchase = purchasesById.get(purchaseId);
      return purchase ? [purchase] : [];
    });
  }

  /** Contract 3.6: 30 per page, newest first. */
  async listPage(
    userId: string,
    status: 'confirmed' | undefined,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioBuyerPurchase>> {
    const pageSize = STUDIO_PURCHASE_LIMITS.purchasesPerPage;
    const rows: PurchaseRow[] = await this.dataSource.query(
      BUYER_PURCHASES_PAGE_SQL,
      [userId, status ?? null, ...keysetCursorParameters(cursor), pageSize + 1],
    );
    return toKeysetPage(
      rows,
      pageSize,
      (row) => ({ publishedAt: row.created_at, id: row.id }),
      (pageRows) => this.buildPurchases(userId, pageRows),
    );
  }

  private async buildPurchases(
    userId: string,
    rows: PurchaseRow[],
  ): Promise<StudioBuyerPurchase[]> {
    if (!rows.length) {
      return [];
    }
    const downloadsByPurchaseId = await this.downloadsOf(rows);
    const wallPersonasById = await this.wallPersonasOf(userId, rows);
    const members = await new MemberLookup(this.profiles).byUserIds([userId]);
    const member = members.get(userId);
    return rows.map((row) => {
      const isOnWall = row.is_on_wall;
      const chosenPersonaId = row.is_shown_as_persona
        ? row.shown_as_subprofile_id
        : null;
      const needsNewIdentity =
        isOnWall &&
        row.is_shown_as_persona &&
        (chosenPersonaId === null || !wallPersonasById.has(chosenPersonaId));
      return {
        id: row.id,
        status: row.status,
        item: toStudioPurchaseItem(row),
        artist: toStudioPurchaseArtist(row),
        amountCents: row.amount_cents,
        referenceCode: row.reference_code,
        payerName: row.payer_name,
        declineReason: row.decline_reason,
        declineNote: row.decline_note,
        createdAt: toIsoString(row.created_at),
        decidedAt: row.decided_at ? toIsoString(row.decided_at) : null,
        wall: {
          isOnWall,
          shownAs:
            isOnWall && !needsNewIdentity
              ? toStudioSupporterIdentity(
                  chosenPersonaId,
                  member,
                  wallPersonasById,
                )
              : null,
          needsNewIdentity,
        },
        downloads: downloadsByPurchaseId.get(row.id) ?? [],
      };
    });
  }

  /** Confirmed purchases only. Kept rows answer first; the live read covers
   *  the confirmed purchases that have none. */
  private async downloadsOf(
    rows: PurchaseRow[],
  ): Promise<Map<string, StudioPurchaseDownloadTrack[]>> {
    const confirmedIds = rows
      .filter((row) => row.status === StudioPurchaseStatus.Confirmed)
      .map((row) => row.id);
    if (!confirmedIds.length) {
      return new Map();
    }
    const keptRows: KeptTrackRow[] = await this.dataSource.query(
      KEPT_TRACKS_OF_PURCHASES_SQL,
      [confirmedIds],
    );
    const downloadsByPurchaseId = groupByPurchaseId(
      keptRows,
      toKeptDownloadTrack,
    );
    const liveIds = confirmedIds.filter(
      (purchaseId) => !downloadsByPurchaseId.has(purchaseId),
    );
    if (!liveIds.length) {
      return downloadsByPurchaseId;
    }
    const liveRows: LiveDownloadTrackRow[] = await this.dataSource.query(
      LIVE_DOWNLOAD_TRACKS_SQL,
      [liveIds],
    );
    for (const [purchaseId, tracks] of groupByPurchaseId(
      liveRows,
      toLiveDownloadTrack,
    )) {
      downloadsByPurchaseId.set(purchaseId, tracks);
    }
    return downloadsByPurchaseId;
  }

  /** The showable personas the buyer chose for the wall and still belongs
   *  to, by id. */
  private async wallPersonasOf(
    userId: string,
    rows: PurchaseRow[],
  ): Promise<Map<string, SupporterPersonaRow>> {
    const personaIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.is_on_wall &&
          row.is_shown_as_persona &&
          row.shown_as_subprofile_id !== null
            ? [row.shown_as_subprofile_id]
            : [],
        ),
      ),
    ];
    if (!personaIds.length) {
      return new Map();
    }
    const personaRows: SupporterPersonaRow[] = await this.dataSource.query(
      WALL_PERSONAS_SQL,
      [personaIds, userId],
    );
    return new Map(personaRows.map((row) => [row.id, row]));
  }
}

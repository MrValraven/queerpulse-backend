import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { ListMyStudioPurchasesQuery } from './dto/list-my-studio-purchases.query';
import {
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import { StudioBuyerPurchasesService } from './studio-buyer-purchases.service';
import { studioError } from './studio.constants';
import {
  KEPT_TRACK_OF_PURCHASE_SQL,
  KeptTrackRow,
  keptTrackDownloadRefusal,
} from './studio-kept-tracks';
import { chosenPersonaShowableSql } from './studio-persona-members';
import {
  studioDownloadDisplayName,
  studioLiveDownloadRefusal,
} from './studio-purchase-rules';
import {
  StudioBuyerPurchase,
  StudioPurchaseDownload,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';

/**
 * Contract 3.7, `$1` the purchase. The buyer, status, item kind and item ids
 * drive steps 1 to 4. `live_persona_name` is the persona's display name (its
 * handle when blank) while the persona the purchase paid still exists, null
 * once it is gone, so `artist_name` speaks. `has_kept_tracks` is true once a
 * persona unlink kept files for this purchase (contract 4.7).
 */
export const DOWNLOAD_PURCHASE_SQL = `SELECT "purchase"."id" AS "id",
       "purchase"."buyer_user_id" AS "buyer_user_id",
       "purchase"."status"::text AS "status",
       "purchase"."item_kind"::text AS "item_kind",
       "purchase"."release_id" AS "release_id",
       "purchase"."track_id" AS "track_id",
       "purchase"."artist_name" AS "artist_name",
       COALESCE(NULLIF(btrim("persona"."display_name"), ''), "persona"."handle") AS "live_persona_name",
       EXISTS (
         SELECT 1 FROM "studio_purchase_kept_tracks" "kept_link"
          WHERE "kept_link"."purchase_id" = "purchase"."id"
       ) AS "has_kept_tracks"
  FROM "studio_purchases" "purchase"
  LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "purchase"."subprofile_id"
 WHERE "purchase"."id" = $1::uuid`;

/**
 * Contract 3.7 steps 4 to 8, `$1` the track. The release id and status, the
 * release persona's `removed_at` and its moderation state (a moderator hide
 * or removal, the `chosenPersonaShowableSql` rule), the track title, its
 * withholding and its audio.
 */
export const DOWNLOAD_LIVE_TRACK_SQL = `SELECT "track"."release_id" AS "release_id",
       "release"."status"::text AS "release_status",
       ("persona"."removed_at" IS NOT NULL) AS "persona_removed",
       (NOT ${chosenPersonaShowableSql('"release"."subprofile_id"')}) AS "is_persona_moderated",
       "track"."title" AS "title",
       "track"."withheld_at" AS "withheld_at",
       "track"."audio_key" AS "audio_key",
       "track"."audio_content_type" AS "audio_content_type"
  FROM "studio_tracks" "track"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  LEFT JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "track"."id" = $1::uuid`;

export interface DownloadPurchaseRow {
  id: string;
  buyer_user_id: string | null;
  status: StudioPurchaseStatus;
  item_kind: StudioPurchaseItemKind;
  release_id: string | null;
  track_id: string | null;
  artist_name: string;
  live_persona_name: string | null;
  has_kept_tracks: boolean;
}

export interface DownloadLiveTrackRow {
  release_id: string;
  release_status: string;
  persona_removed: boolean;
  is_persona_moderated: boolean;
  title: string;
  withheld_at: Date | null;
  audio_key: string | null;
  audio_content_type: string | null;
}

/**
 * The buyer's library: `GET /me/studio-purchases` (contract 3.6) and
 * `GET /studio/purchases/:purchaseId/tracks/:trackId/download` (contract
 * 3.7). Both routes sit outside the Studio gate (ruling 8): a buyer keeps
 * their purchases and files after losing Studio access. Both routes only
 * read: nothing here counts, logs or stores a download.
 */
@Injectable()
export class StudioPurchaseLibraryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly buyerPurchases: StudioBuyerPurchasesService,
    private readonly storage: StorageService,
  ) {}

  /** Contract 3.6: the caller's purchases, 30 per page, newest first. */
  listMine(
    userId: string,
    query: ListMyStudioPurchasesQuery,
  ): Promise<StudioPage<StudioBuyerPurchase>> {
    return this.buyerPurchases.listPage(userId, query.status, query.cursor);
  }

  /**
   * Contract 3.7 steps 1 to 9. After steps 1 and 2, a purchase with kept
   * links answers from them alone (contract 4.7 "Downloads after unlink");
   * every other purchase runs steps 3 to 8 against the live catalog.
   */
  async download(
    userId: string,
    purchaseId: string,
    trackId: string,
  ): Promise<StudioPurchaseDownload> {
    const purchaseRows: DownloadPurchaseRow[] = await this.dataSource.query(
      DOWNLOAD_PURCHASE_SQL,
      [purchaseId],
    );
    const purchase = purchaseRows.find(
      (row) => row.buyer_user_id !== null && row.buyer_user_id === userId,
    );
    if (!purchase) {
      throw studioError('studio_purchase_not_found');
    }
    if (purchase.status !== StudioPurchaseStatus.Confirmed) {
      throw studioError('studio_purchase_not_confirmed');
    }
    if (purchase.has_kept_tracks) {
      return this.downloadKeptTrack(purchase, trackId);
    }
    return this.downloadLiveTrack(purchase, trackId);
  }

  /** Contract 4.7: `trackId` is a kept track id of this purchase. */
  private async downloadKeptTrack(
    purchase: DownloadPurchaseRow,
    keptTrackId: string,
  ): Promise<StudioPurchaseDownload> {
    const keptRows: KeptTrackRow[] = await this.dataSource.query(
      KEPT_TRACK_OF_PURCHASE_SQL,
      [purchase.id, keptTrackId],
    );
    const keptTrack = keptRows[0];
    if (!keptTrack) {
      throw studioError('studio_purchase_not_found');
    }
    const refusal = keptTrackDownloadRefusal(keptTrack);
    if (refusal !== null || keptTrack.audio_key === null) {
      throw studioError(refusal ?? 'studio_download_track_not_ready');
    }
    return this.storage.createPresignedAudioDownload(
      keptTrack.audio_key,
      keptTrack.audio_content_type,
      studioDownloadDisplayName(purchase.artist_name, keptTrack.title),
    );
  }

  /** Contract 3.7 steps 3 to 9. */
  private async downloadLiveTrack(
    purchase: DownloadPurchaseRow,
    trackId: string,
  ): Promise<StudioPurchaseDownload> {
    const isReleasePurchase =
      purchase.item_kind === StudioPurchaseItemKind.Release;
    const itemId = isReleasePurchase ? purchase.release_id : purchase.track_id;
    if (itemId === null) {
      throw studioError('studio_download_item_deleted');
    }
    if (!isReleasePurchase && trackId !== purchase.track_id) {
      throw studioError('studio_download_track_removed');
    }
    const trackRows: DownloadLiveTrackRow[] = await this.dataSource.query(
      DOWNLOAD_LIVE_TRACK_SQL,
      [trackId],
    );
    const track = trackRows[0];
    if (
      !track ||
      (isReleasePurchase && track.release_id !== purchase.release_id)
    ) {
      throw studioError('studio_download_track_removed');
    }
    const refusal = studioLiveDownloadRefusal({
      releaseStatus: track.release_status,
      isPersonaRemoved: track.persona_removed,
      isPersonaModerated: track.is_persona_moderated,
      isTrackWithheld: track.withheld_at !== null,
      audioKey: track.audio_key,
      audioContentType: track.audio_content_type,
    });
    if (
      refusal !== null ||
      track.audio_key === null ||
      track.audio_content_type === null
    ) {
      throw studioError(refusal ?? 'studio_download_track_not_ready');
    }
    return this.storage.createPresignedAudioDownload(
      track.audio_key,
      track.audio_content_type,
      studioDownloadDisplayName(
        purchase.live_persona_name ?? purchase.artist_name,
        track.title,
      ),
    );
  }
}

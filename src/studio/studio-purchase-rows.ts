import { toImageUrl } from '../common/image-url';
import {
  StudioPurchaseDeclineReason,
  StudioPurchaseItemKind,
  StudioPurchaseStatus,
} from './entities/studio-purchase.entity';
import {
  listenableReleaseSql,
  personaColumnsSql,
} from './studio-discovery-sql';
import { personaMemberUserIdsSql } from './studio-persona-members';
import {
  StudioPurchaseArtist,
  StudioPurchaseItem,
} from './studio-purchases-response';
import { listenablePersonaSql } from './studio-visibility';

/*
 * Purchase rows as raw SQL reads them (contract 3.0 and 3.1). Every service
 * that lists or loads purchases appends its own `WHERE`, `ORDER BY` and
 * `LIMIT` to `PURCHASE_ROW_SELECT_SQL` and maps the rows with the two
 * mappers below. `buyer_user_id` rides on the row for the services that need
 * it (the sales buyer lookup, the wall identity); no mapper copies it to the
 * wire.
 */

/** One `PURCHASE_ROW_SELECT_SQL` row: the stored columns (snake_case) plus
 *  the live columns of the item, its release and the artist persona. A live
 *  column is null once the row it reads is gone. */
export interface PurchaseRow {
  id: string;
  buyer_user_id: string | null;
  subprofile_id: string | null;
  artist_name: string;
  item_kind: StudioPurchaseItemKind;
  release_id: string | null;
  track_id: string | null;
  item_title: string;
  amount_cents: number;
  reference_code: string;
  payer_name: string | null;
  status: StudioPurchaseStatus;
  decline_reason: StudioPurchaseDeclineReason | null;
  decline_note: string | null;
  is_on_wall: boolean;
  is_shown_as_persona: boolean;
  shown_as_subprofile_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  live_release_id: string | null;
  live_release_title: string | null;
  live_release_type: string | null;
  live_cover_key: string | null;
  live_track_title: string | null;
  live_persona_name: string | null;
  live_persona_handle: string | null;
  is_persona_linkable: boolean;
}

/**
 * The `SELECT ... FROM` prefix of every purchase read. A track purchase reads
 * its release through the track, and the persona joins by the purchase's own
 * `subprofile_id`, so a persona unlink (which nulls that column) leaves the
 * snapshots to speak. `is_persona_linkable` is `listenablePersonaSql` on the
 * joined persona, false when the persona is gone.
 */
export const PURCHASE_ROW_SELECT_SQL = `SELECT "purchase"."id",
       "purchase"."buyer_user_id",
       "purchase"."subprofile_id",
       "purchase"."artist_name",
       "purchase"."item_kind",
       "purchase"."release_id",
       "purchase"."track_id",
       "purchase"."item_title",
       "purchase"."amount_cents",
       "purchase"."reference_code",
       "purchase"."payer_name",
       "purchase"."status",
       "purchase"."decline_reason",
       "purchase"."decline_note",
       "purchase"."is_on_wall",
       "purchase"."is_shown_as_persona",
       "purchase"."shown_as_subprofile_id",
       "purchase"."created_at",
       "purchase"."decided_at",
       "item_release"."id" AS "live_release_id",
       "item_release"."title" AS "live_release_title",
       "item_release"."type"::text AS "live_release_type",
       "item_release"."cover_key" AS "live_cover_key",
       "item_track"."title" AS "live_track_title",
       "item_persona"."display_name" AS "live_persona_name",
       "item_persona"."handle" AS "live_persona_handle",
       COALESCE(${listenablePersonaSql('item_persona')}, false) AS "is_persona_linkable"
  FROM "studio_purchases" "purchase"
  LEFT JOIN "studio_tracks" "item_track" ON "item_track"."id" = "purchase"."track_id"
  LEFT JOIN "studio_releases" "item_release" ON "item_release"."id" = COALESCE("purchase"."release_id", "item_track"."release_id")
  LEFT JOIN "subprofiles" "item_persona" ON "item_persona"."id" = "purchase"."subprofile_id"`;

/** The title of the item while it exists, else the snapshot. A track purchase
 *  reads the track title, a release purchase the release title. */
function liveItemTitle(row: PurchaseRow): string | null {
  return row.item_kind === StudioPurchaseItemKind.Track
    ? row.live_track_title
    : row.live_release_title;
}

/** Contract 3.0 `StudioPurchaseItem`. */
export function toStudioPurchaseItem(row: PurchaseRow): StudioPurchaseItem {
  const isTrack = row.item_kind === StudioPurchaseItemKind.Track;
  const hasLiveRelease = row.live_release_id !== null;
  const liveTitle = liveItemTitle(row);
  return {
    kind: isTrack ? 'track' : 'release',
    title: liveTitle ?? row.item_title,
    releaseId: row.live_release_id,
    trackId: row.track_id,
    releaseType: hasLiveRelease ? row.live_release_type : null,
    coverUrl: hasLiveRelease ? toImageUrl(row.live_cover_key) : null,
    isAvailable: liveTitle !== null,
  };
}

/** Contract 3.0 `StudioPurchaseArtist`: the live name (the handle when the
 *  display name is blank) while the persona exists, else the snapshot. */
export function toStudioPurchaseArtist(row: PurchaseRow): StudioPurchaseArtist {
  const hasLivePersona =
    row.subprofile_id !== null && row.live_persona_name !== null;
  if (!hasLivePersona) {
    return {
      name: row.artist_name,
      subprofileId: null,
      handle: null,
      isLinkable: false,
    };
  }
  const liveName = (row.live_persona_name ?? '').trim();
  return {
    name:
      liveName !== '' ? liveName : (row.live_persona_handle ?? row.artist_name),
    subprofileId: row.subprofile_id,
    handle: row.live_persona_handle,
    isLinkable: row.is_persona_linkable,
  };
}

/** True while the viewer in `$2` is a member of the release persona. */
const IS_MEMBER_SQL = `EXISTS (
         SELECT 1 FROM ${personaMemberUserIdsSql('"persona"."id"')} "viewer_member"
          WHERE "viewer_member"."user_id" = $2::uuid
       )`;

/** The viewer reads a release when they are a persona member (any status) or
 *  the release is listenable for them (contract 3.1). */
const READABLE_BY_VIEWER_SQL = `(${IS_MEMBER_SQL} OR ${listenableReleaseSql('release', 'persona', '$2::uuid')})`;

/**
 * Contract 3.1 and 3.5. `$1` the release, `$2` the viewer; one row, or none
 * when the release is unknown or the viewer cannot read it. Output columns:
 * `release_id`, `release_title`, `release_type`, `release_status`,
 * `release_cover_key`, the persona columns with the `artist_` prefix
 * (`personaColumnsSql`), `price_mode`, `price_cents` and `is_member`.
 */
export const RELEASE_FOR_VIEWER_SQL = `SELECT "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."type"::text AS "release_type",
       "release"."status"::text AS "release_status",
       "release"."cover_key" AS "release_cover_key",
       ${personaColumnsSql('persona', 'artist')},
       "release"."price_mode"::text AS "price_mode",
       "release"."price_cents" AS "price_cents",
       ${IS_MEMBER_SQL} AS "is_member"
  FROM "studio_releases" "release"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."id" = $1::uuid
   AND ${READABLE_BY_VIEWER_SQL}
 LIMIT 1`;

/**
 * Contract 3.1, track offer. `$1` the track, `$2` the viewer; one row, or
 * none. The release columns match `RELEASE_FOR_VIEWER_SQL`, with the
 * release's own price as `release_price_mode` and `release_price_cents`;
 * `price_mode` and `price_cents` are the track's price. The track adds
 * `track_id`, `track_title`, `track_position`, `is_track_withheld` and
 * `has_playable_audio` (audio key and content type both set).
 */
export const TRACK_FOR_VIEWER_SQL = `SELECT "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "track"."position" AS "track_position",
       ("track"."withheld_at" IS NOT NULL) AS "is_track_withheld",
       ("track"."audio_key" IS NOT NULL AND "track"."audio_content_type" IS NOT NULL) AS "has_playable_audio",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."type"::text AS "release_type",
       "release"."status"::text AS "release_status",
       "release"."cover_key" AS "release_cover_key",
       ${personaColumnsSql('persona', 'artist')},
       "track"."price_mode"::text AS "price_mode",
       "track"."price_cents" AS "price_cents",
       "release"."price_mode"::text AS "release_price_mode",
       "release"."price_cents" AS "release_price_cents",
       ${IS_MEMBER_SQL} AS "is_member"
  FROM "studio_tracks" "track"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "track"."id" = $1::uuid
   AND ${READABLE_BY_VIEWER_SQL}
 LIMIT 1`;

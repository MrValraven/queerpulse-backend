import { normalizeListingShopItems } from '../listings/listing-shop-items';
import { PublicMediaReference } from './public-media-reference';

// SEC-01 / SEC-04 / SEC-42: the server-side lookups behind a public media
// reference (`public-media-reference.ts`) and behind a raw forum photo key.
// Plain SQL through any `query` runner (a repository, an entity manager or
// the data source), so neither `FilesController` nor the global
// `StorageKeyOwnershipInterceptor` has to import the forum or listings
// modules, and no module cycle appears.

/** The one method these lookups need from a TypeORM runner. */
export interface RawQueryRunner {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** What the serve route needs to decide about one forum photo. */
export interface ForumPhotoServingState {
  /** The stored key the reference names, or `null` when there is no photo
   *  at that place in the post's gallery. */
  storageKey: string | null;
  postAuthorId: string;
  /** The post author's account status (`users.status`), or `null` when the
   *  account row is gone. */
  postAuthorStatus: string | null;
  isThreadAnonymous: boolean;
  /** The thread's author, `null` once they erased their account. */
  threadAuthorId: string | null;
  /**
   * SEC-42: the post is tombstoned by its author or a moderator, hidden or
   * removed through content moderation, or its whole thread was withdrawn.
   * Every reader surface already blanks such a post's photos; the serve route
   * refuses their bytes as well, since the bytes are kept for a restore.
   */
  isWithdrawn: boolean;
}

// The forum's moderation subject types (`ForumPostsService.SUBJECT_TYPES`): a
// takedown of an opening post is filed under `post`, of a reply under `reply`.
const FORUM_POST_SUBJECT_TYPES_SQL = `('post', 'reply')`;

// TRUE when the post aliased `p` (in thread `t`) may not be shown: the same
// three conditions `toForumPostResponse` folds into `blanked`, plus the
// thread-level tombstone every forum read gates on.
const FORUM_POST_WITHDRAWN_SQL = `(
    p."deleted_at" IS NOT NULL
    OR t."deleted_at" IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM "content_moderation" "photo_moderation"
      WHERE "photo_moderation"."subject_type" IN ${FORUM_POST_SUBJECT_TYPES_SQL}
        AND "photo_moderation"."subject_id" = p."id"::text
        AND ("photo_moderation"."hidden_at" IS NOT NULL
          OR "photo_moderation"."removed_at" IS NOT NULL)
    )
  )`;

interface ForumPhotoRow {
  storageKey: string | null;
  postAuthorId: string;
  postAuthorStatus: string | null;
  isThreadAnonymous: boolean;
  threadAuthorId: string | null;
  isWithdrawn: boolean;
}

function firstRow<Row>(rows: unknown): Row | null {
  return Array.isArray(rows) && rows.length > 0 ? (rows[0] as Row) : null;
}

/**
 * The photo at `photoIndex` of forum post `postId`, reconciled exactly as
 * `toPostPhotoViews` reconciles it: the `forum_post_photo` rows in `position`
 * order whenever the post has any, otherwise the legacy `forum_post.image`
 * column as a one-photo gallery. `null` when the post does not exist.
 */
export async function findForumPhotoByReference(
  runner: RawQueryRunner,
  postId: string,
  photoIndex: number,
): Promise<ForumPhotoServingState | null> {
  const rows = await runner.query(
    `SELECT
        CASE
          WHEN EXISTS (
            SELECT 1 FROM "forum_post_photo" "gallery_probe"
            WHERE "gallery_probe"."post_id" = p."id"
          )
          THEN (
            SELECT "gallery_photo"."storage_key" FROM "forum_post_photo" "gallery_photo"
            WHERE "gallery_photo"."post_id" = p."id"
            ORDER BY "gallery_photo"."position" ASC
            OFFSET $2::int LIMIT 1
          )
          WHEN $2::int = 0 THEN p."image"
          ELSE NULL
        END AS "storageKey",
        p."author_id" AS "postAuthorId",
        "post_author"."status" AS "postAuthorStatus",
        t."is_anonymous" AS "isThreadAnonymous",
        t."author_id" AS "threadAuthorId",
        ${FORUM_POST_WITHDRAWN_SQL} AS "isWithdrawn"
      FROM "forum_post" p
      INNER JOIN "forum_thread" t ON t."id" = p."thread_id"
      LEFT JOIN "users" "post_author" ON "post_author"."id" = p."author_id"
      WHERE p."id" = $1
      LIMIT 1`,
    [postId, photoIndex],
  );
  const row = firstRow<ForumPhotoRow>(rows);
  if (!row) return null;
  return {
    storageKey: row.storageKey ?? null,
    postAuthorId: row.postAuthorId,
    postAuthorStatus: row.postAuthorStatus ?? null,
    isThreadAnonymous: row.isThreadAnonymous === true,
    threadAuthorId: row.threadAuthorId ?? null,
    isWithdrawn: row.isWithdrawn === true,
  };
}

/** What the raw key route needs about the forum post a key belongs to. */
export interface ForumPhotoKeyState {
  isThreadAnonymous: boolean;
  isWithdrawn: boolean;
}

/**
 * The forum post that holds `storageKey`, as a photo row or as the legacy
 * `forum_post.image` column, or `null` when no forum post holds it (an
 * orphaned upload, or a key the member used somewhere else).
 *
 * The photo row is read first through `UQ_forum_post_photo_storage_key`. The
 * legacy column has no index, so that second read scans `forum_post`; the
 * caller asks for it (`isLegacyColumnRead`) only for a raw `forum-photos/...`
 * key requested by a member who is neither the uploader nor staff, which no
 * read hands out any more (every reader receives the reference), so it is the
 * rare path of an old copied URL. A key of another kind (the composer uploads
 * as `work-image`) is checked against the indexed photo rows alone.
 */
export async function findForumPhotoKeyState(
  runner: RawQueryRunner,
  storageKey: string,
  isLegacyColumnRead = true,
): Promise<ForumPhotoKeyState | null> {
  const selectSql = `SELECT
        t."is_anonymous" AS "isThreadAnonymous",
        ${FORUM_POST_WITHDRAWN_SQL} AS "isWithdrawn"
      FROM "forum_post" p
      INNER JOIN "forum_thread" t ON t."id" = p."thread_id"`;
  const fromPhotoRow = firstRow<ForumPhotoKeyState>(
    await runner.query(
      `${selectSql}
      INNER JOIN "forum_post_photo" "keyed_photo" ON "keyed_photo"."post_id" = p."id"
      WHERE "keyed_photo"."storage_key" = $1
      LIMIT 1`,
      [storageKey],
    ),
  );
  const row =
    fromPhotoRow ??
    (isLegacyColumnRead
      ? firstRow<ForumPhotoKeyState>(
          await runner.query(`${selectSql} WHERE p."image" = $1 LIMIT 1`, [
            storageKey,
          ]),
        )
      : null);
  if (!row) return null;
  return {
    isThreadAnonymous: row.isThreadAnonymous === true,
    isWithdrawn: row.isWithdrawn === true,
  };
}

// A listing is public only while it is `live` and carries no takedown on its
// slug under the directory's subject types (`DirectoryService.SUBJECT_TYPES`,
// `excludeModeratedListings`). The alias `listing` names the listings row.
const LISTING_WITHDRAWN_SQL = `(
    "listing"."status" <> 'live'
    OR EXISTS (
      SELECT 1 FROM "content_moderation" "listing_moderation"
      WHERE "listing_moderation"."subject_type" IN ('business', 'listing')
        AND "listing_moderation"."subject_id" = "listing"."slug"
        AND ("listing_moderation"."hidden_at" IS NOT NULL
          OR "listing_moderation"."removed_at" IS NOT NULL)
    )
  )`;

// A review is taken down under the `review` subject type, keyed by its id
// (`DirectoryService.REVIEW_SUBJECT_TYPE`, `excludeModeratedReviews`). The
// alias `review` names the listing_reviews row.
const REVIEW_TAKEN_DOWN_SQL = `EXISTS (
    SELECT 1 FROM "content_moderation" "review_moderation"
    WHERE "review_moderation"."subject_type" = 'review'
      AND "review_moderation"."subject_id" = "review"."id"::text
      AND ("review_moderation"."hidden_at" IS NOT NULL
        OR "review_moderation"."removed_at" IS NOT NULL)
  )`;

// An event cover stops being public once the event is taken down under the
// `event` subject type, keyed by its id (`EventsService`). A cancelled event
// keeps its cover: its page stays readable, cover included. The alias `event`
// names the events row.
const EVENT_WITHDRAWN_SQL = `EXISTS (
    SELECT 1 FROM "content_moderation" "event_moderation"
    WHERE "event_moderation"."subject_type" = 'event'
      AND "event_moderation"."subject_id" = "event"."id"::text
      AND ("event_moderation"."hidden_at" IS NOT NULL
        OR "event_moderation"."removed_at" IS NOT NULL)
  )`;

// A community's cover and avatar stop being public once it is taken down
// under the `community` subject type, keyed by its slug
// (`CommunityPublicService`). The alias `community` names the row.
const COMMUNITY_TAKEN_DOWN_SQL = `EXISTS (
    SELECT 1 FROM "content_moderation" "community_moderation"
    WHERE "community_moderation"."subject_type" = 'community'
      AND "community_moderation"."subject_id" = "community"."slug"
      AND ("community_moderation"."hidden_at" IS NOT NULL
        OR "community_moderation"."removed_at" IS NOT NULL)
  )`;

/** A row-photo reference: every reference kind but the forum's. */
export type RowPhotoReference = Exclude<
  PublicMediaReference,
  { kind: 'forum-post-photo' }
>;

/** What the serve route needs about the photo a row-photo reference names. */
export interface RowPhotoState {
  /** The stored value, or `null` for an empty slot. It may be an external
   *  URL; the caller accepts only a member storage key. */
  value: string | null;
  /**
   * The photo's surface is no longer public: a listing out of `live` or
   * under a takedown, and for a review also the review's own takedown, the
   * same rules the directory reads apply. An event cover of a taken-down
   * event, and a community cover or avatar of a taken-down
   * community, are withdrawn too.
   */
  isWithdrawn: boolean;
}

/**
 * The photo a row-photo reference names: a listing gallery entry's `image`,
 * a listing owner's cover `image`, a review's `photo`, an event's or a
 * community's `cover_image_url`, or a community's `avatar_image_url`, with
 * whether its surface is withdrawn. `null` when the row does not exist.
 */
export async function findRowPhotoState(
  runner: RawQueryRunner,
  reference: RowPhotoReference,
): Promise<RowPhotoState | null> {
  let rows: unknown;
  switch (reference.kind) {
    case 'listing-gallery-photo':
      rows = await runner.query(
        `SELECT "listing"."photo_gallery" -> $2::int ->> 'image' AS "value",
            ${LISTING_WITHDRAWN_SQL} AS "isWithdrawn"
          FROM "listings" "listing" WHERE "listing"."id" = $1 LIMIT 1`,
        [reference.listingId, reference.photoIndex],
      );
      break;
    case 'listing-cover-photo':
      rows = await runner.query(
        `SELECT "listing"."cover_photo" ->> 'image' AS "value",
            ${LISTING_WITHDRAWN_SQL} AS "isWithdrawn"
          FROM "listings" "listing" WHERE "listing"."id" = $1 LIMIT 1`,
        [reference.listingId],
      );
      break;
    case 'listing-shop-item-photo':
      rows = await runner.query(
        `SELECT "listing"."shop_items" AS "shopItems",
            ${LISTING_WITHDRAWN_SQL} AS "isWithdrawn"
          FROM "listings" "listing" WHERE "listing"."id" = $1 LIMIT 1`,
        [reference.listingId],
      );
      break;
    case 'listing-menu-file':
      rows = await runner.query(
        `SELECT "listing"."menu" -> 'file' ->> 'url' AS "value",
            ${LISTING_WITHDRAWN_SQL} AS "isWithdrawn"
          FROM "listings" "listing" WHERE "listing"."id" = $1 LIMIT 1`,
        [reference.listingId],
      );
      break;
    case 'listing-review-photo':
      rows = await runner.query(
        `SELECT "review"."photo" AS "value",
            (${REVIEW_TAKEN_DOWN_SQL} OR ${LISTING_WITHDRAWN_SQL}) AS "isWithdrawn"
          FROM "listing_reviews" "review"
          INNER JOIN "listings" "listing" ON "listing"."id" = "review"."listing_id"
          WHERE "review"."id" = $1 LIMIT 1`,
        [reference.reviewId],
      );
      break;
    case 'event-cover-photo':
      rows = await runner.query(
        `SELECT "event"."cover_image_url" AS "value",
            ${EVENT_WITHDRAWN_SQL} AS "isWithdrawn"
          FROM "events" "event" WHERE "event"."id" = $1 LIMIT 1`,
        [reference.eventId],
      );
      break;
    case 'community-cover-photo':
      rows = await runner.query(
        `SELECT "community"."cover_image_url" AS "value",
            ${COMMUNITY_TAKEN_DOWN_SQL} AS "isWithdrawn"
          FROM "communities" "community" WHERE "community"."id" = $1 LIMIT 1`,
        [reference.communityId],
      );
      break;
    case 'community-avatar-photo':
      rows = await runner.query(
        `SELECT "community"."avatar_image_url" AS "value",
            ${COMMUNITY_TAKEN_DOWN_SQL} AS "isWithdrawn"
          FROM "communities" "community" WHERE "community"."id" = $1 LIMIT 1`,
        [reference.communityId],
      );
      break;
  }
  const row = firstRow<{
    value?: string | null;
    shopItems?: unknown;
    isWithdrawn: boolean;
  }>(rows);
  if (!row) return null;
  const value =
    reference.kind === 'listing-shop-item-photo'
      ? shopItemPhotoAt(row.shopItems, reference.itemIndex)
      : (row.value ?? null);
  return { value, isWithdrawn: row.isWithdrawn === true };
}

/** The photo key of shop item `itemIndex` in the normalized list
 *  `toListingShopItemViews` renders, so the index means the same thing on
 *  the read that built the reference and the lookup that resolves it. */
function shopItemPhotoAt(shopItems: unknown, itemIndex: number): string | null {
  return normalizeListingShopItems(shopItems)[itemIndex]?.photo?.image ?? null;
}

/** A row of one batched lookup, keyed by its uuid. */
interface BatchRow {
  id: string;
  [column: string]: unknown;
}

function rowsById(rows: unknown): Map<string, BatchRow> {
  const byId = new Map<string, BatchRow>();
  if (!Array.isArray(rows)) return byId;
  for (const row of rows as BatchRow[]) {
    byId.set(String(row.id).toLowerCase(), row);
  }
  return byId;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The `image` of the entry at `index` of a stored jsonb gallery. */
function galleryImageAt(gallery: unknown, index: number): string | null {
  if (!Array.isArray(gallery)) return null;
  const entry: unknown = gallery[index];
  return entry !== null && typeof entry === 'object'
    ? stringOrNull((entry as { image?: unknown }).image)
    : null;
}

/** The one id each reference kind is looked up by. */
function referenceRowId(reference: PublicMediaReference): string {
  switch (reference.kind) {
    case 'forum-post-photo':
      return reference.postId;
    case 'listing-gallery-photo':
    case 'listing-cover-photo':
    case 'listing-shop-item-photo':
    case 'listing-menu-file':
      return reference.listingId;
    case 'listing-review-photo':
      return reference.reviewId;
    case 'event-cover-photo':
      return reference.eventId;
    case 'community-cover-photo':
    case 'community-avatar-photo':
      return reference.communityId;
  }
}

// The one query per table the write path runs, each keyed `id = ANY($1)`.
type BatchTable = 'forum' | 'listing' | 'review' | 'event' | 'community';

function batchTableOf(reference: PublicMediaReference): BatchTable {
  switch (reference.kind) {
    case 'forum-post-photo':
      return 'forum';
    case 'listing-gallery-photo':
    case 'listing-cover-photo':
    case 'listing-shop-item-photo':
    case 'listing-menu-file':
      return 'listing';
    case 'listing-review-photo':
      return 'review';
    case 'event-cover-photo':
      return 'event';
    case 'community-cover-photo':
    case 'community-avatar-photo':
      return 'community';
  }
}

const BATCH_SQL: Record<BatchTable, string> = {
  // The forum gallery reconciled as `toPostPhotoViews` reconciles it: the
  // photo rows in `position` order, else the legacy `image` column.
  forum: `SELECT p."id" AS "id", p."image" AS "image",
      ARRAY(
        SELECT "gallery_photo"."storage_key" FROM "forum_post_photo" "gallery_photo"
        WHERE "gallery_photo"."post_id" = p."id"
        ORDER BY "gallery_photo"."position" ASC
      ) AS "photoKeys"
    FROM "forum_post" p WHERE p."id" = ANY($1::uuid[])`,
  listing: `SELECT "id", "photo_gallery" AS "photoGallery", "cover_photo" AS "coverPhoto",
      "shop_items" AS "shopItems", "menu" -> 'file' ->> 'url' AS "menuFileUrl"
    FROM "listings" WHERE "id" = ANY($1::uuid[])`,
  review: `SELECT "id", "photo" FROM "listing_reviews" WHERE "id" = ANY($1::uuid[])`,
  event: `SELECT "id", "cover_image_url" AS "coverImageUrl"
    FROM "events" WHERE "id" = ANY($1::uuid[])`,
  community: `SELECT "id", "cover_image_url" AS "coverImageUrl", "avatar_image_url" AS "avatarImageUrl"
    FROM "communities" WHERE "id" = ANY($1::uuid[])`,
};

/** The stored value one reference names, read off its batched row. */
function valueFromRow(
  reference: PublicMediaReference,
  row: BatchRow,
): string | null {
  switch (reference.kind) {
    case 'forum-post-photo': {
      const photoKeys = Array.isArray(row.photoKeys) ? row.photoKeys : [];
      if (photoKeys.length > 0) {
        return stringOrNull(photoKeys[reference.photoIndex]);
      }
      return reference.photoIndex === 0 ? stringOrNull(row.image) : null;
    }
    case 'listing-gallery-photo':
      return galleryImageAt(row.photoGallery, reference.photoIndex);
    case 'listing-cover-photo':
      return row.coverPhoto !== null && typeof row.coverPhoto === 'object'
        ? stringOrNull((row.coverPhoto as { image?: unknown }).image)
        : null;
    case 'listing-shop-item-photo':
      return shopItemPhotoAt(row.shopItems, reference.itemIndex);
    case 'listing-menu-file':
      return stringOrNull(row.menuFileUrl);
    case 'listing-review-photo':
      return stringOrNull(row.photo);
    case 'event-cover-photo':
    case 'community-cover-photo':
      return stringOrNull(row.coverImageUrl);
    case 'community-avatar-photo':
      return stringOrNull(row.avatarImageUrl);
  }
}

/**
 * The stored values a set of public media references name, for the write
 * path (`StorageKeyOwnershipInterceptor`), which needs the keys alone and
 * applies its own ownership rule to them. One query per table, each keyed
 * `id = ANY($1)`, however many references the body carries. The answer is in
 * the order of `references`, `null` where nothing is stored.
 */
export async function findPublicMediaReferenceValues(
  runner: RawQueryRunner,
  references: readonly PublicMediaReference[],
): Promise<Array<string | null>> {
  const idsByTable = new Map<BatchTable, Set<string>>();
  for (const reference of references) {
    const table = batchTableOf(reference);
    const ids = idsByTable.get(table) ?? new Set<string>();
    ids.add(referenceRowId(reference).toLowerCase());
    idsByTable.set(table, ids);
  }
  const rowsByTable = new Map<BatchTable, Map<string, BatchRow>>();
  for (const [table, ids] of idsByTable) {
    rowsByTable.set(
      table,
      rowsById(await runner.query(BATCH_SQL[table], [[...ids]])),
    );
  }
  return references.map((reference) => {
    const row = rowsByTable
      .get(batchTableOf(reference))
      ?.get(referenceRowId(reference).toLowerCase());
    return row ? valueFromRow(reference, row) : null;
  });
}

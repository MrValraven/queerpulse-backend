import { EventStatus, EventVisibility } from '../events/entities/event.entity';
import { SubprofileKind } from '../subprofiles/entities/subprofile.entity';
import { StudioArtistRef, toStudioArtistRef } from './studio-response';
import { listenablePersonaSql } from './studio-visibility';
import { ARTIST_KIND_LIST } from './studio-playlist-visibility';

/*
 * Studio discovery: raw SQL pieces the discovery reads share. They run
 * through `DataSource.query` with positional parameters, so the block filter
 * is spelled here with a placeholder and an alias of the caller's choosing
 * (`BlockFilterService.excludeBlocked` binds one fixed named parameter and
 * serves query builders). Every alias and placeholder passed in is a literal
 * from Studio's own queries; member input only ever reaches bound
 * parameters.
 */

/** The Studio artist kinds of `STUDIO_FORMAT_BY_KIND`, quoted for an
 *  `IN (...)` list. Spelled once, in `studio-playlist-visibility.ts`, which
 *  imports nothing from here. */
export const STUDIO_ARTIST_KIND_LIST_SQL = ARTIST_KIND_LIST;

/**
 * No block either way between the viewer bound at `viewerPlaceholder` (such
 * as `$1`) and the member in `memberColumn` (an already quoted
 * `"alias"."column"`). `blockAlias` names this use's own `blocks` alias, so
 * one query can carry several. A NULL member column (an erased account)
 * matches no block row and passes, and so does a NULL viewer (the staff
 * view).
 */
export function notBlockedEitherWaySql(
  viewerPlaceholder: string,
  memberColumn: string,
  blockAlias: string,
): string {
  const block = `"${blockAlias}"`;
  return `NOT EXISTS (
      SELECT 1 FROM "blocks" ${block}
       WHERE (${block}."blocker_id" = ${viewerPlaceholder} AND ${block}."blocked_id" = ${memberColumn})
          OR (${block}."blocked_id" = ${viewerPlaceholder} AND ${block}."blocker_id" = ${memberColumn})
    )`;
}

/** A release the viewer can hear: published, its persona listenable, and
 *  the persona creator clear of any block either way with the viewer. The
 *  same rule `StudioCatalogService.listenableReleases` applies. */
export function listenableReleaseSql(
  releaseAlias: string,
  personaAlias: string,
  viewerPlaceholder: string,
): string {
  return `("${releaseAlias}"."status" = 'published'
    AND ${listenablePersonaSql(personaAlias)}
    AND ${notBlockedEitherWaySql(
      viewerPlaceholder,
      `"${personaAlias}"."user_id"`,
      `${personaAlias}_block`,
    )})`;
}

/**
 * `$1` the viewer, `$2` a persona id: one row when the persona is a
 * listenable persona of a Studio artist kind whose creator is clear of
 * blocks with the viewer. The audience of "Appears on" and "Related
 * artists".
 */
export const LISTENABLE_ARTIST_SQL = `SELECT 1 AS "found"
  FROM "subprofiles" "artist"
 WHERE "artist"."id" = $2
   AND "artist"."kind" IN (${STUDIO_ARTIST_KIND_LIST_SQL})
   AND ${listenablePersonaSql('artist')}
   AND ${notBlockedEitherWaySql('$1', '"artist"."user_id"', 'artist_block')}
 LIMIT 1`;

/** The persona columns every persona reference reads. The owner's user id
 *  is left out, so no response can carry it. */
export interface PersonaColumns {
  id: string;
  handle: string | null;
  displayName: string;
  kind: string;
  avatarUrl: string | null;
}

export function personaColumnsSql(
  personaAlias: string,
  columnPrefix: string,
): string {
  const persona = `"${personaAlias}"`;
  return `${persona}."id" AS "${columnPrefix}_id",
          ${persona}."handle" AS "${columnPrefix}_handle",
          ${persona}."display_name" AS "${columnPrefix}_display_name",
          ${persona}."kind" AS "${columnPrefix}_kind",
          ${persona}."avatar_url" AS "${columnPrefix}_avatar_url"`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function personaColumnsFromRow(
  row: Readonly<Record<string, unknown>>,
  columnPrefix: string,
): PersonaColumns {
  return {
    id: stringOrNull(row[`${columnPrefix}_id`]) ?? '',
    handle: stringOrNull(row[`${columnPrefix}_handle`]),
    displayName: stringOrNull(row[`${columnPrefix}_display_name`]) ?? '',
    kind: stringOrNull(row[`${columnPrefix}_kind`]) ?? '',
    avatarUrl: stringOrNull(row[`${columnPrefix}_avatar_url`]),
  };
}

/** A Studio artist reference from raw persona columns (scene artists,
 *  related artists, radio). `toStudioArtistRef` reads a kind outside the
 *  artist kinds as `musician`. */
export function artistRefFromColumns(columns: PersonaColumns): StudioArtistRef {
  return toStudioArtistRef({
    id: columns.id,
    handle: columns.handle,
    displayName: columns.displayName,
    kind: columns.kind as SubprofileKind,
    avatarUrl: columns.avatarUrl,
  });
}

/** `openUpcomingEventSql` without its start after now: published, open to
 *  browse, unmoderated and outside any space. The landing month count reads past events of the month. */
export function openBrowsableEventSql(eventAlias: string): string {
  const event = `"${eventAlias}"`;
  const moderation = `"${eventAlias}_moderation"`;
  const space = `"${eventAlias}_space"`;
  return `(${event}."status" = '${EventStatus.Published}'
    AND ${event}."visibility" IN ('${EventVisibility.Public}', '${EventVisibility.Members}')
    AND NOT EXISTS (
      SELECT 1 FROM "content_moderation" ${moderation}
       WHERE ${moderation}."subject_type" = 'event'
         AND ${moderation}."subject_id" = ${event}."id"::text
         AND (${moderation}."hidden_at" IS NOT NULL OR ${moderation}."removed_at" IS NOT NULL)
    )
    AND (${event}."community_id" IS NULL OR NOT EXISTS (SELECT 1 FROM "communities" ${space} WHERE ${space}."id" = ${event}."community_id" AND ${space}."parent_id" IS NOT NULL)))`;
}

/**
 * An event every member may browse right now: published, starting after
 * now, open to browse (public or members) and clear of moderator action
 * (hidden or removed), the exclusion `EventsService.list` applies through
 * `excludeModeratedEvents`. Network, extended network, invite-only and
 * community-scoped events stay out. So does every event a space hosts (a
 * community whose `parent_id` is set): the space rule of
 * `EventAudienceGateService.scopedVisibilityWhere` keeps those to viewers
 * who stand in the space, and this predicate applies its viewer-independent
 * half. The scene page (Task 8) adds the host block filter; the staff event
 * search (Task 9) reads it as written.
 */
export function openUpcomingEventSql(eventAlias: string): string {
  return `(${openBrowsableEventSql(eventAlias)} AND "${eventAlias}"."start_at" > now())`;
}

/** The staff shelves, each pick joined to its release and the release's
 *  persona, under the aliases `pick`, `release` and `persona`. The member
 *  read (Task 6) and the staff read (Task 7) add their own columns and
 *  WHERE between this and `CURATED_PICKS_ORDER_SQL`. */
export const CURATED_PICKS_FROM_SQL = `FROM "studio_curated_picks" "pick"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "pick"."release_id"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"`;

/** Shelf by shelf, each in position order. */
export const CURATED_PICKS_ORDER_SQL = `ORDER BY "pick"."shelf" ASC, "pick"."position" ASC`;

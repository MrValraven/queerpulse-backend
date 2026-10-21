import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  LISTENABLE_ARTIST_SQL,
  artistRefFromColumns,
  listenableReleaseSql,
  notBlockedEitherWaySql,
  openUpcomingEventSql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { StudioPage, StudioReleaseCard } from './studio-response';
import {
  SceneEventRow,
  StudioSceneCard,
  StudioSceneEvent,
  StudioSceneResponse,
  toStudioSceneCard,
  toStudioSceneEvent,
} from './studio-scene-response';
import { STUDIO_DISCOVERY_LIMITS, studioError } from './studio.constants';

/** `$1` the viewer, `$2` the scene: the scene's releases this viewer can
 *  hear, with their personas. The artist list and the artist half of the
 *  event union both read it. */
const SCENE_LISTENABLE_RELEASES_SQL = `FROM "studio_releases" "release"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."scene_id" = $2
   AND ${listenableReleaseSql('release', 'persona', '$1')}`;

/** `$1` the viewer, `$2` the scene, `$3` the limit. Listenable personas with
 *  at least one listenable release in the scene, newest such release first. */
export const SCENE_ARTISTS_SQL = `SELECT ${personaColumnsSql('persona', 'artist')},
       MAX("release"."published_at") AS "newest_published_at"
  ${SCENE_LISTENABLE_RELEASES_SQL}
 GROUP BY "persona"."id"
 ORDER BY "newest_published_at" DESC, "persona"."id" ASC
 LIMIT $3`;

/** The `SceneEventRow` columns of the event aliased `event`. */
const SCENE_EVENT_COLUMNS_SQL = `"event"."slug" AS "slug",
       "event"."title" AS "title",
       "event"."start_at" AS "start_at",
       "event"."end_at" AS "end_at",
       "event"."timezone" AS "timezone",
       "event"."venue" AS "venue",
       "event"."neighbourhood" AS "neighbourhood",
       "event"."is_online" AS "is_online",
       "event"."cover_image_url" AS "cover_image_url"`;

/** The affiliation roles that say the persona plays or hosts the event.
 *  `attending` (a going RSVP) is a guest's link and never reads as a set. */
export const PERFORMING_EVENT_ROLE_LIST_SQL = `'performing', 'hosting'`;

/**
 * An event affiliation that still stands as a performance, for the row
 * aliased `affiliationAlias` on the event aliased `eventAlias`: its role is
 * performing or hosting, and one of the persona's owners (the creator in
 * `subprofiles.user_id` or any `subprofile_members` row) hosts the event,
 * co-hosts it, or holds an accepted lineup entry on it. The flash day rule
 * of `SubprofileAffiliationEligibilityService.eligibleTargetKeys`
 * (`shouldCountGoingRsvps: false`), the read-side check
 * `SubprofilePublicReadService.resolveAffiliationsFor` applies, so a link
 * the persona page hides once its owner stepped away never shows here.
 * `prefix` keeps the inner aliases apart when one query holds it twice.
 */
export function standingPerformanceAffiliationSql(
  affiliationAlias: string,
  eventAlias: string,
  prefix: string,
): string {
  const affiliation = `"${affiliationAlias}"`;
  const event = `"${eventAlias}"`;
  const owner = `"${prefix}_owner"`;
  const cohost = `"${prefix}_cohost"`;
  const lineup = `"${prefix}_lineup"`;
  return `(${affiliation}."role" IN (${PERFORMING_EVENT_ROLE_LIST_SQL})
    AND EXISTS (
      SELECT 1 FROM (
        SELECT "${prefix}_creator"."user_id" AS "user_id"
          FROM "subprofiles" "${prefix}_creator"
         WHERE "${prefix}_creator"."id" = ${affiliation}."subprofile_id"
        UNION
        SELECT "${prefix}_member"."user_id" AS "user_id"
          FROM "subprofile_members" "${prefix}_member"
         WHERE "${prefix}_member"."subprofile_id" = ${affiliation}."subprofile_id"
      ) ${owner}
       WHERE ${owner}."user_id" = ${event}."host_id"
          OR EXISTS (
            SELECT 1 FROM "event_cohosts" ${cohost}
             WHERE ${cohost}."event_id" = ${event}."id"
               AND ${cohost}."user_id" = ${owner}."user_id"
          )
          OR EXISTS (
            SELECT 1 FROM "event_lineup_entries" ${lineup}
             WHERE ${lineup}."event_id" = ${event}."id"
               AND ${lineup}."user_id" = ${owner}."user_id"
               AND ${lineup}."status" = 'accepted'
          )
    ))`;
}

/**
 * `$1` the viewer, `$2` the scene, `$3` the limit. The union of the events
 * the scene artists list as public affiliations (`subprofile_affiliations`,
 * `target_type = 'event'`, matched on the event slug, performing or hosting
 * and still standing: `standingPerformanceAffiliationSql`) and the events staff
 * pinned, kept when published, starting after now, open to browse (public
 * or members), clear of moderator action, and hosted by someone clear of
 * blocks with the viewer. Network, extended network, invite-only and
 * community-scoped events stay out for every viewer.
 */
export const SCENE_UPCOMING_EVENTS_SQL = `WITH "scene_artist" AS (
  SELECT DISTINCT "release"."subprofile_id" AS "subprofile_id"
    ${SCENE_LISTENABLE_RELEASES_SQL}
), "scene_event" AS (
  SELECT "pin"."event_id" AS "event_id"
    FROM "studio_scene_events" "pin"
   WHERE "pin"."scene_id" = $2
  UNION
  SELECT "affiliated_event"."id" AS "event_id"
    FROM "subprofile_affiliations" "affiliation"
    INNER JOIN "scene_artist" ON "scene_artist"."subprofile_id" = "affiliation"."subprofile_id"
    INNER JOIN "events" "affiliated_event" ON "affiliated_event"."slug" = "affiliation"."target_slug"
   WHERE "affiliation"."target_type" = 'event'
     AND ${standingPerformanceAffiliationSql('affiliation', 'affiliated_event', 'scene_affiliation')}
)
SELECT ${SCENE_EVENT_COLUMNS_SQL}
  FROM "events" "event"
  INNER JOIN "scene_event" ON "scene_event"."event_id" = "event"."id"
 WHERE ${openUpcomingEventSql('event')}
   AND ${notBlockedEitherWaySql('$1', '"event"."host_id"', 'event_host_block')}
 ORDER BY "event"."start_at" ASC, "event"."id" ASC
 LIMIT $3`;

/**
 * PRD-15, `$1` the viewer, `$2` the persona, `$3` the limit: where an artist
 * plays next. The events the persona lists as public affiliations
 * (`subprofile_affiliations`, `target_type = 'event'`, matched on the event
 * slug) as performing or hosting, while an owner still hosts, co-hosts or
 * plays it (`standingPerformanceAffiliationSql`), soonest first, under the
 * scene page's event rule: published,
 * starting after now, open to browse (public or members), clear of
 * moderator action, outside any space, and hosted by someone clear of
 * blocks with the viewer. Lineup rows only confirm a link the persona
 * chose to list: an event an owner plays without listing it on the persona
 * never shows, so the shelf never ties the persona to the member behind it.
 */
export const ARTIST_UPCOMING_EVENTS_SQL = `SELECT ${SCENE_EVENT_COLUMNS_SQL}
  FROM "events" "event"
 WHERE EXISTS (
    SELECT 1 FROM "subprofile_affiliations" "affiliation"
     WHERE "affiliation"."subprofile_id" = $2
       AND "affiliation"."target_type" = 'event'
       AND "affiliation"."target_slug" = "event"."slug"
       AND ${standingPerformanceAffiliationSql('affiliation', 'event', 'artist_affiliation')}
   )
   AND ${openUpcomingEventSql('event')}
   AND ${notBlockedEitherWaySql('$1', '"event"."host_id"', 'event_host_block')}
 ORDER BY "event"."start_at" ASC, "event"."id" ASC
 LIMIT $3`;

/**
 * Studio discovery: the member reads of scenes. Only active scenes answer;
 * an archived or unknown slug is 404 `studio_scene_not_found` on every
 * route, and the releases keep their link for when the scene is restored.
 */
@Injectable()
export class StudioScenesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
  ) {}

  async listScenes(): Promise<{ items: StudioSceneCard[] }> {
    const scenes = await this.dataSource.getRepository(StudioScene).find({
      where: { status: StudioSceneState.Active },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    return { items: scenes.map(toStudioSceneCard) };
  }

  async getScene(viewerId: string, slug: string): Promise<StudioSceneResponse> {
    const scene = await this.findActiveScene(slug);
    const [artistRows, eventRows]: [
      Record<string, unknown>[],
      SceneEventRow[],
    ] = await Promise.all([
      this.dataSource.query(SCENE_ARTISTS_SQL, [
        viewerId,
        scene.id,
        STUDIO_DISCOVERY_LIMITS.sceneArtistsShown,
      ]),
      this.dataSource.query(SCENE_UPCOMING_EVENTS_SQL, [
        viewerId,
        scene.id,
        STUDIO_DISCOVERY_LIMITS.sceneUpcomingEvents,
      ]),
    ]);
    return {
      ...toStudioSceneCard(scene),
      blurb: scene.blurb,
      artists: artistRows.map((row) =>
        artistRefFromColumns(personaColumnsFromRow(row, 'artist')),
      ),
      upcomingEvents: eventRows.map(toStudioSceneEvent),
    };
  }

  /** PRD-15: up to 4 upcoming events of a persona the viewer can hear. The
   *  persona check runs first and answers 404 like "Related artists", so
   *  nothing is read for a persona the viewer cannot see. */
  async listArtistEvents(
    viewerId: string,
    subprofileId: string,
  ): Promise<{ items: StudioSceneEvent[] }> {
    const found: unknown[] = await this.dataSource.query(
      LISTENABLE_ARTIST_SQL,
      [viewerId, subprofileId],
    );
    if (!found.length) {
      throw new NotFoundException('Artist not found');
    }
    const eventRows: SceneEventRow[] = await this.dataSource.query(
      ARTIST_UPCOMING_EVENTS_SQL,
      [viewerId, subprofileId, STUDIO_DISCOVERY_LIMITS.artistUpcomingEvents],
    );
    return { items: eventRows.map(toStudioSceneEvent) };
  }

  /** 24 per page, keyset like `/studio/releases` (`StudioCatalogService`
   *  pages at `STUDIO_LIMITS.releasesPerPage`, which equals
   *  `sceneReleasesPerPage`). */
  async listSceneReleases(
    viewerId: string,
    slug: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioReleaseCard>> {
    const scene = await this.findActiveScene(slug);
    return this.catalog.listReleases(viewerId, cursor, { sceneId: scene.id });
  }

  private async findActiveScene(slug: string): Promise<StudioScene> {
    const scene = await this.dataSource.getRepository(StudioScene).findOne({
      where: { slug: slug.toLowerCase(), status: StudioSceneState.Active },
    });
    if (!scene) {
      throw studioError('studio_scene_not_found');
    }
    return scene;
  }
}

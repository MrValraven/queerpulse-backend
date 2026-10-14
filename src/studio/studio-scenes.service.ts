import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
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

/**
 * `$1` the viewer, `$2` the scene, `$3` the limit. The union of the events
 * the scene artists list as public affiliations (`subprofile_affiliations`,
 * `target_type = 'event'`, matched on the event slug) and the events staff
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
)
SELECT "event"."slug" AS "slug",
       "event"."title" AS "title",
       "event"."start_at" AS "start_at",
       "event"."end_at" AS "end_at",
       "event"."timezone" AS "timezone",
       "event"."venue" AS "venue",
       "event"."neighbourhood" AS "neighbourhood",
       "event"."is_online" AS "is_online",
       "event"."cover_image_url" AS "cover_image_url"
  FROM "events" "event"
  INNER JOIN "scene_event" ON "scene_event"."event_id" = "event"."id"
 WHERE ${openUpcomingEventSql('event')}
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

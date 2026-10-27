import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import {
  isStudioSceneScopedKey,
  storageKeyOwnerId,
} from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { listsEveryIdOnce } from './admin-studio-curation.service';
import {
  AdminStudioReleaseCard,
  toAdminStudioReleaseCard,
} from './admin-studio-response';
import {
  AdminEventOptionRow,
  AdminSceneEventRow,
  AdminSceneRow,
  AdminStudioEventOption,
  AdminStudioScene,
  AdminStudioSceneEvent,
  toAdminStudioEventOption,
  toAdminStudioScene,
  toAdminStudioSceneEvent,
} from './admin-studio-scene-response';
import {
  CreateAdminStudioSceneDto,
  UpdateAdminStudioSceneDto,
} from './dto/admin-studio-scenes.dto';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioScene, StudioSceneState } from './entities/studio-scene.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { openUpcomingEventSql } from './studio-discovery-sql';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';
import { StudioPage } from './studio-response';
import { sceneSlugBase, sceneSlugCandidates } from './studio-scene-slug';
import { STUDIO_DISCOVERY_LIMITS, studioError } from './studio.constants';

/** Trimmed; an empty blurb is stored as null. */
export function normalizeSceneBlurb(
  blurb: string | null | undefined,
): string | null {
  const trimmedBlurb = blurb?.trim();
  return trimmedBlurb ? trimmedBlurb : null;
}

/** Creates, restores and reorders take this first, so positions and
 *  generated slugs are decided one write at a time. Staff-only and tiny. */
const LOCK_SCENES_SQL =
  'LOCK TABLE "studio_scenes" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` the scene. Locks the row for the rest of the transaction and reads
 *  the cover it holds right now, so a cover edit is decided against the
 *  stored value and never against a read taken before another edit. */
const LOCK_SCENE_COVER_SQL = `SELECT "cover_key" FROM "studio_scenes" WHERE "id" = $1 FOR UPDATE`;

const NEXT_ACTIVE_POSITION_SQL = `SELECT CAST(COALESCE(MAX("position"), 0) + 1 AS int) AS "position"
  FROM "studio_scenes" WHERE "status" = 'active'`;

/** `$1` a scene id or null, `$2` a status or null. Active scenes by
 *  position, then archived ones by name. */
const ADMIN_SCENES_SQL = `SELECT "scene"."id" AS "id",
       "scene"."slug" AS "slug",
       "scene"."name" AS "name",
       "scene"."city" AS "city",
       "scene"."blurb" AS "blurb",
       "scene"."cover_key" AS "cover_key",
       "scene"."status"::text AS "status",
       "scene"."position" AS "position",
       "scene"."created_at" AS "created_at",
       "scene"."updated_at" AS "updated_at",
       (SELECT CAST(COUNT(*) AS int) FROM "studio_releases" "scene_release"
         WHERE "scene_release"."scene_id" = "scene"."id") AS "release_count",
       (SELECT CAST(COUNT(*) AS int) FROM "studio_scene_events" "scene_pin"
         WHERE "scene_pin"."scene_id" = "scene"."id") AS "pinned_event_count"
  FROM "studio_scenes" "scene"
 WHERE ($1::uuid IS NULL OR "scene"."id" = $1)
   AND ($2::text IS NULL OR "scene"."status"::text = $2)
 ORDER BY CASE WHEN "scene"."status" = 'active' THEN 0 ELSE 1 END ASC,
          CASE WHEN "scene"."status" = 'active' THEN "scene"."position" END ASC,
          "scene"."name" ASC,
          "scene"."created_at" ASC`;

const REORDER_SCENES_SQL = `UPDATE "studio_scenes" AS "scene" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("scene_id", "position")
 WHERE "scene"."id" = "ordering"."scene_id" AND "scene"."status" = 'active'`;

/** `$1` the LIKE pattern, `$2` the limit. Events `openUpcomingEventSql`
 *  accepts (upcoming, published, open to browse, clear of moderation, hosted
 *  outside every space), by folded title, soonest first. */
const ADMIN_EVENT_SEARCH_SQL = `SELECT "event"."id" AS "id",
       "event"."slug" AS "slug",
       "event"."title" AS "title",
       "event"."start_at" AS "start_at",
       "event"."venue" AS "venue",
       "event"."neighbourhood" AS "neighbourhood"
  FROM "events" "event"
 WHERE ${openUpcomingEventSql('event')}
   AND ${foldedHaystack('event', ['title'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
 ORDER BY "event"."start_at" ASC, "event"."id" ASC
 LIMIT $2`;

/** `$1` an event id. One row when the event exists; `is_pinnable` is the
 *  `openUpcomingEventSql` rule the search lists by, so a pin takes exactly
 *  the events the search can offer. */
const PIN_EVENT_READ_SQL = `SELECT "event"."id" AS "id",
       ${openUpcomingEventSql('event')} AS "is_pinnable"
  FROM "events" "event"
 WHERE "event"."id" = $1`;

const PINNED_EVENTS_SQL = `SELECT "event"."id" AS "event_id",
       "event"."slug" AS "slug",
       "event"."title" AS "title",
       "event"."start_at" AS "start_at",
       "event"."venue" AS "venue",
       "event"."neighbourhood" AS "neighbourhood",
       ("event"."start_at" > now()) AS "is_upcoming",
       "pin"."created_at" AS "pinned_at"
  FROM "studio_scene_events" "pin"
  INNER JOIN "events" "event" ON "event"."id" = "pin"."event_id"
 WHERE "pin"."scene_id" = $1
 ORDER BY "event"."start_at" ASC, "event"."id" ASC`;

/** `$1` the scene, `$2`/`$3` the cursor or nulls, `$4` the page size plus
 *  one. `created_at` holds microseconds and a JS `Date` cursor milliseconds,
 *  so both sides compare at millisecond precision. */
export const ADMIN_SCENE_RELEASES_SQL = `SELECT "release"."id" AS "id",
       "release"."status"::text AS "status",
       date_trunc('milliseconds', "release"."created_at") AS "created_at_ms"
  FROM "studio_releases" "release"
 WHERE "release"."scene_id" = $1
   AND ($2::timestamptz IS NULL
     OR (date_trunc('milliseconds', "release"."created_at"), "release"."id") < ($2::timestamptz, $3::uuid))
 ORDER BY date_trunc('milliseconds', "release"."created_at") DESC, "release"."id" DESC
 LIMIT $4`;

interface AdminSceneReleaseRow {
  id: string;
  status: StudioReleaseStatus;
  created_at_ms: Date;
}

interface PinEventReadRow {
  id: string;
  is_pinnable: boolean;
}

/**
 * Studio discovery: the staff side of scenes (Moderator and Admin), in the
 * `AdminTopicsService` shape. Archiving keeps every release link and pin;
 * the member reads answer 404 and cards read `scene: null` until a restore.
 *
 * A cover arrives as the staff member's own `work-image` upload, whose key
 * names them. It is stored as a scene-scoped copy
 * (`studio-scene/<uuid>/<uuid><ext>`) so the public scene page names
 * nobody: copy first, then write the row. `GET /files/*` serves the copy only
 * while a scene row names it, so a copy whose write rolled back is never
 * served and the orphan sweep reclaims it, with the original upload. A
 * replaced copy is deleted after the write commits, best effort, and the
 * sweep reclaims it when that fails.
 */
@Injectable()
export class AdminStudioScenesService {
  private readonly logger = new Logger(AdminStudioScenesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
    private readonly storage: StorageService,
  ) {}

  async list(): Promise<AdminStudioScene[]> {
    return this.loadScenes(null, null);
  }

  async create(
    staffUserId: string,
    body: CreateAdminStudioSceneDto,
  ): Promise<AdminStudioScene> {
    // No stored cover on create: any upload that is not the admin's own is
    // refused (the cinema title pattern).
    assertNoForeignUploadIntroduced(staffUserId, body.coverKey, []);
    const coverKey = await this.toSceneScopedCover(body.coverKey);
    let sceneId: string;
    try {
      sceneId = await this.withSlugConflict(() =>
        this.dataSource.transaction(async (manager) => {
          await manager.query(LOCK_SCENES_SQL);
          const slug = body.slug
            ? await this.assertSlugFree(manager, body.slug, null)
            : await this.firstFreeSlug(manager, sceneSlugBase(body.name));
          const saved = await manager.save(
            manager.create(StudioScene, {
              slug,
              name: body.name,
              city: body.city,
              blurb: normalizeSceneBlurb(body.blurb),
              coverKey: coverKey ?? null,
              status: StudioSceneState.Active,
              position: await this.nextActivePosition(manager),
              createdById: staffUserId,
            }),
          );
          return saved.id;
        }),
      );
    } catch (error) {
      // The write rolled back, so the fresh copy is named by no row.
      await this.discardUnusedCopy(body.coverKey, coverKey);
      throw error;
    }
    return this.loadSceneOrThrow(sceneId);
  }

  async update(
    staffUserId: string,
    sceneId: string,
    body: UpdateAdminStudioSceneDto,
  ): Promise<AdminStudioScene> {
    const scene = await this.findSceneOrThrow(sceneId);
    // A cover another staff member uploaded may be re-sent as stored; a new
    // foreign upload is refused.
    assertNoForeignUploadIntroduced(staffUserId, body.coverKey, [
      scene.coverKey,
    ]);
    const coverKey = await this.toSceneScopedCover(body.coverKey);
    let replacedCoverKey: string | null = null;
    try {
      await this.withSlugConflict(() =>
        this.dataSource.transaction(async (manager) => {
          // The row lock serializes cover edits. Everything below compares
          // against the cover stored now, not the one read above.
          const [lockedRow]: { cover_key: string | null }[] =
            await manager.query(LOCK_SCENE_COVER_SQL, [scene.id]);
          if (!lockedRow) {
            throw new NotFoundException('Scene not found');
          }
          const storedCoverKey = lockedRow.cover_key;
          // A re-sent stored copy is a claim about what the scene holds. If
          // another edit replaced it first, saving it would point the scene
          // at the copy that edit deleted.
          if (
            coverKey &&
            isStudioSceneScopedKey(coverKey) &&
            coverKey === body.coverKey &&
            coverKey !== storedCoverKey
          ) {
            throw studioError('studio_scene_cover_changed');
          }
          if (body.slug !== undefined && body.slug !== scene.slug) {
            await this.assertSlugFree(manager, body.slug, scene.id);
          }
          const changes: Partial<StudioScene> = {};
          if (body.name !== undefined) changes.name = body.name;
          if (body.city !== undefined) changes.city = body.city;
          if (body.slug !== undefined) changes.slug = body.slug;
          if (body.blurb !== undefined) {
            changes.blurb = normalizeSceneBlurb(body.blurb);
          }
          if (coverKey !== undefined) changes.coverKey = coverKey;
          if (Object.keys(changes).length) {
            await manager.update(StudioScene, { id: scene.id }, changes);
          }
          if (coverKey !== undefined && coverKey !== storedCoverKey) {
            replacedCoverKey = storedCoverKey;
          }
        }),
      );
    } catch (error) {
      await this.discardUnusedCopy(body.coverKey, coverKey);
      throw error;
    }
    // The cover the write replaced is the one the locked row held, so a
    // live cover is never the one deleted.
    await this.deleteReplacedCover(replacedCoverKey);
    return this.loadSceneOrThrow(scene.id);
  }

  async archive(sceneId: string): Promise<AdminStudioScene> {
    const scene = await this.findSceneOrThrow(sceneId);
    if (scene.status === StudioSceneState.Active) {
      await this.dataSource
        .getRepository(StudioScene)
        .update({ id: scene.id }, { status: StudioSceneState.Archived });
    }
    return this.loadSceneOrThrow(scene.id);
  }

  async restore(sceneId: string): Promise<AdminStudioScene> {
    const storedSceneId = await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_SCENES_SQL);
      const scene = await manager.findOne(StudioScene, {
        where: { id: sceneId },
        select: { id: true, status: true },
      });
      if (!scene) {
        throw new NotFoundException('Scene not found');
      }
      if (scene.status === StudioSceneState.Archived) {
        await manager.update(
          StudioScene,
          { id: scene.id },
          {
            status: StudioSceneState.Active,
            position: await this.nextActivePosition(manager),
          },
        );
      }
      return scene.id;
    });
    return this.loadSceneOrThrow(storedSceneId);
  }

  async reorder(sceneIds: string[]): Promise<AdminStudioScene[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_SCENES_SQL);
      const activeScenes = await manager.find(StudioScene, {
        where: { status: StudioSceneState.Active },
        select: { id: true },
      });
      if (
        !listsEveryIdOnce(
          activeScenes.map((scene) => scene.id),
          sceneIds,
        )
      ) {
        throw studioError('studio_scene_order_mismatch');
      }
      const orderedSceneIds = sceneIds.map((sceneId) => sceneId.toLowerCase());
      await manager.query(REORDER_SCENES_SQL, [
        orderedSceneIds,
        orderedSceneIds.map((_sceneId, index) => index + 1),
      ]);
    });
    return this.loadScenes(null, StudioSceneState.Active);
  }

  async searchEvents(
    query: string,
  ): Promise<{ items: AdminStudioEventOption[] }> {
    const rows: AdminEventOptionRow[] = await this.dataSource.query(
      ADMIN_EVENT_SEARCH_SQL,
      [
        `%${escapeLikeTerm(query.trim())}%`,
        STUDIO_DISCOVERY_LIMITS.adminSearchResults,
      ],
    );
    return { items: rows.map(toAdminStudioEventOption) };
  }

  async listPinnedEvents(sceneId: string): Promise<AdminStudioSceneEvent[]> {
    const scene = await this.findSceneOrThrow(sceneId);
    const rows: AdminSceneEventRow[] = await this.dataSource.query(
      PINNED_EVENTS_SQL,
      [scene.id],
    );
    return rows.map(toAdminStudioSceneEvent);
  }

  async pinEvent(
    staffUserId: string,
    sceneId: string,
    eventId: string,
  ): Promise<AdminStudioSceneEvent[]> {
    const scene = await this.findSceneOrThrow(sceneId);
    const [event]: PinEventReadRow[] = await this.dataSource.query(
      PIN_EVENT_READ_SQL,
      [eventId],
    );
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (!event.is_pinnable) {
      throw studioError('studio_scene_event_not_pinnable');
    }
    await this.dataSource.query(
      `INSERT INTO "studio_scene_events" ("scene_id", "event_id", "pinned_by_id")
       VALUES ($1, $2, $3)
       ON CONFLICT ("scene_id", "event_id") DO NOTHING`,
      [scene.id, event.id, staffUserId],
    );
    return this.listPinnedEvents(scene.id);
  }

  async unpinEvent(sceneId: string, eventId: string): Promise<void> {
    const scene = await this.findSceneOrThrow(sceneId);
    await this.dataSource.query(
      `DELETE FROM "studio_scene_events" WHERE "scene_id" = $1 AND "event_id" = $2`,
      [scene.id, eventId],
    );
  }

  async listReleases(
    sceneId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<AdminStudioReleaseCard>> {
    const scene = await this.findSceneOrThrow(sceneId);
    const pageSize = STUDIO_DISCOVERY_LIMITS.sceneReleasesPerPage;
    const rows: AdminSceneReleaseRow[] = await this.dataSource.query(
      ADMIN_SCENE_RELEASES_SQL,
      [scene.id, ...keysetCursorParameters(cursor), pageSize + 1],
    );
    return toKeysetPage(
      rows,
      pageSize,
      // The cursor's `publishedAt` field carries the truncated
      // `created_at` here; the shape and its decoder are shared.
      (row) => ({ publishedAt: row.created_at_ms, id: row.id }),
      async (pageRows) => {
        const cardsByReleaseId = await this.catalog.cardsByReleaseId(
          pageRows.map((row) => row.id),
        );
        return pageRows.flatMap((row) => {
          const releaseCard = cardsByReleaseId.get(row.id);
          return releaseCard
            ? [toAdminStudioReleaseCard(releaseCard, row.status)]
            : [];
        });
      },
    );
  }

  async removeRelease(sceneId: string, releaseId: string): Promise<void> {
    const scene = await this.findSceneOrThrow(sceneId);
    const changed: { id: string }[] = await this.dataSource.query(
      `WITH "changed" AS (
         UPDATE "studio_releases" SET "scene_id" = NULL
          WHERE "id" = $1 AND "scene_id" = $2
         RETURNING "id"
       )
       SELECT * FROM "changed"`,
      [releaseId, scene.id],
    );
    if (!changed.length) {
      throw new NotFoundException('Release not found');
    }
  }

  // A member-scoped upload becomes a fresh scene-scoped copy. Anything else
  // is stored as sent: an empty value, an external URL, or the scene's own
  // stored copy re-sent (`assertNoForeignUploadIntroduced` refuses any other
  // scene-scoped key).
  private async toSceneScopedCover(
    coverKey: string | null | undefined,
  ): Promise<string | null | undefined> {
    if (!coverKey || storageKeyOwnerId(coverKey) === null) {
      return coverKey;
    }
    try {
      return await this.storage.copyObjectToStudioSceneScope(coverKey);
    } catch (error) {
      if (StorageService.isMissingObjectError(error)) {
        throw new BadRequestException('Cover upload not found');
      }
      throw error;
    }
  }

  // A copy minted for a write that did not commit is named by no row. The
  // files route never served it; this reclaims it now instead of leaving it
  // to the orphan sweep. Best effort and logged.
  private async discardUnusedCopy(
    sentCoverKey: string | null | undefined,
    storedCoverKey: string | null | undefined,
  ): Promise<void> {
    if (
      !storedCoverKey ||
      storedCoverKey === sentCoverKey ||
      !isStudioSceneScopedKey(storedCoverKey)
    ) {
      return;
    }
    try {
      await this.storage.deleteObjectByKey(storedCoverKey);
    } catch (error) {
      this.logger.error(
        `Could not delete the cover copy of a failed scene write: ${String(error)}`,
      );
    }
  }

  // A scene-scoped copy belongs to one scene, so the one it replaced can go.
  // A failure is logged: the files route stopped serving it at commit.
  private async deleteReplacedCover(
    previousCoverKey: string | null,
  ): Promise<void> {
    if (!previousCoverKey || !isStudioSceneScopedKey(previousCoverKey)) {
      return;
    }
    try {
      await this.storage.deleteObjectByKey(previousCoverKey);
    } catch (error) {
      this.logger.error(
        `Could not delete a replaced scene cover: ${String(error)}`,
      );
    }
  }

  private async findSceneOrThrow(sceneId: string): Promise<StudioScene> {
    const scene = await this.dataSource.getRepository(StudioScene).findOne({
      where: { id: sceneId },
      select: { id: true, slug: true, coverKey: true, status: true },
    });
    if (!scene) {
      throw new NotFoundException('Scene not found');
    }
    return scene;
  }

  private async loadSceneOrThrow(sceneId: string): Promise<AdminStudioScene> {
    const [scene] = await this.loadScenes(sceneId, null);
    if (!scene) {
      throw new NotFoundException('Scene not found');
    }
    return scene;
  }

  private async loadScenes(
    sceneId: string | null,
    status: StudioSceneState | null,
  ): Promise<AdminStudioScene[]> {
    const rows: AdminSceneRow[] = await this.dataSource.query(
      ADMIN_SCENES_SQL,
      [sceneId, status],
    );
    return rows.map(toAdminStudioScene);
  }

  private async nextActivePosition(manager: EntityManager): Promise<number> {
    const [row]: { position: number }[] = await manager.query(
      NEXT_ACTIVE_POSITION_SQL,
    );
    return row?.position ?? 1;
  }

  private async assertSlugFree(
    manager: EntityManager,
    slug: string,
    exceptSceneId: string | null,
  ): Promise<string> {
    const taken: unknown[] = await manager.query(
      `SELECT 1 AS "found" FROM "studio_scenes" WHERE "slug" = $1 AND ($2::uuid IS NULL OR "id" <> $2)`,
      [slug, exceptSceneId],
    );
    if (taken.length) {
      throw studioError('studio_scene_slug_taken');
    }
    return slug;
  }

  private async firstFreeSlug(
    manager: EntityManager,
    base: string,
  ): Promise<string> {
    const candidates = sceneSlugCandidates(base);
    const takenRows: { slug: string }[] = await manager.query(
      `SELECT "slug" FROM "studio_scenes" WHERE "slug" = ANY($1::text[])`,
      [candidates],
    );
    const takenSlugs = new Set(takenRows.map((row) => row.slug));
    const freeSlug = candidates.find((candidate) => !takenSlugs.has(candidate));
    if (!freeSlug) {
      throw studioError('studio_scene_slug_taken');
    }
    return freeSlug;
  }

  // A slug claimed by a write that committed first surfaces as the unique
  // violation; it answers the same 409 the pre-check gives.
  private async withSlugConflict<Result>(
    write: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_studio_scenes_slug')) {
        throw studioError('studio_scene_slug_taken');
      }
      throw error;
    }
  }
}

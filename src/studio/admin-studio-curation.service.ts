import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { foldedHaystack, foldedTextExpression } from '../search/search-text';
import {
  AdminPickRow,
  AdminStudioCuration,
  AdminStudioPick,
  AdminStudioReleaseCard,
  groupAdminPicks,
  toAdminStudioPick,
  toAdminStudioReleaseCard,
} from './admin-studio-response';
import {
  CreateAdminStudioPickDto,
  UpdateAdminStudioPickDto,
} from './dto/admin-studio-curation.dto';
import {
  StudioCuratedPick,
  StudioCuratedPickShelf,
} from './entities/studio-curated-pick.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  CURATED_PICKS_FROM_SQL,
  CURATED_PICKS_ORDER_SQL,
} from './studio-discovery-sql';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_DISCOVERY_LIMITS,
  StudioCurationShelf,
  studioError,
} from './studio.constants';

/** Whether a requested order names every current id exactly once. Ids are
 *  compared lowercase, the form Postgres hands a uuid back in. */
export function listsEveryIdOnce(
  currentIds: string[],
  requestedIds: string[],
): boolean {
  if (currentIds.length !== requestedIds.length) {
    return false;
  }
  const requestedSet = new Set(requestedIds.map((id) => id.toLowerCase()));
  return (
    requestedSet.size === requestedIds.length &&
    currentIds.every((id) => requestedSet.has(id.toLowerCase()))
  );
}

/** Trimmed; an empty note is stored as null. */
export function normalizePickNote(
  note: string | null | undefined,
): string | null {
  const trimmedNote = note?.trim();
  return trimmedNote ? trimmedNote : null;
}

const PICK_SHELF_BY_NAME: Readonly<
  Record<StudioCurationShelf, StudioCuratedPickShelf>
> = {
  featured: StudioCuratedPickShelf.Featured,
  staff_picks: StudioCuratedPickShelf.StaffPicks,
  new_this_week: StudioCuratedPickShelf.NewThisWeek,
};

/** Every shelf write takes this first, so writes to the shelves run one at
 *  a time: an append never collides with another append, and a reorder
 *  queued behind a remove reads the shorter shelf. Staff-only and tiny. */
const LOCK_PICKS_SQL =
  'LOCK TABLE "studio_curated_picks" IN SHARE ROW EXCLUSIVE MODE';

/** `$1` a shelf or null, `$2` a pick id or null. Staff see every row; the
 *  listenable flag ignores blocks. */
const ADMIN_PICKS_SQL = `SELECT "pick"."id" AS "id",
       "pick"."shelf"::text AS "shelf",
       "pick"."position" AS "position",
       "pick"."note" AS "note",
       "pick"."created_at" AS "created_at",
       "pick"."release_id" AS "release_id",
       "release"."status"::text AS "release_status",
       ("release"."status" = 'published' AND ${listenablePersonaSql('persona')}) AS "is_listenable"
  ${CURATED_PICKS_FROM_SQL}
 WHERE ($1::text IS NULL OR "pick"."shelf"::text = $1)
   AND ($2::uuid IS NULL OR "pick"."id" = $2)
 ${CURATED_PICKS_ORDER_SQL}`;

/** `$1` the LIKE pattern, `$2` the limit. Published releases by folded title
 *  or artist name, the Studio search matching. */
const ADMIN_RELEASE_SEARCH_SQL = `SELECT "release"."id" AS "id",
       "release"."status"::text AS "status"
  FROM "studio_releases" "release"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."status" = 'published'
   AND (${foldedHaystack('release', ['title'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\'
     OR ${foldedHaystack('persona', ['display_name'])} LIKE ${foldedTextExpression('$1')} ESCAPE '\\')
 ORDER BY "release"."published_at" DESC, "release"."id" DESC
 LIMIT $2`;

const REORDER_PICKS_SQL = `UPDATE "studio_curated_picks" AS "pick" SET "position" = "ordering"."position"
  FROM unnest($2::uuid[], $3::smallint[]) AS "ordering"("pick_id", "position")
 WHERE "pick"."id" = "ordering"."pick_id" AND "pick"."shelf" = $1`;

/**
 * Studio discovery: the staff side of the shelves (Moderator and Admin).
 * Follows `AdminTopicsService` for the CRUD and `AdminStickersService` for
 * the every-id-once reorder, with the v2 playlist entry-order pattern for
 * the positions: one transaction, the deferrable constraint deferred, one
 * `UPDATE ... FROM unnest(...)`.
 */
@Injectable()
export class AdminStudioCurationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
  ) {}

  async getCuration(): Promise<AdminStudioCuration> {
    return groupAdminPicks(await this.loadPicks({}));
  }

  async searchReleases(
    query: string,
  ): Promise<{ items: AdminStudioReleaseCard[] }> {
    const rows: { id: string; status: StudioReleaseStatus }[] =
      await this.dataSource.query(ADMIN_RELEASE_SEARCH_SQL, [
        `%${escapeLikeTerm(query.trim())}%`,
        STUDIO_DISCOVERY_LIMITS.adminSearchResults,
      ]);
    const cardsByReleaseId = await this.catalog.cardsByReleaseId(
      rows.map((row) => row.id),
    );
    return {
      items: rows.flatMap((row) => {
        const releaseCard = cardsByReleaseId.get(row.id);
        return releaseCard
          ? [toAdminStudioReleaseCard(releaseCard, row.status)]
          : [];
      }),
    };
  }

  async addPick(
    staffUserId: string,
    body: CreateAdminStudioPickDto,
  ): Promise<AdminStudioPick> {
    const shelf = PICK_SHELF_BY_NAME[body.shelf];
    const pickId = await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PICKS_SQL);
      const release = await manager.findOne(StudioRelease, {
        where: { id: body.releaseId },
        select: { id: true, status: true },
      });
      if (!release) {
        throw new NotFoundException('Release not found');
      }
      if (release.status !== StudioReleaseStatus.Published) {
        throw studioError('studio_curation_release_not_published');
      }
      const isAlreadyOnShelf = await manager.exists(StudioCuratedPick, {
        where: { shelf, releaseId: release.id },
      });
      if (isAlreadyOnShelf) {
        throw studioError('studio_curation_already_on_shelf');
      }
      let position: number;
      if (shelf === StudioCuratedPickShelf.Featured) {
        // Posting a featured pick replaces the current one, so the
        // featured shelf never reports itself full.
        await manager.delete(StudioCuratedPick, { shelf });
        position = 1;
      } else {
        const shelfCount = await manager.count(StudioCuratedPick, {
          where: { shelf },
        });
        if (shelfCount >= STUDIO_DISCOVERY_LIMITS.curationShelfMax) {
          throw studioError('studio_curation_shelf_full');
        }
        position = shelfCount + 1;
      }
      const saved = await manager.save(
        manager.create(StudioCuratedPick, {
          shelf,
          releaseId: release.id,
          note: normalizePickNote(body.note),
          position,
          createdById: staffUserId,
        }),
      );
      return saved.id;
    });
    return this.loadPickOrThrow(pickId);
  }

  async updateNote(
    pickId: string,
    body: UpdateAdminStudioPickDto,
  ): Promise<AdminStudioPick> {
    const picks = this.dataSource.getRepository(StudioCuratedPick);
    const pick = await picks.findOne({
      where: { id: pickId },
      select: { id: true },
    });
    if (!pick) {
      throw new NotFoundException('Pick not found');
    }
    await picks.update({ id: pick.id }, { note: normalizePickNote(body.note) });
    return this.loadPickOrThrow(pick.id);
  }

  async removePick(pickId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PICKS_SQL);
      const pick = await manager.findOne(StudioCuratedPick, {
        where: { id: pickId },
        select: { id: true, shelf: true, position: true },
      });
      if (!pick) {
        throw new NotFoundException('Pick not found');
      }
      await manager.delete(StudioCuratedPick, { id: pick.id });
      await manager.query(
        `UPDATE "studio_curated_picks" SET "position" = "position" - 1 WHERE "shelf" = $1 AND "position" > $2`,
        [pick.shelf, pick.position],
      );
    });
  }

  async reorderShelf(
    shelfName: StudioCurationShelf,
    pickIds: string[],
  ): Promise<AdminStudioPick[]> {
    const shelf = PICK_SHELF_BY_NAME[shelfName];
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PICKS_SQL);
      await manager.query(
        `SET CONSTRAINTS "UQ_studio_curated_picks_shelf_position" DEFERRED`,
      );
      const currentPicks = await manager.find(StudioCuratedPick, {
        where: { shelf },
        select: { id: true },
      });
      if (
        !listsEveryIdOnce(
          currentPicks.map((pick) => pick.id),
          pickIds,
        )
      ) {
        throw studioError('studio_curation_order_mismatch');
      }
      const orderedPickIds = pickIds.map((pickId) => pickId.toLowerCase());
      await manager.query(REORDER_PICKS_SQL, [
        shelf,
        orderedPickIds,
        orderedPickIds.map((_pickId, index) => index + 1),
      ]);
    });
    return this.loadPicks({ shelf: shelfName });
  }

  private async loadPickOrThrow(pickId: string): Promise<AdminStudioPick> {
    const [pick] = await this.loadPicks({ pickId });
    if (!pick) {
      throw new NotFoundException('Pick not found');
    }
    return pick;
  }

  private async loadPicks(filter: {
    shelf?: StudioCurationShelf;
    pickId?: string;
  }): Promise<AdminStudioPick[]> {
    const rows: AdminPickRow[] = await this.dataSource.query(ADMIN_PICKS_SQL, [
      filter.shelf ?? null,
      filter.pickId ?? null,
    ]);
    const cardsByReleaseId = await this.catalog.cardsByReleaseId([
      ...new Set(rows.map((row) => row.release_id)),
    ]);
    return rows.flatMap((row) => {
      const releaseCard = cardsByReleaseId.get(row.release_id);
      return releaseCard ? [toAdminStudioPick(row, releaseCard)] : [];
    });
  }
}

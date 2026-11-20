import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  isCulturalUuid,
  normalizeGuideCreate,
  normalizeGuideReplace,
} from './cultural-input';
import { culturalError } from './cultural-production.constants';
import {
  canDeleteCulturalItem,
  toCulturalGuide,
  toCulturalGuideListItem,
  type CulturalCaller,
  type CulturalGuideDTO,
  type CulturalGuideListDTO,
  type CulturalStaffSummaryDTO,
} from './cultural-response';
import { readCulturalStaffSummaries } from './cultural-staff-read';
import type {
  CreateCulturalGuideDto,
  ReplaceCulturalGuideDto,
} from './dto/cultural-production.dto';
import { CulturalGuide } from './entities/cultural-guide.entity';

/**
 * The guarded save of a whole guide (contract 7.2). `$1` the guide id, `$2`
 * the revision the edit started from, `$3` title, `$4` event type, `$5`
 * locale, `$6` summary, `$7` the sections as JSON text, `$8` the caller. The
 * row changes only while its revision still equals `$2`, so of two saves
 * from one revision the second writes nothing. The data-modifying CTE hands
 * the written id back through `EntityManager.query`, which answers a bare
 * `UPDATE ... RETURNING` as a rows and count pair.
 */
export const REPLACE_CULTURAL_GUIDE_SQL = `WITH "replaced" AS (
  UPDATE "cultural_guides"
     SET "title" = $3::varchar,
         "event_type" = $4::varchar,
         "locale" = $5::varchar,
         "summary" = $6::varchar,
         "sections" = $7::jsonb,
         "revision" = "revision" + 1,
         "updated_by_id" = $8::uuid,
         "updated_at" = now()
   WHERE "id" = $1::uuid AND "revision" = $2::int
  RETURNING "id"
)
SELECT "id" FROM "replaced"`;

/** One row of `REPLACE_CULTURAL_GUIDE_SQL`. */
interface ReplacedGuideRow {
  id: string;
}

/**
 * Cultural Production guides: list, read, create, replace and delete. A
 * malformed id answers `CULTURAL_GUIDE_NOT_FOUND` before any query, and every
 * field check runs before any write. A save replaces the whole guide through
 * one conditional UPDATE on `revision`; a save from a revision that moved
 * answers `CULTURAL_GUIDE_EDIT_CONFLICT` with the current revision. Deleting
 * a guide keeps its tasks (their `guide_id` turns null). Every person on an
 * answer comes from one staff summary read. Nothing here logs guide text.
 */
@Injectable()
export class CulturalGuidesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /** Every guide by `event_type, locale, title, id`, each row with its
   *  section and step counts and without its sections. */
  async listGuides(caller: CulturalCaller): Promise<CulturalGuideListDTO> {
    const manager = this.dataSource.manager;
    const guides = await manager.find(CulturalGuide, {
      order: { eventType: 'ASC', locale: 'ASC', title: 'ASC', id: 'ASC' },
    });
    const people = await this.readPeople(manager, guides);
    return {
      items: guides.map((guide) =>
        toCulturalGuideListItem(guide, people, caller),
      ),
    };
  }

  /** One whole guide with its sections and current revision. */
  async getGuide(
    guideId: string,
    caller: CulturalCaller,
  ): Promise<CulturalGuideDTO> {
    const id = guideIdOf(guideId);
    const manager = this.dataSource.manager;
    const guide = await manager.findOne(CulturalGuide, { where: { id } });
    if (!guide) {
      throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
    }
    const people = await this.readPeople(manager, [guide]);
    return toCulturalGuide(guide, people, caller);
  }

  /** Creates a guide at revision 1 with the caller as its author. The field
   *  checks run first, in the contract's create order. No person has saved
   *  it yet, so `updatedBy` stays null. */
  async createGuide(
    body: CreateCulturalGuideDto,
    caller: CulturalCaller,
  ): Promise<CulturalGuideDTO> {
    const guide = normalizeGuideCreate(body);
    const manager = this.dataSource.manager;
    const saved = await manager.save(
      CulturalGuide,
      manager.create(CulturalGuide, {
        title: guide.title,
        eventType: guide.eventType,
        locale: guide.locale,
        summary: guide.summary,
        sections: guide.sections,
        revision: 1,
        authorId: caller.userId,
        updatedById: null,
      }),
    );
    return this.getGuide(saved.id, caller);
  }

  /** Replaces a whole guide. The id shape, then every field in the contract
   *  order (revision first), then one conditional UPDATE that raises the
   *  revision and names the caller as the last editor. No row written: a
   *  guide that still exists answers 409 `CULTURAL_GUIDE_EDIT_CONFLICT` with
   *  its current revision, a missing one 404 `CULTURAL_GUIDE_NOT_FOUND`. */
  async replaceGuide(
    guideId: string,
    body: ReplaceCulturalGuideDto,
    caller: CulturalCaller,
  ): Promise<CulturalGuideDTO> {
    const id = guideIdOf(guideId);
    const guide = normalizeGuideReplace(body);
    const manager = this.dataSource.manager;
    const replacedRows: ReplacedGuideRow[] = await manager.query(
      REPLACE_CULTURAL_GUIDE_SQL,
      [
        id,
        guide.revision,
        guide.title,
        guide.eventType,
        guide.locale,
        guide.summary,
        JSON.stringify(guide.sections),
        caller.userId,
      ],
    );
    if (replacedRows.length === 0) {
      const current = await manager.findOne(CulturalGuide, {
        where: { id },
        select: { id: true, revision: true },
      });
      if (!current) {
        throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
      }
      throw culturalError('CULTURAL_GUIDE_EDIT_CONFLICT', {
        revision: current.revision,
      });
    }
    return this.getGuide(id, caller);
  }

  /** Deletes a guide: the id shape, the row (404), then the permission (403
   *  `CULTURAL_GUIDE_NOT_YOURS`): its author, or any Moderator or Admin. A
   *  seeded guide has no author, so only the staff tier deletes it. Only the
   *  guide row is deleted; its tasks stay with `guide_id` set null by the
   *  foreign key. */
  async deleteGuide(
    guideId: string,
    caller: CulturalCaller,
  ): Promise<{ ok: true }> {
    const id = guideIdOf(guideId);
    await this.dataSource.transaction(async (manager) => {
      const guide = await manager.findOne(CulturalGuide, {
        where: { id },
        select: { id: true, authorId: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!guide) {
        throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
      }
      if (!canDeleteCulturalItem(guide.authorId, caller)) {
        throw culturalError('CULTURAL_GUIDE_NOT_YOURS');
      }
      await manager.delete(CulturalGuide, { id: guide.id });
    });
    return { ok: true };
  }

  /** The summaries of every author and last editor of `guides`, in one read. */
  private readPeople(
    manager: EntityManager,
    guides: readonly CulturalGuide[],
  ): Promise<Map<string, CulturalStaffSummaryDTO>> {
    const userIds = guides.flatMap((guide) =>
      [guide.authorId, guide.updatedById].filter(
        (userId): userId is string => userId !== null,
      ),
    );
    return readCulturalStaffSummaries(manager, this.mediaCropService, userIds);
  }
}

/** A path guide id, lowercased, once it has the uuid shape. Anything else
 *  answers `CULTURAL_GUIDE_NOT_FOUND` before any query. */
function guideIdOf(guideId: unknown): string {
  if (!isCulturalUuid(guideId)) {
    throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
  }
  return guideId.toLowerCase();
}

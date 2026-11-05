import { HttpStatus, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, In } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { listsEveryIdOnce } from '../listings/directory-partners.rules';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PersonaWallPick } from './entities/persona-wall-pick.entity';
import { PersonaWallSettings } from './entities/persona-wall-settings.entity';
import { Subprofile } from './entities/subprofile.entity';
import {
  PERSONA_WALL_PERSONA_FIELDS,
  type PersonaWallAdminDTO,
  type PersonaWallPersonaRow,
  type PersonaWallPublicResponse,
  type PersonaWallSearchResultDTO,
  toPersonaWallPick,
  toPersonaWallSearchResult,
} from './persona-wall-response';
import {
  DEFAULT_PERSONA_WALL_FILL_ORDER,
  PERSONA_WALL_MAX_PICKS,
  PERSONA_WALL_POSITION_CONSTRAINT,
  PERSONA_WALL_SEARCH_LIMIT,
  PERSONA_WALL_SETTINGS_ID,
  type PersonaWallFillOrder,
  personaWallError,
} from './persona-wall.constants';
import {
  isPersonaWallFillOrder,
  lisbonWallDay,
  normalizeWallSearchTerm,
  personaWallPublicStateOf,
} from './persona-wall.rules';
import {
  type PersonaWallCard,
  SubprofilePublicReadService,
} from './subprofile-public-read.service';
import {
  isSubprofileUnderTakedown,
  SUBPROFILE_MODERATION_SUBJECT_TYPE,
} from './subprofile-takedown';

/** Every wall pick write takes this first, so writes run one at a time: an
 *  append never collides with another append, and a reorder queued behind a
 *  remove reads the shorter list. Admin only and at most 9 rows. */
export const LOCK_WALL_PICKS_SQL =
  'LOCK TABLE "persona_wall_picks" IN SHARE ROW EXCLUSIVE MODE';

/** Lets a reorder or a remove rewrite positions in one statement. */
export const DEFER_WALL_POSITION_SQL = `SET CONSTRAINTS "${PERSONA_WALL_POSITION_CONSTRAINT}" DEFERRED`;

/** `$1` the pick ids in the new order, `$2` their positions 1..n. */
export const REORDER_WALL_PICKS_SQL = `UPDATE "persona_wall_picks" AS "pick" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("pick_id", "position")
 WHERE "pick"."id" = "ordering"."pick_id"`;

/** `$1` the position of the removed pick. Every later pick moves up one. */
export const CLOSE_WALL_POSITION_GAP_SQL = `UPDATE "persona_wall_picks" SET "position" = "position" - 1 WHERE "position" > $1`;

/** `$1` the fill order, `$2` the admin who set it. Writes the single settings
 *  row, so the first save creates it and every later save overwrites it. */
export const UPSERT_WALL_SETTINGS_SQL = `INSERT INTO "persona_wall_settings" ("id", "fill_order", "updated_by_id", "updated_at")
VALUES (${PERSONA_WALL_SETTINGS_ID}, $1, $2, now())
ON CONFLICT ("id") DO UPDATE SET "fill_order" = EXCLUDED."fill_order", "updated_by_id" = EXCLUDED."updated_by_id", "updated_at" = now()`;

/** The picks in position order and the stored fill order. */
interface PersonaWallSetup {
  picks: PersonaWallPick[];
  fillOrder: PersonaWallFillOrder;
}

/** The persona columns the admin view reads for its picks: the admin
 *  projection's allowlist plus the three columns the public state needs. No
 *  owner field is in the list, so none can reach a response. */
const PICK_PERSONA_FIELDS = [
  ...PERSONA_WALL_PERSONA_FIELDS,
  'status',
  'visibility',
  'removedAt',
] as const;

/** `PICK_PERSONA_FIELDS` as a TypeORM select. */
const PICK_PERSONA_SELECT = Object.fromEntries(
  PICK_PERSONA_FIELDS.map((field) => [field, true]),
) as Record<(typeof PICK_PERSONA_FIELDS)[number], true>;

/** The avatar and cover keys of persona rows, blanks dropped, for one batched
 *  crop lookup. */
function imageKeysOf(rows: PersonaWallPersonaRow[]): string[] {
  return rows.flatMap((row) =>
    [row.avatarUrl, row.coverUrl].filter((key): key is string => Boolean(key)),
  );
}

/**
 * Persona wall: the hand-picked personas on the People Directory hero and the
 * fill order for the rest (admin writes are Admin only). Modelled on
 * `DirectoryPartnersService`. Every pick write runs behind one table lock, and
 * every admin route answers the full admin view, so the client replaces its
 * cache in one step. Each refusal goes through `personaWallError`, and a
 * malformed id answers its reason code before any query runs. The public wall
 * and the admin preview both come from `listWallCards`, so they pass the
 * directory's own visibility rules.
 */
@Injectable()
export class PersonaWallService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly publicRead: SubprofilePublicReadService,
    private readonly contentModeration: ContentModerationService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /** The public wall for one viewer: the directory cards, 0..9, in wall
   *  order. `now` picks the Lisbon day of the daily shuffle. */
  async publicWall(
    viewerId: string,
    now: Date = new Date(),
  ): Promise<PersonaWallPublicResponse> {
    const setup = await this.loadWallSetup();
    const wallCards = await this.listWallCardsFor(setup, viewerId, now);
    return { items: wallCards.map((wallCard) => wallCard.card) };
  }

  /** What every admin route answers: the fill order, every pick with the
   *  reason it does or does not show, and the wall as most members see it
   *  (no viewer block filter). A pick's `position` is its 1-based place in
   *  position order, so a gap a cascade delete left never shows. */
  async adminView(now: Date = new Date()): Promise<PersonaWallAdminDTO> {
    const setup = await this.loadWallSetup();
    const pickedSubprofileIds = setup.picks.map((pick) => pick.subprofileId);
    const [personas, takedownStates, previewCards] = await Promise.all([
      pickedSubprofileIds.length > 0
        ? this.dataSource.manager.find(Subprofile, {
            where: { id: In(pickedSubprofileIds) },
            select: PICK_PERSONA_SELECT,
          })
        : Promise.resolve([]),
      this.contentModeration.statesFor(
        SUBPROFILE_MODERATION_SUBJECT_TYPE,
        pickedSubprofileIds,
      ),
      this.listWallCardsFor(setup, null, now),
    ]);
    const crops = await this.mediaCropService.getMany(imageKeysOf(personas));
    const personaById = new Map(
      personas.map((persona) => [persona.id, persona]),
    );
    // A persona deleted between the two reads took its pick with it.
    const pickedPersonas = setup.picks.flatMap((pick) => {
      const persona = personaById.get(pick.subprofileId);
      return persona ? [{ pick, persona }] : [];
    });
    return {
      fillOrder: setup.fillOrder,
      picks: pickedPersonas.map(({ pick, persona }, index) => {
        const takedownState = takedownStates.get(persona.id);
        const isTakenDown = Boolean(
          takedownState?.hidden || takedownState?.removed,
        );
        return toPersonaWallPick(
          pick.id,
          index + 1,
          persona,
          crops,
          personaWallPublicStateOf(persona, isTakenDown),
        );
      }),
      preview: previewCards.map((wallCard) => ({
        ...wallCard.card,
        wallSource: wallCard.wallSource,
      })),
    };
  }

  /** The picker search: the directory's own search over its base set, 20 at
   *  most, marked with the personas already picked. A blank or non-string
   *  query answers no items, and a long one is cut to its first 100 code
   *  points. */
  async searchPersonas(
    query: unknown,
  ): Promise<{ items: PersonaWallSearchResultDTO[] }> {
    const searchTerm = normalizeWallSearchTerm(query);
    if (!searchTerm) {
      return { items: [] };
    }
    const [rows, picks] = await Promise.all([
      this.publicRead.searchWallPersonas(searchTerm, PERSONA_WALL_SEARCH_LIMIT),
      this.dataSource.manager.find(PersonaWallPick, {
        select: { subprofileId: true },
      }),
    ]);
    const pickedSubprofileIds = new Set(picks.map((pick) => pick.subprofileId));
    const crops = await this.mediaCropService.getMany(imageKeysOf(rows));
    return {
      items: rows.map((row) =>
        toPersonaWallSearchResult(row, crops, pickedSubprofileIds.has(row.id)),
      ),
    };
  }

  /** Appends a persona at the end of the picks. Checks run in the contract's
   *  order: malformed id, persona, already picked, public visibility, limit.
   *  The persona row is read under a share lock, so a delete cannot remove it
   *  between the checks and the insert. */
  async addPick(
    adminUserId: string,
    subprofileId: unknown,
  ): Promise<PersonaWallAdminDTO> {
    if (typeof subprofileId !== 'string' || !isUUID(subprofileId)) {
      throw personaWallError('PERSONA_WALL_PERSONA_NOT_FOUND', {
        status: HttpStatus.BAD_REQUEST,
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_WALL_PICKS_SQL);
      const persona = await manager.findOne(Subprofile, {
        where: { id: subprofileId },
        select: { id: true, status: true, visibility: true, removedAt: true },
        lock: { mode: 'pessimistic_read' },
      });
      if (!persona) {
        throw personaWallError('PERSONA_WALL_PERSONA_NOT_FOUND');
      }
      const isAlreadyPicked = await manager.exists(PersonaWallPick, {
        where: { subprofileId: persona.id },
      });
      if (isAlreadyPicked) {
        throw personaWallError('PERSONA_WALL_ALREADY_PICKED');
      }
      const isTakenDown = await isSubprofileUnderTakedown(
        this.contentModeration,
        persona.id,
      );
      const publicState = personaWallPublicStateOf(persona, isTakenDown);
      if (publicState !== 'shown') {
        throw personaWallError('PERSONA_WALL_NOT_LISTED', { publicState });
      }
      const pickCount = await manager.count(PersonaWallPick);
      if (pickCount >= PERSONA_WALL_MAX_PICKS) {
        throw personaWallError('PERSONA_WALL_FULL');
      }
      // A persona delete cascades to its pick and leaves a gap in the
      // positions, so the new pick goes after the highest one. The count
      // only guards the limit.
      const highestPosition =
        (await manager.maximum(PersonaWallPick, 'position')) ?? 0;
      await manager.save(
        manager.create(PersonaWallPick, {
          subprofileId: persona.id,
          position: highestPosition + 1,
          addedById: adminUserId,
        }),
      );
    });
    return this.adminView();
  }

  /** Rewrites every position in one statement. The request names every
   *  current pick id once, so a non-array body, a stale list from another
   *  tab, a repeated id or a foreign id answers
   *  `PERSONA_WALL_REORDER_MISMATCH`. */
  async reorderPicks(ids: unknown): Promise<PersonaWallAdminDTO> {
    if (
      !Array.isArray(ids) ||
      !ids.every((pickId): pickId is string => typeof pickId === 'string')
    ) {
      throw personaWallError('PERSONA_WALL_REORDER_MISMATCH');
    }
    const requestedPickIds: string[] = ids;
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_WALL_PICKS_SQL);
      await manager.query(DEFER_WALL_POSITION_SQL);
      const currentPicks = await manager.find(PersonaWallPick, {
        select: { id: true },
      });
      if (
        !listsEveryIdOnce(
          currentPicks.map((pick) => pick.id),
          requestedPickIds,
        )
      ) {
        throw personaWallError('PERSONA_WALL_REORDER_MISMATCH');
      }
      const orderedPickIds = requestedPickIds.map((pickId) =>
        pickId.toLowerCase(),
      );
      await manager.query(REORDER_WALL_PICKS_SQL, [
        orderedPickIds,
        orderedPickIds.map((_pickId, index) => index + 1),
      ]);
    });
    return this.adminView();
  }

  /** Deletes the pick and moves every later pick up one. */
  async removePick(pickId: string): Promise<PersonaWallAdminDTO> {
    if (!isUUID(pickId)) {
      throw personaWallError('PERSONA_WALL_PICK_NOT_FOUND');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_WALL_PICKS_SQL);
      await manager.query(DEFER_WALL_POSITION_SQL);
      const pick = await manager.findOne(PersonaWallPick, {
        where: { id: pickId },
        select: { id: true, position: true },
      });
      if (!pick) {
        throw personaWallError('PERSONA_WALL_PICK_NOT_FOUND');
      }
      await manager.delete(PersonaWallPick, { id: pick.id });
      await manager.query(CLOSE_WALL_POSITION_GAP_SQL, [pick.position]);
    });
    return this.adminView();
  }

  /** Stores the fill order and who set it on the single settings row. */
  async updateSettings(
    adminUserId: string,
    fillOrder: unknown,
  ): Promise<PersonaWallAdminDTO> {
    if (!isPersonaWallFillOrder(fillOrder)) {
      throw personaWallError('PERSONA_WALL_INVALID_FILL_ORDER');
    }
    await this.dataSource.manager.query(UPSERT_WALL_SETTINGS_SQL, [
      fillOrder,
      adminUserId,
    ]);
    return this.adminView();
  }

  /** The picks in position order and the stored fill order. A missing
   *  settings row, or a value that is no fill order, reads as the default. */
  private async loadWallSetup(): Promise<PersonaWallSetup> {
    const [picks, settings] = await Promise.all([
      this.dataSource.manager.find(PersonaWallPick, {
        select: { id: true, subprofileId: true, position: true },
        order: { position: 'ASC' },
      }),
      this.dataSource.manager.findOne(PersonaWallSettings, {
        where: { id: PERSONA_WALL_SETTINGS_ID },
        select: { id: true, fillOrder: true },
      }),
    ]);
    const storedFillOrder: unknown = settings?.fillOrder;
    return {
      picks,
      fillOrder: isPersonaWallFillOrder(storedFillOrder)
        ? storedFillOrder
        : DEFAULT_PERSONA_WALL_FILL_ORDER,
    };
  }

  /** The wall tiles for a viewer (`null` for the admin preview and search,
   *  which skip the viewer block filter). */
  private listWallCardsFor(
    setup: PersonaWallSetup,
    viewerId: string | null,
    now: Date,
  ): Promise<PersonaWallCard[]> {
    return this.publicRead.listWallCards({
      pickedSubprofileIds: setup.picks.map((pick) => pick.subprofileId),
      fillOrder: setup.fillOrder,
      viewerId,
      wallDay: lisbonWallDay(now),
    });
  }
}

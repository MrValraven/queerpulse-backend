import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { escapeLikeTerm } from '../common/like-escape';
import {
  listsEveryIdOnce,
  normalizePickNote,
} from './admin-studio-curation.service';
import {
  AdminSpotlightArtistOptionRow,
  AdminSpotlightArtistRow,
  AdminStudioSpotlight,
  AdminStudioSpotlightArtist,
  AdminStudioSpotlightArtistOption,
  groupAdminSpotlight,
  toAdminStudioSpotlightArtist,
  toAdminStudioSpotlightArtistOption,
} from './admin-studio-spotlight-response';
import {
  ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL,
  ADMIN_SPOTLIGHT_SQL,
  CLOSE_SPOTLIGHT_GAP_SQL,
  DEFER_SPOTLIGHT_POSITIONS_SQL,
  DELETE_ARTIST_OF_THE_MONTH_SQL,
  DELETE_SPOTLIGHT_SQL,
  INSERT_SPOTLIGHT_SQL,
  LOCK_SPOTLIGHT_PERSONA_SQL,
  LOCK_SPOTLIGHT_SQL,
  NEW_STAR_IDS_SQL,
  REORDER_NEW_STARS_SQL,
  SPOTLIGHT_PLACEMENT_STATE_SQL,
  SPOTLIGHT_SLOT_SUBPROFILE_CONSTRAINT,
  UPDATE_SPOTLIGHT_NOTE_SQL,
} from './admin-studio-spotlight-sql';
import {
  PlaceAdminStudioSpotlightArtistDto,
  UpdateAdminStudioSpotlightArtistDto,
} from './dto/admin-studio-spotlight.dto';
import {
  STUDIO_DISCOVERY_LIMITS,
  StudioSpotlightSlot,
  studioError,
} from './studio.constants';

/** One row of `SPOTLIGHT_PLACEMENT_STATE_SQL`. */
type PlacementStateRow = {
  is_artist: boolean;
  has_release: boolean;
  is_in_new_stars: boolean;
  new_stars_count: number;
};

/**
 * Studio spotlight curation: the staff side of Artist of the month and New
 * stars. Follows the `AdminStudioCurationService` precedent: every write
 * takes the table lock first, a reorder defers the position constraint and
 * writes every position in one `UPDATE ... FROM unnest(...)`. The curator id
 * is stored on the row and is never sent back. Curation writes no audit
 * rows, and neither does this.
 */
@Injectable()
export class AdminStudioSpotlightService {
  constructor(private readonly dataSource: DataSource) {}

  async getSpotlight(): Promise<AdminStudioSpotlight> {
    const rows: AdminSpotlightArtistRow[] = await this.dataSource.query(
      ADMIN_SPOTLIGHT_SQL,
      [null, null],
    );
    return groupAdminSpotlight(rows.map(toAdminStudioSpotlightArtist));
  }

  async searchArtists(
    query: string,
  ): Promise<{ items: AdminStudioSpotlightArtistOption[] }> {
    const rows: AdminSpotlightArtistOptionRow[] = await this.dataSource.query(
      ADMIN_SPOTLIGHT_ARTIST_SEARCH_SQL,
      [
        `%${escapeLikeTerm(query.trim())}%`,
        STUDIO_DISCOVERY_LIMITS.adminSearchResults,
      ],
    );
    return { items: rows.map(toAdminStudioSpotlightArtistOption) };
  }

  /** Replaces the current artist with a fresh row: a fresh pick date, the
   *  caller as curator and the body's note. A refusal leaves the current
   *  artist in place, because the check runs before the delete. */
  async setArtistOfTheMonth(
    staffUserId: string,
    body: PlaceAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    const spotlightId = await this.dataSource.transaction(async (manager) => {
      // Persona row first, then the table: the order a persona unlink locks in.
      await manager.query(LOCK_SPOTLIGHT_PERSONA_SQL, [body.subprofileId]);
      await manager.query(LOCK_SPOTLIGHT_SQL);
      this.assertPlaceable(
        await this.readPlacementState(manager, body.subprofileId),
        'artist_of_the_month',
      );
      await manager.query(DELETE_ARTIST_OF_THE_MONTH_SQL);
      return this.insertSpotlight(
        manager,
        'artist_of_the_month',
        staffUserId,
        body,
      );
    });
    return this.loadOneOrThrow(spotlightId);
  }

  /** Resolves whether or not the slot held an artist. */
  async clearArtistOfTheMonth(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_SPOTLIGHT_SQL);
      await manager.query(DELETE_ARTIST_OF_THE_MONTH_SQL);
    });
  }

  /** Appends the artist after the last position in New stars. */
  async addNewStar(
    staffUserId: string,
    body: PlaceAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    let spotlightId: string;
    try {
      spotlightId = await this.dataSource.transaction(async (manager) => {
        // Persona row first, then the table: the order a persona unlink locks in.
        await manager.query(LOCK_SPOTLIGHT_PERSONA_SQL, [body.subprofileId]);
        await manager.query(LOCK_SPOTLIGHT_SQL);
        this.assertPlaceable(
          await this.readPlacementState(manager, body.subprofileId),
          'new_stars',
        );
        return this.insertSpotlight(manager, 'new_stars', staffUserId, body);
      });
    } catch (error) {
      if (isUniqueViolation(error, SPOTLIGHT_SLOT_SUBPROFILE_CONSTRAINT)) {
        throw studioError('studio_spotlight_already_in_slot');
      }
      throw error;
    }
    return this.loadOneOrThrow(spotlightId);
  }

  /** Changes the note and keeps the pick date. */
  async updateNote(
    spotlightId: string,
    body: UpdateAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    const changedRows: { id: string }[] = await this.dataSource.query(
      UPDATE_SPOTLIGHT_NOTE_SQL,
      [spotlightId, normalizePickNote(body.note)],
    );
    if (changedRows.length === 0) {
      throw studioError('studio_spotlight_not_found');
    }
    return this.loadOneOrThrow(spotlightId);
  }

  /** Deletes the row and moves every later row in its slot up by one. */
  async removeSpotlightArtist(spotlightId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_SPOTLIGHT_SQL);
      const [removed]: { slot: StudioSpotlightSlot; position: number }[] =
        await manager.query(DELETE_SPOTLIGHT_SQL, [spotlightId]);
      if (!removed) {
        throw studioError('studio_spotlight_not_found');
      }
      await manager.query(CLOSE_SPOTLIGHT_GAP_SQL, [
        removed.slot,
        removed.position,
      ]);
    });
  }

  /** `spotlightIds` names every New stars row once, in the new order. */
  async reorderNewStars(
    spotlightIds: string[],
  ): Promise<AdminStudioSpotlightArtist[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_SPOTLIGHT_SQL);
      await manager.query(DEFER_SPOTLIGHT_POSITIONS_SQL);
      const currentRows: { id: string }[] =
        await manager.query(NEW_STAR_IDS_SQL);
      if (
        !listsEveryIdOnce(
          currentRows.map((row) => row.id),
          spotlightIds,
        )
      ) {
        throw studioError('studio_spotlight_order_mismatch');
      }
      const orderedIds = spotlightIds.map((spotlightId) =>
        spotlightId.toLowerCase(),
      );
      await manager.query(REORDER_NEW_STARS_SQL, [
        orderedIds,
        orderedIds.map((_id, index) => index + 1),
      ]);
    });
    return this.loadSlot('new_stars');
  }

  private async readPlacementState(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<PlacementStateRow | undefined> {
    const [state]: PlacementStateRow[] = await manager.query(
      SPOTLIGHT_PLACEMENT_STATE_SQL,
      [subprofileId],
    );
    return state;
  }

  /** Refuses in a fixed order: not an artist, no release, and for New stars
   *  already placed, then full. */
  private assertPlaceable(
    state: PlacementStateRow | undefined,
    slot: StudioSpotlightSlot,
  ): void {
    if (!state?.is_artist) {
      throw studioError('studio_spotlight_not_an_artist');
    }
    if (!state.has_release) {
      throw studioError('studio_spotlight_no_release');
    }
    if (slot !== 'new_stars') {
      return;
    }
    if (state.is_in_new_stars) {
      throw studioError('studio_spotlight_already_in_slot');
    }
    if (state.new_stars_count >= STUDIO_DISCOVERY_LIMITS.spotlightNewStarsMax) {
      throw studioError('studio_spotlight_slot_full');
    }
  }

  private async insertSpotlight(
    manager: EntityManager,
    slot: StudioSpotlightSlot,
    staffUserId: string,
    body: PlaceAdminStudioSpotlightArtistDto,
  ): Promise<string> {
    const [inserted]: { id: string }[] = await manager.query(
      INSERT_SPOTLIGHT_SQL,
      [slot, body.subprofileId, normalizePickNote(body.note), staffUserId],
    );
    if (!inserted) {
      throw new Error('The spotlight insert returned no row.');
    }
    return inserted.id;
  }

  private async loadSlot(
    slot: StudioSpotlightSlot,
  ): Promise<AdminStudioSpotlightArtist[]> {
    const rows: AdminSpotlightArtistRow[] = await this.dataSource.query(
      ADMIN_SPOTLIGHT_SQL,
      [slot, null],
    );
    return rows.map(toAdminStudioSpotlightArtist);
  }

  private async loadOneOrThrow(
    spotlightId: string,
  ): Promise<AdminStudioSpotlightArtist> {
    const rows: AdminSpotlightArtistRow[] = await this.dataSource.query(
      ADMIN_SPOTLIGHT_SQL,
      [null, spotlightId],
    );
    const [spotlightArtist] = rows.map(toAdminStudioSpotlightArtist);
    if (!spotlightArtist) {
      throw studioError('studio_spotlight_not_found');
    }
    return spotlightArtist;
  }
}

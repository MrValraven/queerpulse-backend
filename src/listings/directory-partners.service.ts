import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import {
  type AdminDirectoryPartnerDTO,
  type AdminDirectoryPartnerSearchResultDTO,
  toAdminDirectoryPartner,
  toAdminDirectoryPartnerSearchResult,
} from './directory-partners-response';
import {
  DIRECTORY_PARTNER_LIMIT,
  DIRECTORY_PARTNER_POSITION_CONSTRAINT,
  DIRECTORY_PARTNER_SEARCH_LIMIT,
  DIRECTORY_PARTNER_SEARCH_QUERY_MAX,
  directoryPartnerError,
} from './directory-partners.constants';
import {
  listsEveryIdOnce,
  normalizePartnerNote,
  partnerPublicStateOf,
} from './directory-partners.rules';
import { DirectoryService } from './directory.service';
import {
  CreateDirectoryPartnerDto,
  UpdateDirectoryPartnerNoteDto,
} from './dto/directory-partners.dto';
import { DirectoryPartnerPick } from './entities/directory-partner-pick.entity';
import { Listing } from './entities/listing.entity';

/** Every partner write takes this first, so writes run one at a time: an
 *  append never collides with another append, and a reorder queued behind a
 *  remove reads the shorter list. Admin only and at most 12 rows. */
export const LOCK_PARTNER_PICKS_SQL =
  'LOCK TABLE "directory_partner_picks" IN SHARE ROW EXCLUSIVE MODE';

/** Lets a reorder rewrite every position in one statement. */
export const DEFER_POSITION_SQL = `SET CONSTRAINTS "${DIRECTORY_PARTNER_POSITION_CONSTRAINT}" DEFERRED`;

/** `$1` the pick ids in the new order, `$2` their positions 1..n. */
export const REORDER_PARTNER_PICKS_SQL = `UPDATE "directory_partner_picks" AS "pick" SET "position" = "ordering"."position"
  FROM unnest($1::uuid[], $2::smallint[]) AS "ordering"("pick_id", "position")
 WHERE "pick"."id" = "ordering"."pick_id"`;

/** `$1` the position of the removed pick. Every later pick moves up one. */
export const CLOSE_POSITION_GAP_SQL = `UPDATE "directory_partner_picks" SET "position" = "position" - 1 WHERE "position" > $1`;

/**
 * Directory partners: the admin side of the hand-picked row at the top of the
 * public directory (Admin only). Modelled on `AdminStudioCurationService`.
 * Every write runs behind one table lock, and every mutation returns the full
 * list, so the client replaces its cache in one step. Each refusal goes
 * through `directoryPartnerError`, and a malformed id answers its reason code
 * before any query runs.
 */
@Injectable()
export class DirectoryPartnersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly directoryService: DirectoryService,
  ) {}

  /** Every pick in position order, each with the reason it does or does not
   *  show in the public row. */
  async listPartners(): Promise<AdminDirectoryPartnerDTO[]> {
    const picks = await this.dataSource.manager.find(DirectoryPartnerPick, {
      relations: { listing: true },
      order: { position: 'ASC' },
    });
    const listingSlugs = picks.flatMap((pick) =>
      pick.listing ? [pick.listing.slug] : [],
    );
    const moderatedSlugs =
      await this.directoryService.moderatedListingSlugs(listingSlugs);
    return picks.flatMap((pick) => {
      const listing = pick.listing;
      if (!listing) {
        return [];
      }
      return [
        toAdminDirectoryPartner(
          pick,
          listing,
          partnerPublicStateOf(listing, moderatedSlugs.has(listing.slug)),
        ),
      ];
    });
  }

  /** The picker search: the public grid's folded-name search, marked with
   *  the listings already picked. A blank query answers an empty list, and a
   *  long one is cut to its first 80 characters. */
  async searchListings(
    query: string | undefined,
  ): Promise<AdminDirectoryPartnerSearchResultDTO[]> {
    const trimmedQuery = (query ?? '').trim();
    if (!trimmedQuery) {
      return [];
    }
    // Cut by code points, so a long query never ends on half a surrogate pair.
    const searchTerm = Array.from(trimmedQuery)
      .slice(0, DIRECTORY_PARTNER_SEARCH_QUERY_MAX)
      .join('');
    const rows = await this.directoryService.searchListedListings(
      searchTerm,
      DIRECTORY_PARTNER_SEARCH_LIMIT,
    );
    const pickedListings = await this.dataSource.manager.find(
      DirectoryPartnerPick,
      { select: { listingId: true } },
    );
    const pickedListingIds = new Set(
      pickedListings.map((pick) => pick.listingId),
    );
    return rows.map((row) =>
      toAdminDirectoryPartnerSearchResult(row, pickedListingIds.has(row.id)),
    );
  }

  /** Appends a listing at the end of the row. Checks run in the contract's
   *  order: note length, listing, already picked, public visibility, limit.
   *  The listing row is read under a share lock, so a staff delete cannot
   *  remove it between the checks and the insert. */
  async addPartner(
    adminUserId: string,
    body: CreateDirectoryPartnerDto,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    const note = normalizePartnerNote(body.note);
    if (!isUUID(body.listingId)) {
      throw directoryPartnerError('listing_not_found');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PARTNER_PICKS_SQL);
      const listing = await manager.findOne(Listing, {
        where: { id: body.listingId },
        select: {
          id: true,
          slug: true,
          status: true,
          operatingState: true,
          isHiddenByOwner: true,
          cats: true,
        },
        lock: { mode: 'pessimistic_read' },
      });
      if (!listing) {
        throw directoryPartnerError('listing_not_found');
      }
      const isAlreadyPartner = await manager.exists(DirectoryPartnerPick, {
        where: { listingId: listing.id },
      });
      if (isAlreadyPartner) {
        throw directoryPartnerError('already_partner');
      }
      const moderatedSlugs = await this.directoryService.moderatedListingSlugs([
        listing.slug,
      ]);
      const publicState = partnerPublicStateOf(
        listing,
        moderatedSlugs.has(listing.slug),
      );
      if (publicState === 'adult_only') {
        throw directoryPartnerError('listing_adult_only');
      }
      if (publicState !== 'showing') {
        throw directoryPartnerError('listing_not_live');
      }
      const partnerCount = await manager.count(DirectoryPartnerPick);
      if (partnerCount >= DIRECTORY_PARTNER_LIMIT) {
        throw directoryPartnerError('partner_limit_reached');
      }
      // A listing delete cascades to its pick and leaves a gap in the
      // positions, so the new pick goes after the highest one. The count
      // only guards the limit.
      const highestPosition =
        (await manager.maximum(DirectoryPartnerPick, 'position')) ?? 0;
      await manager.save(
        manager.create(DirectoryPartnerPick, {
          listingId: listing.id,
          note,
          position: highestPosition + 1,
          createdById: adminUserId,
        }),
      );
    });
    return this.listPartners();
  }

  /** Stores the trimmed note, or null for a blank one. The note length is
   *  checked before the pick exists check, the order POST uses. One update
   *  both writes and finds the pick, so a remove that lands first answers
   *  `partner_not_found`. */
  async updateNote(
    pickId: string,
    body: UpdateDirectoryPartnerNoteDto,
  ): Promise<AdminDirectoryPartnerDTO[]> {
    if (!isUUID(pickId)) {
      throw directoryPartnerError('partner_not_found');
    }
    const note = normalizePartnerNote(body.note);
    const updateResult = await this.dataSource.manager.update(
      DirectoryPartnerPick,
      { id: pickId },
      { note },
    );
    if (updateResult.affected === 0) {
      throw directoryPartnerError('partner_not_found');
    }
    return this.listPartners();
  }

  /** Rewrites every position in one statement. The request names every
   *  current pick id once, so a stale list from another tab, a repeated id
   *  or a malformed id answers `order_mismatch`. */
  async reorderPartners(ids: string[]): Promise<AdminDirectoryPartnerDTO[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PARTNER_PICKS_SQL);
      await manager.query(DEFER_POSITION_SQL);
      const currentPicks = await manager.find(DirectoryPartnerPick, {
        select: { id: true },
      });
      if (
        !listsEveryIdOnce(
          currentPicks.map((pick) => pick.id),
          ids,
        )
      ) {
        throw directoryPartnerError('order_mismatch');
      }
      const orderedPickIds = ids.map((pickId) => pickId.toLowerCase());
      await manager.query(REORDER_PARTNER_PICKS_SQL, [
        orderedPickIds,
        orderedPickIds.map((_pickId, index) => index + 1),
      ]);
    });
    return this.listPartners();
  }

  /** Deletes the pick and moves every later pick up one. */
  async removePartner(pickId: string): Promise<AdminDirectoryPartnerDTO[]> {
    if (!isUUID(pickId)) {
      throw directoryPartnerError('partner_not_found');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.query(LOCK_PARTNER_PICKS_SQL);
      const pick = await manager.findOne(DirectoryPartnerPick, {
        where: { id: pickId },
        select: { id: true, position: true },
      });
      if (!pick) {
        throw directoryPartnerError('partner_not_found');
      }
      await manager.delete(DirectoryPartnerPick, { id: pick.id });
      await manager.query(CLOSE_POSITION_GAP_SQL, [pick.position]);
    });
    return this.listPartners();
  }
}

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { PAGE_SIZE, normalizePage, paginate } from '../common/pagination';
import { runWithConcurrency } from '../common/run-with-concurrency';
import { ListSavedQuery } from './dto/list-saved.query';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { SavedAvailabilityService } from './saved-availability.service';
import {
  SAVED_AFTER_CURSOR_SQL,
  SavedCursor,
  SavedPage,
  decodeSavedCursor,
  encodeSavedCursor,
  savedCursorParameters,
} from './saved-cursor';
import { SavedListsService } from './saved-lists.service';
import { parseSavedRef, toSavedId } from './saved-ref.util';
import { savedStudioCoverUrls } from './saved-studio-covers';
import { SavedUnsaveMemory } from './saved-unsave-memory';
import {
  ResolvedSavedItemDTO,
  toResolvedSavedItemDTOs,
} from './saved-response';

@Injectable()
export class SavedService {
  private readonly logger = new Logger(SavedService.name);
  // Re-liking keeps the original saved time (ten minutes, process memory
  // only, see `SavedUnsaveMemory`).
  private readonly unsaveMemory = new SavedUnsaveMemory();

  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    // Named lists sit on top of the flat set this service owns: a plain save
    // still writes one `saved_item` row and additionally joins the member's
    // default list, so nothing they save can end up outside every list.
    private readonly savedLists: SavedListsService,
    // Answers "is the thing this bookmark points at still there for you?" for
    // a whole page at once (PRD-169).
    private readonly availability: SavedAvailabilityService,
  ) {}

  // Page-number pagination (`{items,total,page,pageSize}`) — matches the
  // frontend's `Paginated<T>` from `shared/api/refs.ts`, which is what
  // `getSaved` in `saved.api.ts` actually imports and unwraps (`res.items`).
  // ENG-04: every page also answers `nextCursor`, and `?cursor=` pages by
  // keyset from there (`page` is then ignored), so a Library walking one
  // kind never skips an item when an earlier one is unsaved.
  async list(userId: string, query: ListSavedQuery): Promise<SavedPage> {
    const page = normalizePage(query.page);
    const qb = this.savedItems
      .createQueryBuilder('saved')
      .where('saved.userId = :userId', { userId })
      .orderBy('saved.createdAt', 'DESC')
      // The id breaks save-time ties, so the keyset order is total.
      .addOrderBy('saved.id', 'DESC');

    if (query.kind) {
      qb.andWhere('saved.subjectType = :kind', { kind: query.kind });
    }

    if (query.listId) {
      // A correlated EXISTS rather than a join, deliberately. `paginate` uses
      // `.skip()/.take()`, and TypeORM answers those on a joined query with its
      // two-pass DISTINCT plan, which is both slower here and the source of the
      // "column distinctAlias.x does not exist" class of failure. The predicate
      // is a membership test, not a source of columns, so it has no business
      // being a join: this stays a plain LIMIT/OFFSET over `saved_item` and the
      // ordering is untouched.
      //
      // Scoped to a list this member owns (checked below), so a guessed list id
      // can only ever return an empty page rather than somebody else's saves.
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM saved_list_entries entry
          JOIN saved_lists list ON list.id = entry.list_id
          WHERE entry.saved_item_id = saved.id
            AND entry.list_id = :listId
            AND list.user_id = :userId
        )`,
        { listId: query.listId },
      );
    }

    // Availability is resolved AFTER the page is fetched, never as a filter on
    // it. An item whose subject has gone still belongs in the member's saved
    // list — they saved it, and they are owed the chance to see what it was and
    // take it out themselves. Dropping those rows would also make `total`
    // disagree with the page and silently shorten every page under an OFFSET,
    // which is the failure `BlockFilterService.excludeHidden` documents.
    const cursor = decodeSavedCursor(query.cursor);
    if (cursor) {
      return this.listAfterCursor(qb, userId, page, cursor);
    }
    // A holder the map fills, since `paginate` hands back mapped items only.
    const pageRowsRead: SavedItem[] = [];
    const result = await paginate(qb, page, (rows) => {
      pageRowsRead.push(...rows);
      return this.resolvePage(rows, userId);
    });
    const lastPageRow: SavedItem | undefined =
      pageRowsRead[pageRowsRead.length - 1];
    const hasMore = page * PAGE_SIZE < result.total;
    return {
      ...result,
      nextCursor:
        hasMore && lastPageRow ? encodeSavedCursor(lastPageRow) : null,
    };
  }

  /** ENG-04: one keyset page after `cursor`, read with one probe row that
   *  only says more exist. `total` still counts the whole filtered set. */
  private async listAfterCursor(
    qb: SelectQueryBuilder<SavedItem>,
    userId: string,
    page: number,
    cursor: SavedCursor,
  ): Promise<SavedPage> {
    const total = await qb.clone().getCount();
    const rows = await qb
      .andWhere(SAVED_AFTER_CURSOR_SQL, savedCursorParameters(cursor))
      .take(PAGE_SIZE + 1)
      .getMany();
    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const lastPageRow = pageRows[pageRows.length - 1];
    return {
      items: await this.resolvePage(pageRows, userId),
      total,
      page,
      pageSize: PAGE_SIZE,
      nextCursor:
        hasMore && lastPageRow ? encodeSavedCursor(lastPageRow) : null,
    };
  }

  private async resolvePage(
    rows: SavedItem[],
    userId: string,
  ): Promise<ResolvedSavedItemDTO[]> {
    const availableRefs = await this.availability.availableRefs(rows, userId);
    // Studio open demo pages: of the rows that did not resolve, the Studio
    // ones staff took down read "withdrawn". No query when none is Studio.
    const withdrawnRefs = await this.availability.withdrawnRefs(
      rows.filter(
        (row) => !availableRefs.has(toSavedId(row.subjectType, row.subjectId)),
      ),
      userId,
    );
    // Studio Library cards: the cover of each available saved release and
    // playlist, in at most two queries. None for a page without one.
    const coverUrlBySavedId = await savedStudioCoverUrls(
      this.savedItems.manager,
      rows,
      availableRefs,
      userId,
    );
    return toResolvedSavedItemDTOs(
      rows,
      availableRefs,
      withdrawnRefs,
      coverUrlBySavedId,
    );
  }

  // Upsert: PUT is idempotent per (user, subject) — re-saving the same
  // subject updates the presentational snapshot rather than erroring on the
  // unique constraint.
  async put(
    userId: string,
    rawId: string,
    body: SavedItemBodyDto,
  ): Promise<void> {
    const { subjectType, subjectId } = parseSavedRef(rawId);
    if (subjectType !== body.kind) {
      throw new BadRequestException(
        'Saved item id kind does not match body.kind',
      );
    }

    const existing = await this.savedItems.findOne({
      where: { userId, subjectType, subjectId },
    });

    const snapshot = {
      title: body.title,
      href: body.href ?? null,
      meta: body.meta ?? null,
      description: body.description ?? null,
      readTime: body.readTime ?? null,
    };

    if (existing) {
      await this.savedItems.update(existing.id, snapshot);
      await this.fileInDefaultListBestEffort(userId, existing.id);
      return;
    }

    // A re-save within ten minutes of the unsave (Undo on the Library toast)
    // takes back the first save time, so the item returns to its old place.
    // TypeORM 0.3 writes an explicit `createdAt` as given: the column's
    // `now()` is only its DEFAULT, used when the value is undefined.
    const originalCreatedAt = this.unsaveMemory.take(
      userId,
      subjectType,
      subjectId,
    );
    try {
      const saved = await this.savedItems.save(
        this.savedItems.create({
          userId,
          subjectType,
          subjectId,
          ...snapshot,
          ...(originalCreatedAt ? { createdAt: originalCreatedAt } : {}),
        }),
      );
      await this.fileInDefaultListBestEffort(userId, saved.id);
    } catch (error) {
      // Idempotent under a race: two concurrent PUTs of the same (user,
      // subject) both miss the `findOne` above and both insert — one loses on
      // `UQ_saved_item_subject`. That IS the "already saved" state this call
      // converges on, so swallow the 23505 instead of surfacing it as a 500.
      // (Mirrors `RoadmapService.castVote`'s unique-violation handling.)
      if (!isUniqueViolation(error, 'UQ_saved_item_subject')) {
        throw error;
      }
      // The winner of that race also files the item in the default list, so
      // there is nothing left for the loser to do.
    }
  }

  async remove(userId: string, rawId: string): Promise<void> {
    const { subjectType, subjectId } = parseSavedRef(rawId);
    // Unsaving drops the item from every list it was in, through
    // `saved_list_entries`' cascade on `saved_item_id`. That is the honest
    // meaning of "I no longer want this saved", and it is why removing
    // something from the DEFAULT list routes here rather than quietly
    // unlinking it (see `SavedListsService.removeItemFromList`).
    const existing = await this.savedItems.findOne({
      where: { userId, subjectType, subjectId },
      select: { id: true, createdAt: true },
    });
    const result = await this.savedItems.delete({
      userId,
      subjectType,
      subjectId,
    });
    if (existing && result.affected) {
      this.unsaveMemory.remember(
        userId,
        subjectType,
        subjectId,
        existing.createdAt,
      );
    }
  }

  /**
   * Studio v3 pre-save: saves one subject for many members at once, with
   * the snapshot the member's own save would have sent. One statement for
   * the whole list; a member who already saved the subject keeps their row
   * exactly as it is (`UQ_saved_item_subject`, `DO NOTHING`). Each new row
   * joins that member's default list, three at a time and best-effort.
   * Answers the members a row was written for.
   */
  async saveForMembersIfMissing(
    userIds: readonly string[],
    subjectType: SavedKind,
    subjectId: string,
    snapshot: { title: string; href: string | null; meta: string | null },
  ): Promise<string[]> {
    if (!userIds.length) {
      return [];
    }
    const insertedRows: { id: string; user_id: string }[] =
      await this.savedItems.query(
        `WITH "inserted" AS (
           INSERT INTO "saved_item" ("user_id", "subject_type", "subject_id", "title", "href", "meta")
           SELECT DISTINCT "member"."user_id", $2::"saved_item_subject_type_enum", $3, $4, $5, $6
             FROM unnest($1::uuid[]) AS "member"("user_id")
           ON CONFLICT ON CONSTRAINT "UQ_saved_item_subject" DO NOTHING
           RETURNING "id", "user_id"
         )
         SELECT "id", "user_id"::text AS "user_id" FROM "inserted"`,
        [
          [...userIds],
          subjectType,
          subjectId,
          snapshot.title,
          snapshot.href,
          snapshot.meta,
        ],
      );
    await runWithConcurrency(
      insertedRows.map(
        (row) => () => this.fileInDefaultListBestEffort(row.user_id, row.id),
      ),
      3,
    );
    return insertedRows.map((row) => row.user_id);
  }

  /**
   * Join the member's default list, so a plain save is still in a list.
   *
   * Best-effort and never rethrown: the item is already saved and already
   * returned by `GET /me/saved` (which reads `saved_item` directly, not the
   * lists), so the worst case is one default-list count being short by one
   * until the next save. Failing the member's save over the bookkeeping half
   * would be the wrong trade.
   */
  private async fileInDefaultListBestEffort(
    userId: string,
    savedItemId: string,
  ): Promise<void> {
    try {
      await this.savedLists.ensureDefaultMembership(userId, savedItemId);
    } catch (error) {
      this.logger.warn(
        `Saved item ${savedItemId} stored but not filed in the default list: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

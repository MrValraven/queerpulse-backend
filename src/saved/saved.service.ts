import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { ListSavedQuery } from './dto/list-saved.query';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedItem } from './entities/saved-item.entity';
import { SavedListsService } from './saved-lists.service';
import { parseSavedRef } from './saved-ref.util';
import { SavedItemDTO, toSavedItemDTO } from './saved-response';

@Injectable()
export class SavedService {
  private readonly logger = new Logger(SavedService.name);

  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    // Named lists sit on top of the flat set this service owns: a plain save
    // still writes one `saved_item` row and additionally joins the member's
    // default list, so nothing they save can end up outside every list.
    private readonly savedLists: SavedListsService,
  ) {}

  // Page-number pagination (`{items,total,page,pageSize}`) — matches the
  // frontend's `Paginated<T>` from `shared/api/refs.ts`, which is what
  // `getSaved` in `saved.api.ts` actually imports and unwraps (`res.items`).
  async list(
    userId: string,
    query: ListSavedQuery,
  ): Promise<Paginated<SavedItemDTO>> {
    const page = normalizePage(query.page);
    const qb = this.savedItems
      .createQueryBuilder('saved')
      .where('saved.userId = :userId', { userId })
      .orderBy('saved.createdAt', 'DESC');

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

    return paginate(qb, page, (rows) => rows.map(toSavedItemDTO));
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

    try {
      const saved = await this.savedItems.save(
        this.savedItems.create({
          userId,
          subjectType,
          subjectId,
          ...snapshot,
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
    await this.savedItems.delete({ userId, subjectType, subjectId });
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

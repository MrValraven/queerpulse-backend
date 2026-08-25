import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedListBodyDto } from './dto/saved-list-body.dto';
import { SavedListEntry } from './entities/saved-list-entry.entity';
import { SavedList } from './entities/saved-list.entity';
import { SavedItem } from './entities/saved-item.entity';
import { parseSavedRef } from './saved-ref.util';
import {
  SavedListDTO,
  SharedSavedListDTO,
  toSavedListDTO,
} from './saved-list-response';
import { toSavedItemDTO } from './saved-response';

/** Bytes of entropy behind a share link, hex-encoded to 64 characters —
 *  identical to `CalendarFeedTokenService`, for identical reasons. */
const SHARE_TOKEN_BYTES = 32;

/** Same strict shape the token is minted in, so a malformed `:token` is
 *  rejected before it ever reaches Postgres as a value to compare. */
const SHARE_TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Named saved lists.
 *
 * Saving was one flat set. This turns it into collections without breaking the
 * flat set: every member gets a DEFAULT list holding everything they have
 * saved, and every other list is a curated subset drawn from the same items.
 * `SavedService` still owns the items themselves; this service owns the lists
 * and their membership, and the two meet at `ensureDefaultMembership`, which
 * `SavedService.put` calls so a plain save always lands somewhere.
 *
 * MULTI-MEMBERSHIP IS THE POINT. See `SavedListEntry`'s docstring for why an
 * item belongs to as many lists as the member files it under rather than
 * exactly one.
 *
 * SHARING IS OFF UNTIL ASKED FOR, revocable, and anonymous to the recipient.
 * See `SavedList`'s docstring for the reasoning, and `SharedSavedListDTO` for
 * exactly what a link discloses.
 */
@Injectable()
export class SavedListsService {
  /** A ceiling, not a product opinion. Somebody with thirty lists is curating;
   *  somebody with three thousand is a script. */
  private static readonly MAX_LISTS_PER_MEMBER = 30;

  /** The name the backfill used and the name a member's first list is created
   *  with. Kept in step with the migration on purpose. */
  private static readonly DEFAULT_LIST_NAME = 'Saved';

  constructor(
    @InjectRepository(SavedList)
    private readonly lists: Repository<SavedList>,
    @InjectRepository(SavedListEntry)
    private readonly entries: Repository<SavedListEntry>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    private readonly dataSource: DataSource,
  ) {}

  /** Every list the caller owns, default first and then newest, each with a
   *  live item count. Two queries regardless of how many lists there are: the
   *  lists, then ONE grouped count over their entries. Never N+1. */
  async listLists(userId: string): Promise<SavedListDTO[]> {
    const rows = await this.lists.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!rows.length) return [];
    const counts = await this.countsByList(rows.map((row) => row.id));
    return rows.map((row) => toSavedListDTO(row, counts.get(row.id) ?? 0));
  }

  async createList(
    userId: string,
    dto: SavedListBodyDto,
  ): Promise<SavedListDTO> {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Give the list a name');
    }
    const existingCount = await this.lists.count({ where: { userId } });
    if (existingCount >= SavedListsService.MAX_LISTS_PER_MEMBER) {
      throw new ConflictException(
        `You can keep up to ${SavedListsService.MAX_LISTS_PER_MEMBER} lists.`,
      );
    }
    try {
      const saved = await this.lists.save(
        this.lists.create({ userId, name, isDefault: false }),
      );
      return toSavedListDTO(saved, 0);
    } catch (error) {
      // `UQ_saved_lists_user_name` — the member already has a list by this
      // name. A 409 rather than silently returning the existing one: they
      // pressed "create" and deserve to be told it is already there.
      if (isUniqueViolation(error, 'UQ_saved_lists_user_name')) {
        throw new ConflictException('You already have a list with that name.');
      }
      throw error;
    }
  }

  /** Rename a list. The default list can be renamed like any other: it is the
   *  member's own shelf and "Saved" is only the name it was born with. What it
   *  cannot lose is its ROLE, which lives in `is_default` and is never editable
   *  through this API. */
  async renameList(
    userId: string,
    listId: string,
    dto: SavedListBodyDto,
  ): Promise<SavedListDTO> {
    const list = await this.loadOwnedOr404(userId, listId);
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Give the list a name');
    }
    list.name = name;
    try {
      const saved = await this.lists.save(list);
      const counts = await this.countsByList([saved.id]);
      return toSavedListDTO(saved, counts.get(saved.id) ?? 0);
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_saved_lists_user_name')) {
        throw new ConflictException('You already have a list with that name.');
      }
      throw error;
    }
  }

  /**
   * Delete a list. The ITEMS SURVIVE: only the memberships go (the entry FK
   * cascades from the list), so deleting "first date" never unsaves the bar. A
   * member deleting a shelf is tidying, not throwing things away, and the
   * default list still holds everything.
   *
   * The default list itself cannot be deleted — it is the flat saved set under
   * another name, and deleting it would leave newly saved items belonging to no
   * list at all.
   */
  async deleteList(userId: string, listId: string): Promise<void> {
    const list = await this.loadOwnedOr404(userId, listId);
    if (list.isDefault) {
      throw new BadRequestException(
        'This list holds everything you have saved and cannot be deleted.',
      );
    }
    await this.lists.delete({ id: list.id, userId });
  }

  /**
   * Save an item (upserting its presentational snapshot, exactly as
   * `PUT /me/saved/:id` does) AND file it in this list, in one call.
   *
   * One call rather than two because "add to list" is one action in the member's
   * head, and because the two halves must not be able to half-happen: a client
   * that saved the item and then failed to link it would leave the member
   * looking at a list they just added something to that does not contain it.
   * Both writes plus the default-list membership run in one transaction.
   */
  async addItemToList(
    userId: string,
    listId: string,
    rawId: string,
    body: SavedItemBodyDto,
  ): Promise<void> {
    const { subjectType, subjectId } = parseSavedRef(rawId);
    if (subjectType !== body.kind) {
      throw new BadRequestException(
        'Saved item id kind does not match body.kind',
      );
    }
    const list = await this.loadOwnedOr404(userId, listId);

    await this.dataSource.transaction(async (manager) => {
      const savedItem = await this.upsertSavedItem(manager, userId, {
        subjectType,
        subjectId,
        title: body.title,
        href: body.href ?? null,
        meta: body.meta ?? null,
        description: body.description ?? null,
        readTime: body.readTime ?? null,
      });
      // Filing something under "open late" also means it is saved, so it joins
      // the default list too. Without this, an item added straight to a named
      // list would be missing from `GET /me/saved`.
      const defaultList = await this.ensureDefaultListIn(manager, userId);
      await this.linkIn(manager, defaultList.id, savedItem.id);
      if (list.id !== defaultList.id) {
        await this.linkIn(manager, list.id, savedItem.id);
      }
    });
  }

  /**
   * Take an item OUT of one list without unsaving it. Idempotent: removing
   * something that was not in the list is the state the caller asked for.
   *
   * Refused on the default list. That list is the flat saved set, so "remove it
   * from Saved" is really "unsave it", and `DELETE /me/saved/:id` is the route
   * that does that honestly (and drops it from every other list on the way).
   * Silently doing the stronger thing here would delete curation the member did
   * not ask to lose.
   */
  async removeItemFromList(
    userId: string,
    listId: string,
    rawId: string,
  ): Promise<void> {
    const { subjectType, subjectId } = parseSavedRef(rawId);
    const list = await this.loadOwnedOr404(userId, listId);
    if (list.isDefault) {
      throw new BadRequestException(
        'To take something out of this list, unsave it.',
      );
    }
    const savedItem = await this.savedItems.findOne({
      where: { userId, subjectType, subjectId },
    });
    if (!savedItem) return;
    await this.entries.delete({ listId: list.id, savedItemId: savedItem.id });
  }

  /**
   * Mint (or return) this list's share link. Idempotent on purpose: pressing
   * "share" twice must not rotate the token and silently break a link the
   * member already sent to somebody.
   */
  async share(userId: string, listId: string): Promise<SavedListDTO> {
    const list = await this.loadOwnedOr404(userId, listId);
    if (!list.shareToken) {
      list.shareToken = randomBytes(SHARE_TOKEN_BYTES).toString('hex');
      list.sharedAt = new Date();
      await this.lists.save(list);
    }
    const counts = await this.countsByList([list.id]);
    return toSavedListDTO(list, counts.get(list.id) ?? 0);
  }

  /**
   * Revoke the share link. Every copy of the URL anyone holds stops working
   * immediately, which is the entire reason the token is a stored random secret
   * rather than something derived from the list's id. Idempotent.
   */
  async unshare(userId: string, listId: string): Promise<SavedListDTO> {
    const list = await this.loadOwnedOr404(userId, listId);
    if (list.shareToken) {
      list.shareToken = null;
      list.sharedAt = null;
      await this.lists.save(list);
    }
    const counts = await this.countsByList([list.id]);
    return toSavedListDTO(list, counts.get(list.id) ?? 0);
  }

  /**
   * The unauthenticated read behind a share link. 404s a malformed or revoked
   * token with the same message it uses for a token that never existed, so the
   * endpoint cannot be used to tell "this list was un-shared" apart from "this
   * link was never real".
   *
   * Returns the list's name and its items and nothing about its owner — see
   * `SharedSavedListDTO`.
   */
  async getShared(token: string): Promise<SharedSavedListDTO> {
    if (!SHARE_TOKEN_RE.test(token)) {
      throw new NotFoundException('This list is not available');
    }
    const list = await this.lists.findOne({ where: { shareToken: token } });
    if (!list) {
      throw new NotFoundException('This list is not available');
    }
    // Bounded like every other whole-array read in this codebase. A shared list
    // is a handful of places, and this is a public route.
    const entries = await this.entries.find({
      where: { listId: list.id },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (!entries.length) {
      return { name: list.name, itemCount: 0, items: [] };
    }
    const items = await this.savedItems.find({
      where: { id: In(entries.map((entry) => entry.savedItemId)) },
      order: { createdAt: 'DESC' },
    });
    return {
      name: list.name,
      itemCount: items.length,
      items: items.map(toSavedItemDTO),
    };
  }

  /**
   * Put an already-saved item in the caller's default list, creating that list
   * on first use. Called by `SavedService.put` so the plain flat save keeps
   * working exactly as it did while never leaving an item outside every list.
   *
   * Best-effort by contract at the call site: the item is already saved by the
   * time this runs, so a failure here must not turn a successful save into an
   * error for the member.
   */
  async ensureDefaultMembership(
    userId: string,
    savedItemId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const defaultList = await this.ensureDefaultListIn(manager, userId);
      await this.linkIn(manager, defaultList.id, savedItemId);
    });
  }

  /** The caller's default list id, or null when they have never saved anything.
   *  Backs `GET /me/saved?listId=` resolving the word "default". */
  async findDefaultListId(userId: string): Promise<string | null> {
    const list = await this.lists.findOne({
      where: { userId, isDefault: true },
      select: { id: true },
    });
    return list?.id ?? null;
  }

  /** 404s rather than 403s a list belonging to somebody else: whether a given
   *  list id exists is not something a stranger gets to learn. */
  private async loadOwnedOr404(
    userId: string,
    listId: string,
  ): Promise<SavedList> {
    const list = await this.lists.findOne({ where: { id: listId, userId } });
    if (!list) {
      throw new NotFoundException('List not found');
    }
    return list;
  }

  /** ONE grouped COUNT over every list passed in, never one query per list. */
  private async countsByList(listIds: string[]): Promise<Map<string, number>> {
    if (!listIds.length) return new Map();
    const rows = await this.entries
      .createQueryBuilder('entry')
      .select('entry.list_id', 'listId')
      .addSelect('COUNT(*)', 'count')
      .where('entry.list_id IN (:...listIds)', { listIds })
      .groupBy('entry.list_id')
      .getRawMany<{ listId: string; count: string }>();
    return new Map(rows.map((row) => [row.listId, Number(row.count)]));
  }

  /**
   * The member's default list, created on first use.
   *
   * The insert can lose a race against a concurrent first save from another
   * tab; `UQ_saved_lists_user_default` is what actually decides the winner, and
   * the loser re-reads rather than surfacing a 500. Same converge-on-the-winner
   * shape `SavedService.put` and `ReportsService.create` already use.
   *
   * It also has to cope with a member who already made a list of their own
   * called "Saved": that name is taken, so the insert would fail on
   * `UQ_saved_lists_user_name` and leave them permanently without a default.
   * Their list is promoted instead, which is the right answer anyway.
   */
  private async ensureDefaultListIn(
    manager: EntityManager,
    userId: string,
  ): Promise<SavedList> {
    const listsRepo = manager.getRepository(SavedList);
    const existing = await listsRepo.findOne({
      where: { userId, isDefault: true },
    });
    if (existing) return existing;
    // A member can have made a list called "Saved" by hand before they ever
    // saved anything. Promote it instead of colliding with it on
    // `UQ_saved_lists_user_name`, which would otherwise leave them with no
    // default list at all and fail every subsequent save's bookkeeping.
    const sameName = await listsRepo.findOne({
      where: { userId, name: SavedListsService.DEFAULT_LIST_NAME },
    });
    if (sameName) {
      sameName.isDefault = true;
      try {
        return await listsRepo.save(sameName);
      } catch (error) {
        if (isUniqueViolation(error, 'UQ_saved_lists_user_default')) {
          const winner = await listsRepo.findOne({
            where: { userId, isDefault: true },
          });
          if (winner) return winner;
        }
        throw error;
      }
    }
    try {
      return await listsRepo.save(
        listsRepo.create({
          userId,
          name: SavedListsService.DEFAULT_LIST_NAME,
          isDefault: true,
        }),
      );
    } catch (error) {
      if (
        isUniqueViolation(error, 'UQ_saved_lists_user_default') ||
        isUniqueViolation(error, 'UQ_saved_lists_user_name')
      ) {
        const winner = await listsRepo.findOne({
          where: { userId, isDefault: true },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  /** Idempotent membership insert. A repeat add is the state the caller wants,
   *  so `UQ_saved_list_entries_pair` losing is a success, not an error. */
  private async linkIn(
    manager: EntityManager,
    listId: string,
    savedItemId: string,
  ): Promise<void> {
    const entriesRepo = manager.getRepository(SavedListEntry);
    try {
      await entriesRepo.save(entriesRepo.create({ listId, savedItemId }));
    } catch (error) {
      if (!isUniqueViolation(error, 'UQ_saved_list_entries_pair')) {
        throw error;
      }
    }
  }

  /** The same upsert `SavedService.put` performs, run inside a caller-supplied
   *  transaction so "save it and file it" is one atomic act. */
  private async upsertSavedItem(
    manager: EntityManager,
    userId: string,
    fields: Pick<
      SavedItem,
      | 'subjectType'
      | 'subjectId'
      | 'title'
      | 'href'
      | 'meta'
      | 'description'
      | 'readTime'
    >,
  ): Promise<SavedItem> {
    const itemsRepo = manager.getRepository(SavedItem);
    const existing = await itemsRepo.findOne({
      where: {
        userId,
        subjectType: fields.subjectType,
        subjectId: fields.subjectId,
      },
    });
    if (existing) {
      existing.title = fields.title;
      existing.href = fields.href;
      existing.meta = fields.meta;
      existing.description = fields.description;
      existing.readTime = fields.readTime;
      return itemsRepo.save(existing);
    }
    try {
      return await itemsRepo.save(itemsRepo.create({ userId, ...fields }));
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_saved_item_subject')) {
        const winner = await itemsRepo.findOne({
          where: {
            userId,
            subjectType: fields.subjectType,
            subjectId: fields.subjectId,
          },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }
}

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { parseSavedRef, toSavedId } from '../saved/saved-ref.util';
import { SavedItemDTO, toSavedItemDTO } from '../saved/saved-response';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import {
  CollectionDTO,
  CollectionDetailDTO,
  toCollectionDTO,
  toCollectionDetailDTO,
} from './collections-response';
import { CollectionItem } from './entities/collection-item.entity';
import { Collection } from './entities/collection.entity';

/**
 * Per-collection item ceiling (CNT-19). Sized well above any real folder and
 * above `DEFAULT_LIST_LIMIT`, which is what `getOne` will actually hydrate —
 * this exists so `collection_item` cannot grow without bound, not to police
 * how members organise their saves.
 */
const MAX_ITEMS_PER_COLLECTION = 500;

/**
 * DEPRECATED (SOC-12). Superseded by `SavedListsService`.
 *
 * Kept live only so clients that have not reloaded since the collections UI
 * moved to `/me/saved/lists` keep working. See `CollectionsController`'s
 * docstring for the retirement path. The data is already copied across by
 * `1794740000000-BackfillCollectionsIntoSavedLists`.
 *
 * @deprecated Use `SavedListsService` instead.
 */
@Injectable()
export class CollectionsService {
  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
    @InjectRepository(CollectionItem)
    private readonly collectionItems: Repository<CollectionItem>,
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
  ) {}

  /**
   * The member's collections, newest-updated first, each with its live item
   * count. Bounded by `DEFAULT_LIST_LIMIT` (a member's folder list is tiny; this
   * is only a safety cap, not real pagination) and returned as a bare array —
   * the frontend renders the whole grid at once.
   */
  async list(ownerId: string): Promise<CollectionDTO[]> {
    const rows = await this.collections.find({
      where: { ownerId },
      order: { updatedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    if (rows.length === 0) return [];

    const counts = await this.countItemsByCollection(rows.map((row) => row.id));
    return rows.map((row) => toCollectionDTO(row, counts.get(row.id) ?? 0));
  }

  async create(
    ownerId: string,
    body: CreateCollectionDto,
  ): Promise<CollectionDTO> {
    const saved = await this.collections.save(
      this.collections.create({
        ownerId,
        name: body.name,
        emoji: body.emoji ?? null,
        cover: body.cover ?? null,
      }),
    );
    return toCollectionDTO(saved, 0);
  }

  async rename(
    ownerId: string,
    id: string,
    body: UpdateCollectionDto,
  ): Promise<CollectionDTO> {
    const collection = await this.mustOwn(ownerId, id);
    if (body.name !== undefined) collection.name = body.name;
    if (body.emoji !== undefined) collection.emoji = body.emoji ?? null;
    if (body.cover !== undefined) collection.cover = body.cover ?? null;
    const saved = await this.collections.save(collection);
    const itemCount = await this.collectionItems.count({
      where: { collectionId: id },
    });
    return toCollectionDTO(saved, itemCount);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    // Owner-scoped delete; the `collection_item` rows cascade at the DB level.
    const result = await this.collections.delete({ id, ownerId });
    if (!result.affected) {
      throw new NotFoundException('Collection not found');
    }
  }

  /** One collection with its items hydrated from the owner's saved snapshots. */
  async getOne(ownerId: string, id: string): Promise<CollectionDetailDTO> {
    const collection = await this.mustOwn(ownerId, id);
    const items = await this.collectionItems.find({
      where: { collectionId: id },
      order: { createdAt: 'DESC' },
      // Bounded like `list()` — a collection can't render an unbounded item set.
      take: DEFAULT_LIST_LIMIT,
    });
    return toCollectionDetailDTO(
      collection,
      await this.hydrateItems(ownerId, items),
    );
  }

  /**
   * Files a saved subject into the collection. Idempotent: re-adding the same
   * subject is a no-op (converges on the unique constraint) rather than a 409.
   * Touches the collection's `updatedAt` so the list re-sorts to the top.
   *
   * Refuses once the collection is full (CNT-19). `collection_item` had no
   * per-collection ceiling at all, so one member could grow a single folder
   * without bound while `getOne` hydrates every row it returns. The cap makes
   * the ceiling explicit and says so to the member, rather than accepting rows
   * nothing will ever show. (Separately, `getOne` still only returns the first
   * `DEFAULT_LIST_LIMIT` items — paginating a single collection's contents is
   * its own change, not this one.)
   */
  async addItem(ownerId: string, id: string, ref: string): Promise<void> {
    await this.mustOwn(ownerId, id);
    const { subjectType, subjectId } = parseSavedRef(ref);

    // Counted before the insert, and only for a subject not already filed, so
    // re-adding an existing item at the cap stays the documented no-op rather
    // than turning into a 409.
    const isAlreadyFiled = await this.collectionItems.exists({
      where: { collectionId: id, subjectKind: subjectType, subjectId },
    });
    if (!isAlreadyFiled) {
      const itemCount = await this.collectionItems.count({
        where: { collectionId: id },
      });
      if (itemCount >= MAX_ITEMS_PER_COLLECTION) {
        throw new ConflictException(
          `A collection holds at most ${MAX_ITEMS_PER_COLLECTION} items. Remove something first, or start another collection.`,
        );
      }
    }

    try {
      await this.collectionItems.save(
        this.collectionItems.create({
          collectionId: id,
          subjectKind: subjectType,
          subjectId,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'UQ_collection_item_subject')) throw error;
      return; // Already filed — nothing to touch.
    }
    await this.touch(id);
  }

  async removeItem(ownerId: string, id: string, ref: string): Promise<void> {
    await this.mustOwn(ownerId, id);
    const { subjectType, subjectId } = parseSavedRef(ref);
    const result = await this.collectionItems.delete({
      collectionId: id,
      subjectKind: subjectType,
      subjectId,
    });
    if (result.affected) await this.touch(id);
  }

  /** Loads a collection the caller owns, or 404s. */
  private async mustOwn(ownerId: string, id: string): Promise<Collection> {
    const collection = await this.collections.findOne({
      where: { id, ownerId },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private async touch(id: string): Promise<void> {
    await this.collections.update(id, { updatedAt: new Date() });
  }

  /**
   * Every saved-item ref filed in any of the owner's collections, across the
   * whole collection set — lets the frontend tell "recently saved" apart from
   * "already filed somewhere" without fetching each collection's items.
   */
  async listFiledRefs(ownerId: string): Promise<string[]> {
    const rows = await this.collectionItems
      .createQueryBuilder('item')
      .innerJoin(Collection, 'collection', 'collection.id = item.collectionId')
      .where('collection.ownerId = :ownerId', { ownerId })
      .select('item.subjectKind', 'subjectKind')
      .addSelect('item.subjectId', 'subjectId')
      .distinct(true)
      .getRawMany<{ subjectKind: string; subjectId: string }>();
    return rows.map((row) => `${row.subjectKind}:${row.subjectId}`);
  }

  /** collectionId -> item count, one grouped query for the whole list. */
  private async countItemsByCollection(
    collectionIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await this.collectionItems
      .createQueryBuilder('item')
      .select('item.collectionId', 'collectionId')
      .addSelect('COUNT(*)', 'count')
      .where('item.collectionId IN (:...collectionIds)', { collectionIds })
      .groupBy('item.collectionId')
      .getRawMany<{ collectionId: string; count: string }>();
    return new Map(rows.map((row) => [row.collectionId, Number(row.count)]));
  }

  /**
   * Turns join rows into `SavedItemDTO`s by matching each `(subjectKind,
   * subjectId)` against the owner's `saved_item` snapshot (one `IN` query, no
   * N+1). An item whose underlying save was since removed still renders — with a
   * minimal fallback DTO keyed off the reference — so a collection never
   * silently loses rows.
   */
  private async hydrateItems(
    ownerId: string,
    items: CollectionItem[],
  ): Promise<SavedItemDTO[]> {
    if (items.length === 0) return [];

    const saved = await this.savedItems.find({
      where: {
        userId: ownerId,
        subjectId: In([...new Set(items.map((item) => item.subjectId))]),
      },
    });
    const snapshotByRef = new Map(
      saved.map((row) => [toSavedId(row.subjectType, row.subjectId), row]),
    );

    return items.map((item) => {
      const ref = `${item.subjectKind}:${item.subjectId}`;
      const snapshot = snapshotByRef.get(ref);
      if (snapshot) return toSavedItemDTO(snapshot);
      // Save was removed after filing: keep the row visible with a bare title.
      return {
        id: ref,
        kind: item.subjectKind as SavedItemDTO['kind'],
        title: item.subjectId,
        savedAt: item.createdAt.toISOString(),
      };
    });
  }
}

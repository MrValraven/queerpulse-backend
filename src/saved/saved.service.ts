import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Paginated, normalizePage, paginate } from '../common/pagination';
import { ListSavedQuery } from './dto/list-saved.query';
import { SavedItemBodyDto } from './dto/saved-item-body.dto';
import { SavedItem } from './entities/saved-item.entity';
import { parseSavedRef } from './saved-ref.util';
import { SavedItemDTO, toSavedItemDTO } from './saved-response';

@Injectable()
export class SavedService {
  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
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
      return;
    }

    await this.savedItems.save(
      this.savedItems.create({
        userId,
        subjectType,
        subjectId,
        ...snapshot,
      }),
    );
  }

  async remove(userId: string, rawId: string): Promise<void> {
    const { subjectType, subjectId } = parseSavedRef(rawId);
    await this.savedItems.delete({ userId, subjectType, subjectId });
  }
}

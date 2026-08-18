import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { HiddenFromMember } from './entities/hidden-from.entity';

/**
 * "Hide my profile from one person" (member profile v2 Task 5) — a new,
 * distinct capability from `BlockFilterService`'s block/mute: one-way,
 * silent (no notification), and narrower in effect. It only controls
 * whether `ownerId`'s profile can be *found* — directory search
 * (`excludeHiddenFrom`, wired into `ProfilesService.searchMembers`) and a
 * direct profile URL (`isHiddenFrom`, wired into `ProfilesService.getBySlug`
 * next to its `isBlockedEitherWay` gate) — not messaging, feeds, or
 * connections, which are untouched.
 *
 * Modeled directly on `BlockFilterService`'s idioms: `excludeHiddenFrom`
 * mirrors `excludeBlocked`'s exact `NOT EXISTS` / raw-SQL-splicing /
 * single-bound-parameter shape, and `hide`'s idempotent insert mirrors
 * `SocialService.blockMember`/`muteMember`'s `insert().orIgnore()`.
 */
@Injectable()
export class HiddenFromService {
  constructor(
    @InjectRepository(HiddenFromMember)
    private readonly hiddenFromRepo: Repository<HiddenFromMember>,
  ) {}

  /**
   * Idempotent: hiding from an already-hidden-from member leaves the
   * existing row untouched (same idempotent-POST idiom as
   * `SocialService.blockMember`/`muteMember`).
   */
  async hide(ownerId: string, hiddenFromUserId: string): Promise<void> {
    if (ownerId === hiddenFromUserId) {
      throw new BadRequestException(
        'You cannot hide your profile from yourself',
      );
    }
    await this.hiddenFromRepo
      .createQueryBuilder()
      .insert()
      .into(HiddenFromMember)
      .values({ ownerId, hiddenFromUserId })
      .orIgnore()
      .execute();
  }

  /** Mirrors `unblockMember`/`unmuteMember`: 404s when there was no
   * hidden-from row to remove (never hidden, or already unhidden). */
  async unhide(ownerId: string, hiddenFromUserId: string): Promise<void> {
    const result = await this.hiddenFromRepo.delete({
      ownerId,
      hiddenFromUserId,
    });
    if (!result.affected) {
      throw new NotFoundException('Not currently hidden from that member');
    }
  }

  /** Every member `ownerId` currently hides their profile from, newest first. */
  async list(ownerId: string): Promise<HiddenFromMember[]> {
    return this.hiddenFromRepo.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Directional: `true` when `ownerId` has hidden their own profile from
   * `viewerId`. Never true for `ownerId === viewerId` (the `hide` write path
   * rejects self-targeting, so no row can exist, but this still short-circuits
   * explicitly — mirrors `isBlockedEitherWay`/`isMutedBy`'s same guard).
   */
  async isHiddenFrom(ownerId: string, viewerId: string): Promise<boolean> {
    if (ownerId === viewerId) return false;
    return this.hiddenFromRepo.exist({
      where: { ownerId, hiddenFromUserId: viewerId },
    });
  }

  /**
   * Appends a `NOT EXISTS` predicate to `qb` that drops rows whose subject
   * (profile-owner) column has hidden themself from `viewerUserId` —
   * i.e. excludes a row when THAT row's owner placed the hide, never the
   * reverse. `subjectIdColumn` is spliced verbatim into raw SQL, so pass an
   * actual, already-quoted `"alias"."snake_case_column"` reference matching
   * `qb`'s alias and the DB's `SnakeNamingStrategy` column name (e.g.
   * `'"p"."user_id"'`), not a TypeORM camelCase property path — same
   * contract as `BlockFilterService.excludeBlocked`. Call once per query
   * builder — the bound parameter name (`hiddenFromFilterViewerId`) is
   * fixed, and distinct from `excludeBlocked`'s `blockFilterActorId` so both
   * can be chained on the same query builder (as `searchMembers` does).
   */
  excludeHiddenFrom<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    viewerUserId: string,
    subjectIdColumn: string,
  ): SelectQueryBuilder<E> {
    return qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "hidden_from_members" "__hidden_from_filter"
        WHERE "__hidden_from_filter"."owner_id" = ${subjectIdColumn}
          AND "__hidden_from_filter"."hidden_from_user_id" = :hiddenFromFilterViewerId
      )`,
      { hiddenFromFilterViewerId: viewerUserId },
    );
  }
}

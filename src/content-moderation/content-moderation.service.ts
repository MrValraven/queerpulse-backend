import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  In,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { ContentModeration } from './entities/content-moderation.entity';

/** The resolved moderation state of one subject, as read paths consume it. */
export interface ContentModerationState {
  hidden: boolean;
  removed: boolean;
}

const VISIBLE: ContentModerationState = { hidden: false, removed: false };

// The two moderator actions this table records. `hide_content` withholds;
// `remove_content` tombstones. Kept as a local union rather than importing the
// moderation module's `ModActionCode` so the dependency arrow points one way
// (moderation -> content-moderation), never back.
export type ContentModerationAction = 'hide_content' | 'remove_content';

export interface ApplyContentModerationInput {
  subjectType: string;
  subjectId: string;
  action: ContentModerationAction;
  actorId: string;
  reportId?: string | null;
  reasonCode?: string | null;
  note?: string | null;
}

/**
 * Owns the shared `content_moderation` state: the moderation service writes to
 * it when a `hide_content`/`remove_content` action lands, and every content
 * read path that respects a takedown reads from it.
 *
 * Writes take the caller's {@link EntityManager} so they enlist in the
 * moderation service's existing action transaction — the report status, the
 * audit log row, and this state row all commit together or not at all, which is
 * the whole point of the fix (an action that records an audit entry but leaves
 * the content live is exactly the bug being closed).
 */
@Injectable()
export class ContentModerationService {
  constructor(
    @InjectRepository(ContentModeration)
    private readonly states: Repository<ContentModeration>,
  ) {}

  /**
   * Records a takedown for `(subjectType, subjectId)`, upserting on the unique
   * subject key so re-applying an action (or a queue + bulk hitting the same
   * subject) is idempotent rather than a duplicate-key crash.
   *
   * `remove_content` implies hidden too: a tombstoned item is never also shown,
   * so we stamp `hidden_at` alongside `removed_at`. `hide_content` leaves
   * `removed_at` untouched — hiding something already removed must not silently
   * downgrade the tombstone back to a mere hide.
   */
  async applyAction(
    manager: EntityManager,
    input: ApplyContentModerationInput,
  ): Promise<void> {
    const now = new Date();
    const isRemove = input.action === 'remove_content';

    await manager
      .createQueryBuilder()
      .insert()
      .into(ContentModeration)
      .values({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        hiddenAt: now,
        removedAt: isRemove ? now : null,
        moderatedBy: input.actorId,
        reportId: input.reportId ?? null,
        reasonCode: input.reasonCode ?? null,
        note: input.note ?? null,
      })
      .orUpdate(
        // On conflict, always (re)assert hidden + the actor/report/reason
        // metadata; only escalate to removed when this action is a removal.
        isRemove
          ? [
              'hidden_at',
              'removed_at',
              'moderated_by',
              'report_id',
              'reason_code',
              'note',
              'updated_at',
            ]
          : [
              'hidden_at',
              'moderated_by',
              'report_id',
              'reason_code',
              'note',
              'updated_at',
            ],
        ['subject_type', 'subject_id'],
      )
      .execute();
  }

  /**
   * Lifts any takedown on `(subjectType, subjectId)`.
   *
   * Provided for the appeal/overturn path (owned by another agent) and admin
   * reversal — deleting the state row restores the content to fully visible.
   * Not wired from this module beyond being available; kept here so reversal
   * lives with the state it reverses.
   */
  async revert(
    manager: EntityManager,
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    await manager.delete(ContentModeration, { subjectType, subjectId });
  }

  /** The state of a single subject, or a fully-visible default when untouched. */
  async stateFor(
    subjectType: string,
    subjectId: string,
  ): Promise<ContentModerationState> {
    const row = await this.states.findOne({
      where: { subjectType, subjectId },
    });
    return row ? toState(row) : VISIBLE;
  }

  /**
   * States for a whole page of one subject type, keyed by `subjectId`. Subjects
   * with no row are simply absent from the map (callers treat absence as
   * {@link VISIBLE}). One `IN(...)` query regardless of page size.
   */
  async statesFor(
    subjectType: string,
    subjectIds: readonly string[],
  ): Promise<Map<string, ContentModerationState>> {
    return this.statesForAnyType([subjectType], subjectIds);
  }

  /**
   * Like {@link statesFor} but spanning several subject types — for content a
   * report can file under more than one type (a forum post can be reported as
   * `post` OR `reply`, both keyed by the post's uuid). The strongest state per
   * `subjectId` wins (removed beats hidden beats visible), so a subject removed
   * under one type and merely hidden under another still reads as removed.
   */
  async statesForAnyType(
    subjectTypes: readonly string[],
    subjectIds: readonly string[],
  ): Promise<Map<string, ContentModerationState>> {
    const result = new Map<string, ContentModerationState>();
    const uniqueIds = [...new Set(subjectIds)];
    if (!uniqueIds.length || !subjectTypes.length) return result;

    const rows = await this.states.find({
      where: { subjectType: In([...subjectTypes]), subjectId: In(uniqueIds) },
    });
    for (const row of rows) {
      const state = toState(row);
      const existing = result.get(row.subjectId);
      result.set(row.subjectId, existing ? strongest(existing, state) : state);
    }
    return result;
  }

  /**
   * Appends a `NOT EXISTS` predicate to `qb` that drops rows whose subject is
   * hidden-but-not-removed under any of `subjectTypes` — the in-query mirror
   * of `BlockFilterService.excludeHidden`, for exactly the same reason:
   * filtering AFTER a fixed-size fetch under-fills a page, and under an
   * OFFSET-paginated query it permanently skips the row just past the hidden
   * one (the next page's offset is computed from the raw, unfiltered row
   * order). A removed (tombstoned) subject is deliberately NOT excluded here
   * — read paths still render it (blanked, as `[removed]`) rather than drop
   * it, matching `ContentModerationState`'s `hidden`/`removed` split.
   *
   * Callers must skip calling this for a staff viewer (owner/mod), who sees
   * hidden-but-not-removed content — this method has no viewer-role
   * awareness of its own, same contract as `BlockFilterService`'s methods.
   * `subjectIdColumn` is spliced verbatim into raw SQL, so pass an actual,
   * already-quoted `"alias"."id"` reference (never user input); it's cast to
   * `text` because `content_moderation.subject_id` is `varchar` while a
   * post/reply id is `uuid`. Call at most once per query builder (fixed
   * bound parameter name).
   */
  excludeHidden<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    subjectTypes: readonly string[],
    subjectIdColumn: string,
  ): SelectQueryBuilder<E> {
    return qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "__moderation_filter"
        WHERE "__moderation_filter"."subject_type" IN (:...moderationFilterSubjectTypes)
          AND "__moderation_filter"."subject_id" = ${subjectIdColumn}::text
          AND "__moderation_filter"."hidden_at" IS NOT NULL
          AND "__moderation_filter"."removed_at" IS NULL
      )`,
      { moderationFilterSubjectTypes: [...subjectTypes] },
    );
  }
}

function toState(row: ContentModeration): ContentModerationState {
  return { hidden: row.hiddenAt != null, removed: row.removedAt != null };
}

function strongest(
  first: ContentModerationState,
  second: ContentModerationState,
): ContentModerationState {
  return {
    hidden: first.hidden || second.hidden,
    removed: first.removed || second.removed,
  };
}

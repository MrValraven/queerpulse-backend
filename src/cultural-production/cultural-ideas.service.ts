import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  normalizeCommentBody,
  normalizeIdeaCreate,
  normalizeIdeaUpdate,
  isCulturalUuid,
  type NormalizedIdeaCreate,
} from './cultural-input';
import {
  CULTURAL_LIST_LIMIT,
  OPEN_CULTURAL_TASK_STATUSES,
  culturalError,
} from './cultural-production.constants';
import {
  canDeleteCulturalItem,
  toCulturalIdea,
  toCulturalIdeaListItem,
  toCulturalTaskListItem,
  type CulturalCaller,
  type CulturalIdeaDTO,
  type CulturalIdeaListDTO,
  type CulturalIdeaStats,
  type CulturalTaskListItemDTO,
} from './cultural-response';
import {
  CULTURAL_TASK_ORDER_SQL,
  readCulturalStaffSummaries,
  readCulturalTaskLinks,
} from './cultural-staff-read';
import type {
  CreateCulturalIdeaDto,
  CulturalCommentDto,
  UpdateCulturalIdeaDto,
} from './dto/cultural-production.dto';
import { CulturalIdeaBacker } from './entities/cultural-idea-backer.entity';
import { CulturalIdeaComment } from './entities/cultural-idea-comment.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTask } from './entities/cultural-task.entity';

/** The open task statuses as a SQL list, built from the constant so the two
 *  cannot drift. The values are fixed literals with no user input. */
const OPEN_TASK_STATUS_LIST = OPEN_CULTURAL_TASK_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

/** `$1` the page's idea ids, `$2` the caller's id. One row per backed idea:
 *  its backer count, its first five backer ids by `created_at ASC,
 *  user_id ASC`, and whether the caller is among them. */
export const CULTURAL_IDEA_BACKER_STATS_SQL = `SELECT "backer"."idea_id", COUNT(*)::int AS "backer_count", (array_agg("backer"."user_id"::text ORDER BY "backer"."created_at" ASC, "backer"."user_id" ASC))[1:5] AS "backer_ids", bool_or("backer"."user_id" = CAST($2 AS uuid)) AS "is_backed_by_me" FROM "cultural_idea_backers" "backer" WHERE "backer"."idea_id" = ANY($1::uuid[]) GROUP BY "backer"."idea_id"`;

/** `$1` the page's idea ids. One row per idea with comments: its comment
 *  count. */
export const CULTURAL_IDEA_COMMENT_COUNTS_SQL = `SELECT "comment"."idea_id", COUNT(*)::int AS "comment_count" FROM "cultural_idea_comments" "comment" WHERE "comment"."idea_id" = ANY($1::uuid[]) GROUP BY "comment"."idea_id"`;

/** `$1` the page's idea ids. One row per idea with linked tasks: how many,
 *  and how many are still open (`todo` or `doing`). */
export const CULTURAL_IDEA_TASK_COUNTS_SQL = `SELECT "task"."idea_id", COUNT(*)::int AS "linked_task_count", (COUNT(*) FILTER (WHERE "task"."status" IN (${OPEN_TASK_STATUS_LIST})))::int AS "open_linked_task_count" FROM "cultural_tasks" "task" WHERE "task"."idea_id" = ANY($1::uuid[]) GROUP BY "task"."idea_id"`;

/** `$1` an idea id. The ids of its linked tasks in the shared task list
 *  order, so the idea detail and the tasks list never disagree. */
export const CULTURAL_IDEA_LINKED_TASK_IDS_SQL = `SELECT "task"."id" FROM "cultural_tasks" "task" WHERE "task"."idea_id" = $1 ${CULTURAL_TASK_ORDER_SQL}`;

/** `$1` an idea id, `$2` the caller's id. Backs the idea; a second call
 *  finds the row and writes nothing. The idea row is never touched, so its
 *  `updated_at` stays. */
export const CULTURAL_IDEA_BACK_SQL = `INSERT INTO "cultural_idea_backers" ("idea_id", "user_id") VALUES ($1, $2) ON CONFLICT DO NOTHING`;

/** `$1` an idea id, `$2` the caller's id. Withdraws the caller's backing;
 *  no row deletes nothing. The idea row is never touched. */
export const CULTURAL_IDEA_UNBACK_SQL = `DELETE FROM "cultural_idea_backers" WHERE "idea_id" = $1 AND "user_id" = $2`;

/** One row of `CULTURAL_IDEA_BACKER_STATS_SQL`. */
interface IdeaBackerStatsRow {
  idea_id: string;
  backer_count: number | string;
  backer_ids: string[] | null;
  is_backed_by_me: boolean | null;
}

/** One row of `CULTURAL_IDEA_COMMENT_COUNTS_SQL`. */
interface IdeaCommentCountRow {
  idea_id: string;
  comment_count: number | string;
}

/** One row of `CULTURAL_IDEA_TASK_COUNTS_SQL`. */
interface IdeaTaskCountRow {
  idea_id: string;
  linked_task_count: number | string;
  open_linked_task_count: number | string;
}

/** One row of `CULTURAL_IDEA_LINKED_TASK_IDS_SQL`. */
interface LinkedTaskIdRow {
  id: string;
}

/** The ids of an iterable of optional user ids, nulls dropped. */
function presentIds(userIds: Iterable<string | null>): string[] {
  return [...userIds].filter((userId): userId is string => userId !== null);
}

/** A lowercased idea id, or `CULTURAL_IDEA_NOT_FOUND` when it is no uuid.
 *  Runs before any query. */
function ideaIdOf(ideaId: unknown): string {
  if (!isCulturalUuid(ideaId)) {
    throw culturalError('CULTURAL_IDEA_NOT_FOUND');
  }
  return ideaId.toLowerCase();
}

/**
 * Cultural Production ideas: the list, the detail, create, update, delete,
 * backing and comments (contract 7.2 and 7.3). Every refusal goes through
 * `culturalError` in the contract's check order, and a malformed path id
 * answers its not-found code before any query runs. The list reads its
 * backers, comment counts and task counts in three grouped queries and every
 * person in one summary read, so the query count stays the same for any
 * number of ideas. The detail's linked tasks use the shared task order and
 * link read of the tasks list. Log lines name ids only; no idea or comment
 * text is ever logged.
 */
@Injectable()
export class CulturalIdeasService {
  private readonly logger = new Logger(CulturalIdeasService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /** Every idea, newest first, at most `CULTURAL_LIST_LIMIT`. A 501st row
   *  sets `isTruncated`. The client filters by status and event type. */
  async listIdeas(caller: CulturalCaller): Promise<CulturalIdeaListDTO> {
    const manager = this.dataSource.manager;
    const rows = await manager.find(CulturalIdea, {
      order: { createdAt: 'DESC', id: 'DESC' },
      take: CULTURAL_LIST_LIMIT + 1,
    });
    const isTruncated = rows.length > CULTURAL_LIST_LIMIT;
    const ideas = rows.slice(0, CULTURAL_LIST_LIMIT);
    if (ideas.length === 0) {
      return { items: [], isTruncated };
    }

    const ideaIds = ideas.map((idea) => idea.id);
    const [backerRows, commentRows, taskRows] = await Promise.all([
      manager.query<IdeaBackerStatsRow[]>(CULTURAL_IDEA_BACKER_STATS_SQL, [
        ideaIds,
        caller.userId,
      ]),
      manager.query<IdeaCommentCountRow[]>(CULTURAL_IDEA_COMMENT_COUNTS_SQL, [
        ideaIds,
      ]),
      manager.query<IdeaTaskCountRow[]>(CULTURAL_IDEA_TASK_COUNTS_SQL, [
        ideaIds,
      ]),
    ]);
    const backersByIdeaId = new Map(
      backerRows.map((row) => [row.idea_id, row]),
    );
    const commentsByIdeaId = new Map(
      commentRows.map((row) => [row.idea_id, row]),
    );
    const tasksByIdeaId = new Map(taskRows.map((row) => [row.idea_id, row]));

    const statsByIdeaId = new Map<string, CulturalIdeaStats>(
      ideas.map((idea) => {
        const backers = backersByIdeaId.get(idea.id);
        const comments = commentsByIdeaId.get(idea.id);
        const tasks = tasksByIdeaId.get(idea.id);
        return [
          idea.id,
          {
            backerIds: backers?.backer_ids ?? [],
            backerCount: backers ? Number(backers.backer_count) : 0,
            isBackedByMe: backers?.is_backed_by_me === true,
            commentCount: comments ? Number(comments.comment_count) : 0,
            linkedTaskCount: tasks ? Number(tasks.linked_task_count) : 0,
            openLinkedTaskCount: tasks
              ? Number(tasks.open_linked_task_count)
              : 0,
          },
        ];
      }),
    );

    const people = await readCulturalStaffSummaries(
      manager,
      this.mediaCropService,
      [
        ...presentIds(ideas.map((idea) => idea.authorId)),
        ...[...statsByIdeaId.values()].flatMap((stats) => stats.backerIds),
      ],
    );
    return {
      items: ideas.map((idea) =>
        toCulturalIdeaListItem(
          idea,
          statsByIdeaId.get(idea.id) ?? {
            backerIds: [],
            backerCount: 0,
            isBackedByMe: false,
            commentCount: 0,
            linkedTaskCount: 0,
            openLinkedTaskCount: 0,
          },
          people,
          caller,
        ),
      ),
      isTruncated,
    };
  }

  /** The whole idea: every backer, every comment oldest first and its
   *  linked tasks in the task list order. */
  async getIdea(
    ideaId: string,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    return this.readIdea(ideaIdOf(ideaId), caller);
  }

  /** Creates an idea with the caller as author; an absent status takes
   *  `new`. The field checks run before the insert. Answers the whole idea. */
  async createIdea(
    body: CreateCulturalIdeaDto,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const idea = normalizeIdeaCreate(body);
    const manager = this.dataSource.manager;
    const savedIdea = await manager.save(
      CulturalIdea,
      manager.create(CulturalIdea, {
        title: idea.title,
        description: idea.description,
        eventType: idea.eventType,
        status: idea.status,
        authorId: caller.userId,
      }),
    );
    this.logger.log(
      `Cultural idea ${savedIdea.id} created by ${caller.userId}`,
    );
    return this.readIdea(savedIdea.id, caller);
  }

  /** Updates the fields the body sent, in the contract order: the id shape,
   *  each present field, then the row. A body with no known field answers
   *  the idea unchanged. Sending a field's current value is no change; a real
   *  change writes the changed columns, which stamps `updated_at`. */
  async updateIdea(
    ideaId: string,
    body: UpdateCulturalIdeaDto,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const id = ideaIdOf(ideaId);
    const update = normalizeIdeaUpdate(body);
    if (Object.keys(update).length === 0) {
      return this.readIdea(id, caller);
    }
    await this.dataSource.transaction(async (manager) => {
      const idea = await manager.findOne(CulturalIdea, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!idea) {
        throw culturalError('CULTURAL_IDEA_NOT_FOUND');
      }
      const changes: Partial<NormalizedIdeaCreate> = {};
      if (update.title !== undefined && update.title !== idea.title) {
        changes.title = update.title;
      }
      if (
        update.description !== undefined &&
        update.description !== idea.description
      ) {
        changes.description = update.description;
      }
      if (
        update.eventType !== undefined &&
        update.eventType !== idea.eventType
      ) {
        changes.eventType = update.eventType;
      }
      if (update.status !== undefined && update.status !== idea.status) {
        changes.status = update.status;
      }
      if (Object.keys(changes).length > 0) {
        await manager.update(CulturalIdea, { id: idea.id }, changes);
      }
    });
    return this.readIdea(id, caller);
  }

  /** Deletes an idea: the id shape, the row, then the permission (the
   *  author or the staff tier). Its linked tasks stay with no idea. */
  async deleteIdea(
    ideaId: string,
    caller: CulturalCaller,
  ): Promise<{ ok: true }> {
    const id = ideaIdOf(ideaId);
    await this.dataSource.transaction(async (manager) => {
      const idea = await manager.findOne(CulturalIdea, {
        where: { id },
        select: { id: true, authorId: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!idea) {
        throw culturalError('CULTURAL_IDEA_NOT_FOUND');
      }
      if (!canDeleteCulturalItem(idea.authorId, caller)) {
        throw culturalError('CULTURAL_IDEA_NOT_YOURS');
      }
      await manager.delete(CulturalIdea, { id: idea.id });
    });
    this.logger.log(`Cultural idea ${id} deleted by ${caller.userId}`);
    return { ok: true };
  }

  /** Backs an idea for the caller. Idempotent, and the idea's `updated_at`
   *  stays. Answers the whole idea. */
  async backIdea(
    ideaId: string,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const id = ideaIdOf(ideaId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockIdeaForShare(manager, id);
      await manager.query(CULTURAL_IDEA_BACK_SQL, [id, caller.userId]);
    });
    return this.readIdea(id, caller);
  }

  /** Withdraws the caller's backing. Idempotent, and the idea's
   *  `updated_at` stays. Answers the whole idea. */
  async unbackIdea(
    ideaId: string,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const id = ideaIdOf(ideaId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockIdeaForShare(manager, id);
      await manager.query(CULTURAL_IDEA_UNBACK_SQL, [id, caller.userId]);
    });
    return this.readIdea(id, caller);
  }

  /** Posts a comment by the caller: the id shape, the body, the row, then
   *  the insert. Answers the whole idea with the comment last. */
  async addComment(
    ideaId: string,
    body: CulturalCommentDto,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const id = ideaIdOf(ideaId);
    // A body that is no object (a JSON string or null) reads as no text, so
    // the comment rule answers its reason code.
    const commentBody = normalizeCommentBody(
      typeof body === 'object' && body !== null ? body.body : undefined,
    );
    const commentId = await this.dataSource.transaction(async (manager) => {
      await this.lockIdeaForShare(manager, id);
      const savedComment = await manager.save(
        CulturalIdeaComment,
        manager.create(CulturalIdeaComment, {
          ideaId: id,
          authorId: caller.userId,
          body: commentBody,
        }),
      );
      return savedComment.id;
    });
    this.logger.log(
      `Cultural idea comment ${commentId} posted on idea ${id} by ${caller.userId}`,
    );
    return this.readIdea(id, caller);
  }

  /** Deletes a comment: the idea id shape, the comment id shape, the idea
   *  row, the comment on that idea, then the permission (the author or the
   *  staff tier). Answers the whole idea. */
  async deleteComment(
    ideaId: string,
    commentId: string,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const id = ideaIdOf(ideaId);
    if (!isCulturalUuid(commentId)) {
      throw culturalError('CULTURAL_COMMENT_NOT_FOUND');
    }
    const normalizedCommentId = commentId.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      await this.lockIdeaForShare(manager, id);
      const comment = await manager.findOne(CulturalIdeaComment, {
        where: { id: normalizedCommentId, ideaId: id },
        select: { id: true, authorId: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!comment) {
        throw culturalError('CULTURAL_COMMENT_NOT_FOUND');
      }
      if (!canDeleteCulturalItem(comment.authorId, caller)) {
        throw culturalError('CULTURAL_COMMENT_NOT_YOURS');
      }
      await manager.delete(CulturalIdeaComment, { id: comment.id });
    });
    this.logger.log(
      `Cultural idea comment ${normalizedCommentId} deleted from idea ${id} by ${caller.userId}`,
    );
    return this.readIdea(id, caller);
  }

  /** Reads the idea row `FOR SHARE`, so a concurrent delete waits for the
   *  backing or comment write. A missing row answers
   *  `CULTURAL_IDEA_NOT_FOUND`. */
  private async lockIdeaForShare(
    manager: EntityManager,
    ideaId: string,
  ): Promise<void> {
    const idea = await manager.findOne(CulturalIdea, {
      where: { id: ideaId },
      select: { id: true },
      lock: { mode: 'pessimistic_read' },
    });
    if (!idea) {
      throw culturalError('CULTURAL_IDEA_NOT_FOUND');
    }
  }

  /** The whole idea for an already checked, lowercased id: one read each of
   *  the idea, its backers, its comments and its linked task ids, then the
   *  linked task rows, their links and one summary read over every person on
   *  the answer. */
  private async readIdea(
    ideaId: string,
    caller: CulturalCaller,
  ): Promise<CulturalIdeaDTO> {
    const manager = this.dataSource.manager;
    const idea = await manager.findOne(CulturalIdea, { where: { id: ideaId } });
    if (!idea) {
      throw culturalError('CULTURAL_IDEA_NOT_FOUND');
    }
    const [backers, comments, linkedTaskIdRows] = await Promise.all([
      manager.find(CulturalIdeaBacker, {
        where: { ideaId: idea.id },
        select: { ideaId: true, userId: true, createdAt: true },
        order: { createdAt: 'ASC', userId: 'ASC' },
      }),
      manager.find(CulturalIdeaComment, {
        where: { ideaId: idea.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
      manager.query<LinkedTaskIdRow[]>(CULTURAL_IDEA_LINKED_TASK_IDS_SQL, [
        idea.id,
      ]),
    ]);

    const linkedTaskIds = linkedTaskIdRows.map((row) => row.id);
    const linkedTasks = await this.readTasksInOrder(manager, linkedTaskIds);
    const linksByTaskId = await readCulturalTaskLinks(manager, linkedTaskIds);
    const backerIds = backers.map((backer) => backer.userId);

    const people = await readCulturalStaffSummaries(
      manager,
      this.mediaCropService,
      [
        ...presentIds([idea.authorId]),
        ...backerIds,
        ...presentIds(comments.map((comment) => comment.authorId)),
        ...presentIds(linkedTasks.map((task) => task.authorId)),
        ...[...linksByTaskId.values()].flatMap((links) => links.assigneeIds),
      ],
    );
    const linkedTaskItems: CulturalTaskListItemDTO[] = linkedTasks.map((task) =>
      toCulturalTaskListItem(
        task,
        linksByTaskId.get(task.id) ?? {
          assigneeIds: [],
          idea: null,
          guide: null,
        },
        people,
        caller,
      ),
    );
    return toCulturalIdea(
      idea,
      { backerIds, comments, linkedTasks: linkedTaskItems },
      people,
      caller,
    );
  }

  /** The task rows of `taskIds` in the order the ids arrive. A task deleted
   *  between the id read and this read drops out. */
  private async readTasksInOrder(
    manager: EntityManager,
    taskIds: readonly string[],
  ): Promise<CulturalTask[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const tasks = await manager.find(CulturalTask, {
      where: { id: In([...taskIds]) },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    return taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is CulturalTask => task !== undefined);
  }
}

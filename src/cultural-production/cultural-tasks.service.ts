import { randomUUID } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  DataSource,
  In,
  type EntityManager,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { escapeLikeTerm } from '../common/like-escape';
import { PRIVATE_PARAMETERS_COMMENT } from '../database/private-parameters-logger';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  foldedHaystack,
  foldedSearchTerm,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { lisbonWallDay } from '../subprofiles/persona-wall.rules';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { countGuideSteps, dueOnForStep } from './cultural-guide-sections';
import {
  isCulturalUuid,
  normalizeAssigneeIds,
  normalizeCulturalDay,
  normalizeSearchTerm,
  normalizeTaskCreate,
  normalizeTaskFilters,
  normalizeTaskUpdate,
  type CulturalTaskFilters,
} from './cultural-input';
import {
  CULTURAL_LIST_LIMIT,
  CULTURAL_MAX_ASSIGNEES,
  CULTURAL_STAFF_PREVIEW_LIMIT,
  CULTURAL_STAFF_SEARCH_LIMIT,
  OPEN_CULTURAL_TASK_STATUSES,
  culturalError,
  type CulturalTaskStatus,
} from './cultural-production.constants';
import {
  canDeleteCulturalItem,
  toCulturalStaffSummary,
  toCulturalTask,
  toCulturalTaskListItem,
  type CulturalCaller,
  type CulturalStaffProfileRow,
  type CulturalStaffSearchDTO,
  type CulturalTaskBatchDTO,
  type CulturalTaskDTO,
  type CulturalTaskLinks,
  type CulturalTaskListDTO,
  type CulturalTaskListItemDTO,
} from './cultural-response';
import {
  CULTURAL_STAFF_ELIGIBLE_SQL,
  culturalStaffEligibility,
} from './cultural-staff-eligibility';
import {
  CULTURAL_TASK_ORDER_SQL,
  readCulturalStaffSummaries,
  readCulturalTaskLinks,
} from './cultural-staff-read';
import type {
  AssignCulturalTaskDto,
  CreateCulturalTaskBatchDto,
  CreateCulturalTaskDto,
  ListCulturalTasksQuery,
  UpdateCulturalTaskDto,
} from './dto/cultural-production.dto';
import { CulturalGuide } from './entities/cultural-guide.entity';
import { CulturalIdea } from './entities/cultural-idea.entity';
import { CulturalTaskAssignee } from './entities/cultural-task-assignee.entity';
import { CulturalTask } from './entities/cultural-task.entity';

/** The open statuses, quoted for an SQL `IN` list. */
const OPEN_STATUS_LIST = OPEN_CULTURAL_TASK_STATUSES.map(
  (status) => `'${status}'`,
).join(', ');

/** An open task over the alias `"task"`: status todo or doing. The list's
 *  `open` filter and the badge both read it. */
export const CULTURAL_TASK_IS_OPEN_SQL = `"task"."status" IN (${OPEN_STATUS_LIST})`;

/** `:today` the Lisbon day. An open task whose due day has come. The badge
 *  counts it with `CULTURAL_ASSIGNED_TO_CALLER_SQL`. */
export const CULTURAL_TASK_IS_DUE_SQL = `${CULTURAL_TASK_IS_OPEN_SQL} AND "task"."due_on" <= CAST(:today AS date)`;

/** `:callerId` the caller. The task over `"task"` has the caller among its
 *  assignees: the list's `assignedTo=me` view and the badge. */
export const CULTURAL_ASSIGNED_TO_CALLER_SQL = `EXISTS (SELECT 1 FROM "cultural_task_assignees" "mine" WHERE "mine"."task_id" = "task"."id" AND "mine"."user_id" = CAST(:callerId AS uuid))`;

/** The task over `"task"` has nobody assigned: the list's
 *  `assignedTo=unassigned` view. */
export const CULTURAL_UNASSIGNED_SQL = `NOT EXISTS (SELECT 1 FROM "cultural_task_assignees" "anyone" WHERE "anyone"."task_id" = "task"."id")`;

/** `$1` the task id. Stamps `updated_at` after an assignee row changed. */
export const TOUCH_CULTURAL_TASK_SQL = `UPDATE "cultural_tasks" SET "updated_at" = now() WHERE "id" = $1`;

/** The transaction's start time, which a guide batch staggers `created_at`
 *  from. */
export const CULTURAL_TRANSACTION_START_SQL = `SELECT now() AS "started_at"`;

/** The staff picker's folded name haystack over `"profile"`: first name,
 *  last name and slug, the expression the leads picker searches. */
export const CULTURAL_STAFF_SEARCH_HAYSTACK = foldedHaystack(
  'profile',
  PROFILE_NAME_SEARCH_COLUMNS,
);

/** `:term` the escaped `%...%` pattern. A typed picker query matches the
 *  folded haystack, wildcards in the typed text matched literally. */
export const CULTURAL_STAFF_SEARCH_SQL = `${CULTURAL_STAFF_SEARCH_HAYSTACK} LIKE ${foldedSearchTerm('term')} ESCAPE '\\'`;

/** `:callerId` the caller. Sorts the caller ahead of everyone else in the
 *  blank picker preview. */
export const CULTURAL_STAFF_CALLER_FIRST_SQL =
  'CASE WHEN "staff"."id" = CAST(:callerId AS uuid) THEN 0 ELSE 1 END';

/** The first-name sort of every picker query. */
const STAFF_FIRST_NAME_ORDER = 'lower("profile"."first_name")';

/** The last-name sort after the first name. */
const STAFF_LAST_NAME_ORDER = 'lower("profile"."last_name")';

/** The last sort, so people with equal names keep a stable order. */
const STAFF_ID_ORDER = 'staff.id';

/** The raw columns one picker row answers: the user id and the five profile
 *  columns a summary needs. */
interface CulturalStaffPickerRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
}

/** One row of the grouped status count. */
interface CulturalTaskStatusCountRow {
  status: string;
  count: number | string;
}

/** One row of the page id query. */
interface CulturalTaskIdRow {
  id: string;
}

/** One row of `CULTURAL_TRANSACTION_START_SQL`. */
interface CulturalTransactionStartRow {
  started_at: Date | string;
}

/** The profile columns of a picker row, read field by field so a stray
 *  column never reaches the summary. */
function profileRowOf(row: CulturalStaffPickerRow): CulturalStaffProfileRow {
  return {
    userId: row.user_id,
    slug: row.slug,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarUrl: row.avatar_url,
    photoVisible: row.photo_visible === true,
  };
}

/** The `userId` property of an assign body, or undefined when the body is
 *  no object. */
function assigneeIdOf(requestBody: unknown): unknown {
  if (typeof requestBody !== 'object' || requestBody === null) {
    return undefined;
  }
  return (requestBody as AssignCulturalTaskDto).userId;
}

/** The body of a batch request, or an empty one when the body is no
 *  object, so the field checks answer their own codes. */
function batchBodyOf(requestBody: unknown): CreateCulturalTaskBatchDto {
  if (typeof requestBody !== 'object' || requestBody === null) {
    return {};
  }
  return requestBody;
}

/** Whether two user ids name the same account, in any letter case. */
function isSameUser(firstUserId: string, secondUserId: string): boolean {
  return firstUserId.toLowerCase() === secondUserId.toLowerCase();
}

/** The name of a caught error for a log line: its class name only, so no
 *  driver message carrying a value reaches the log. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/** A task with no assignees and no links, for a task the link read missed. */
function emptyTaskLinks(): CulturalTaskLinks {
  return { assigneeIds: [], idea: null, guide: null };
}

/**
 * Cultural Production: tasks, their assignees, the due-count badge, the staff
 * picker and the guide batches. The controller's guards admit the staff tier
 * and both Cultural Production grants; this service trusts that gate and
 * checks the rest in the contract's order (sections 7.2 to 7.5).
 *
 * Every write runs in one transaction that locks the task row it changes, so
 * two assigns can never both pass the cap. Linked ideas and guides are read
 * with a key share lock, so a concurrent delete waits for the insert to
 * commit. Assignment notifications are written after the commit, one per
 * person other than the caller, with ids and a title only and no `actorId`
 * argument, so a mute between two staff members never silences them; a
 * failed notification is logged by id and the write still answers. No task
 * text, staff name or picker text is ever logged.
 */
@Injectable()
export class CulturalTasksService {
  private readonly logger = new Logger(CulturalTasksService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /**
   * The staff picker: eligible staff with a profile. A blank query previews
   * five people with the caller first; a typed query answers up to twenty
   * matches by name. The typed text is kept out of the query log.
   */
  async searchStaff(
    q: unknown,
    caller: CulturalCaller,
  ): Promise<CulturalStaffSearchDTO> {
    const term = normalizeSearchTerm(q);
    const builder = this.dataSource.manager
      .createQueryBuilder(User, 'staff')
      .comment(PRIVATE_PARAMETERS_COMMENT)
      .innerJoin(Profile, 'profile', '"profile"."user_id" = "staff"."id"')
      .where(CULTURAL_STAFF_ELIGIBLE_SQL)
      .select('staff.id', 'user_id')
      .addSelect('profile.slug', 'slug')
      .addSelect('profile.firstName', 'first_name')
      .addSelect('profile.lastName', 'last_name')
      .addSelect('profile.avatarUrl', 'avatar_url')
      .addSelect('profile.photoVisible', 'photo_visible');
    if (term === '') {
      builder
        .orderBy(CULTURAL_STAFF_CALLER_FIRST_SQL, 'ASC')
        .setParameter('callerId', caller.userId)
        .addOrderBy(STAFF_FIRST_NAME_ORDER, 'ASC');
    } else {
      builder
        .andWhere(CULTURAL_STAFF_SEARCH_SQL, {
          term: `%${escapeLikeTerm(term)}%`,
        })
        .orderBy(STAFF_FIRST_NAME_ORDER, 'ASC');
    }
    builder
      .addOrderBy(STAFF_LAST_NAME_ORDER, 'ASC')
      .addOrderBy(STAFF_ID_ORDER, 'ASC')
      .limit(
        term === ''
          ? CULTURAL_STAFF_PREVIEW_LIMIT
          : CULTURAL_STAFF_SEARCH_LIMIT,
      );
    const rows = await builder.getRawMany<CulturalStaffPickerRow>();
    const profileRows = rows.map(profileRowOf);
    const crops = await this.mediaCropService.getMany(
      profileRows
        .filter((profile) => profile.photoVisible)
        .map((profile) => profile.avatarUrl)
        .filter((avatarKey): avatarKey is string => Boolean(avatarKey)),
    );
    return {
      items: profileRows.map((profile) =>
        toCulturalStaffSummary(profile.userId, profile, crops),
      ),
    };
  }

  /** The nav badge: open tasks assigned to the caller whose due day is the
   *  Lisbon day of `now` or earlier. The same assignee predicate as the
   *  list's `assignedTo=me` view. */
  async dueCount(
    caller: CulturalCaller,
    now: Date = new Date(),
  ): Promise<{ count: number }> {
    const count = await this.dataSource.manager
      .createQueryBuilder(CulturalTask, 'task')
      .setParameter('today', lisbonWallDay(now))
      .where(CULTURAL_TASK_IS_DUE_SQL)
      .andWhere(CULTURAL_ASSIGNED_TO_CALLER_SQL, { callerId: caller.userId })
      .getCount();
    return { count };
  }

  /** Tasks under the two filters in the contract's task order, at most 500,
   *  and the todo, doing and done counts under `assignedTo` alone. The
   *  filters are checked before any query, `assignedTo` first. */
  async listTasks(
    query: ListCulturalTasksQuery,
    caller: CulturalCaller,
  ): Promise<CulturalTaskListDTO> {
    const filters = normalizeTaskFilters(query);
    const manager = this.dataSource.manager;

    const pageIdQuery = manager
      .createQueryBuilder(CulturalTask, 'task')
      .select('"task"."id"', 'id');
    this.applyAssignedToFilter(pageIdQuery, filters, caller.userId);
    this.applyStatusFilter(pageIdQuery, filters);
    const [filteredSql, filterParameters]: [string, unknown[]] =
      pageIdQuery.getQueryAndParameters();
    const limitPosition = filterParameters.length + 1;
    const idRows = await manager.query<CulturalTaskIdRow[]>(
      `${filteredSql} ${CULTURAL_TASK_ORDER_SQL} LIMIT $${limitPosition}`,
      [...filterParameters, CULTURAL_LIST_LIMIT + 1],
    );

    const countQuery = manager.createQueryBuilder(CulturalTask, 'task');
    this.applyAssignedToFilter(countQuery, filters, caller.userId);
    const countRows = await countQuery
      .select('"task"."status"', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('"task"."status"')
      .getRawMany<CulturalTaskStatusCountRow>();

    const counts: Record<CulturalTaskStatus, number> = {
      todo: 0,
      doing: 0,
      done: 0,
    };
    for (const row of countRows) {
      if (row.status === 'todo' || row.status === 'doing') {
        counts[row.status] = Number(row.count);
      } else if (row.status === 'done') {
        counts.done = Number(row.count);
      }
    }
    const pageIds = idRows
      .slice(0, CULTURAL_LIST_LIMIT)
      .map((idRow) => idRow.id);
    const items = await this.readTaskListItems(manager, pageIds, caller);
    return {
      items,
      counts,
      isTruncated: idRows.length > CULTURAL_LIST_LIMIT,
    };
  }

  /** One task with its notes, assignees and links. A malformed or unknown id
   *  answers `CULTURAL_TASK_NOT_FOUND`. */
  async getTask(
    taskId: string,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    if (!isCulturalUuid(taskId)) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    return this.readTaskDetail(
      this.dataSource.manager,
      taskId.toLowerCase(),
      caller,
    );
  }

  /** Creates a task, the caller its author. Every field check runs before
   *  the transaction; inside it the linked idea and guide must exist and
   *  each assignee must be eligible, in array order, before anything is
   *  written. A task created done is completed now. Each assignee other
   *  than the caller gets `cultural_task_assigned` after the commit. */
  async createTask(
    body: CreateCulturalTaskDto,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    const fields = normalizeTaskCreate(body);
    const taskId = randomUUID();
    await this.dataSource.transaction(async (manager) => {
      await this.assertLinksExist(manager, fields.ideaId, fields.guideId);
      await this.assertAssigneesEligible(manager, fields.assigneeIds);
      await manager.insert(CulturalTask, {
        id: taskId,
        title: fields.title,
        notes: fields.notes,
        status: fields.status,
        dueOn: fields.dueOn,
        eventOn: null,
        ideaId: fields.ideaId,
        guideId: fields.guideId,
        authorId: caller.userId,
        completedAt: fields.status === 'done' ? () => 'now()' : null,
      });
      if (fields.assigneeIds.length > 0) {
        await manager.insert(
          CulturalTaskAssignee,
          fields.assigneeIds.map((userId) => ({
            taskId,
            userId,
            assignedById: caller.userId,
          })),
        );
      }
    });
    for (const userId of fields.assigneeIds) {
      if (!isSameUser(userId, caller.userId)) {
        await this.notifyTaskAssigned(taskId, fields.title, userId, caller);
      }
    }
    return this.readTaskDetail(this.dataSource.manager, taskId, caller);
  }

  /** Changes the fields the body carries. Assignees never change here. The
   *  task row is locked, then the linked idea and guide must exist. Moving
   *  into done completes the task now; moving out of done clears it. A body
   *  that changes nothing writes nothing and leaves `updated_at` alone. */
  async updateTask(
    taskId: string,
    body: UpdateCulturalTaskDto,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    if (!isCulturalUuid(taskId)) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    const lowercaseTaskId = taskId.toLowerCase();
    const changes = normalizeTaskUpdate(body);
    await this.dataSource.transaction(async (manager) => {
      const task = await manager.findOne(CulturalTask, {
        where: { id: lowercaseTaskId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!task) {
        throw culturalError('CULTURAL_TASK_NOT_FOUND');
      }
      // Only a link that moves is checked: re-locking an unchanged idea or
      // guide after the task row could wait in a cycle with its delete,
      // which locks the parent first and then sets this task's key null.
      const changedIdeaId =
        changes.ideaId !== undefined && changes.ideaId !== task.ideaId
          ? changes.ideaId
          : null;
      const changedGuideId =
        changes.guideId !== undefined && changes.guideId !== task.guideId
          ? changes.guideId
          : null;
      await this.assertLinksExist(manager, changedIdeaId, changedGuideId);
      const values: QueryDeepPartialEntity<CulturalTask> = {};
      if (changes.title !== undefined && changes.title !== task.title) {
        values.title = changes.title;
      }
      if (changes.notes !== undefined && changes.notes !== task.notes) {
        values.notes = changes.notes;
      }
      if (changes.dueOn !== undefined && changes.dueOn !== task.dueOn) {
        values.dueOn = changes.dueOn;
      }
      if (changes.ideaId !== undefined && changes.ideaId !== task.ideaId) {
        values.ideaId = changes.ideaId;
      }
      if (changes.guideId !== undefined && changes.guideId !== task.guideId) {
        values.guideId = changes.guideId;
      }
      if (changes.status !== undefined && changes.status !== task.status) {
        values.status = changes.status;
        if (changes.status === 'done') {
          values.completedAt = () => 'now()';
        } else if (task.status === 'done') {
          values.completedAt = null;
        }
      }
      if (Object.keys(values).length > 0) {
        await manager.update(CulturalTask, { id: task.id }, values);
      }
    });
    return this.readTaskDetail(
      this.dataSource.manager,
      lowercaseTaskId,
      caller,
    );
  }

  /** Deletes a task and its assignee rows. Only the author or the staff
   *  tier may: anyone else gets `CULTURAL_TASK_NOT_YOURS`. */
  async deleteTask(
    taskId: string,
    caller: CulturalCaller,
  ): Promise<{ ok: true }> {
    if (!isCulturalUuid(taskId)) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    const lowercaseTaskId = taskId.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      const task = await manager.findOne(CulturalTask, {
        where: { id: lowercaseTaskId },
        select: { id: true, authorId: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!task) {
        throw culturalError('CULTURAL_TASK_NOT_FOUND');
      }
      if (!canDeleteCulturalItem(task.authorId, caller)) {
        throw culturalError('CULTURAL_TASK_NOT_YOURS');
      }
      await manager.delete(CulturalTask, { id: task.id });
    });
    return { ok: true };
  }

  /** Puts one person on a task and answers the task. Check order: task id
   *  shape, body `userId` shape, the task row lock, an existing assignment
   *  (answers unchanged with no eligibility check), eligibility, the cap of
   *  ten. A new assignment of someone other than the caller sends
   *  `cultural_task_assigned` after the commit. */
  async assign(
    taskId: string,
    body: AssignCulturalTaskDto,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    if (!isCulturalUuid(taskId)) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    const requestedId = assigneeIdOf(body);
    if (!isCulturalUuid(requestedId)) {
      throw culturalError('CULTURAL_ASSIGNEE_NOT_FOUND', {
        status: HttpStatus.BAD_REQUEST,
      });
    }
    const lowercaseTaskId = taskId.toLowerCase();
    // isUUID accepts upper case; one spelling keeps the self check exact.
    const userId = requestedId.toLowerCase();
    const assignment = await this.dataSource.transaction(async (manager) => {
      const task = await this.lockTaskRow(manager, lowercaseTaskId);
      const existingAssignment = await manager.findOne(CulturalTaskAssignee, {
        where: { taskId: task.id, userId },
        select: { userId: true },
      });
      if (existingAssignment) {
        return { isNewAssignment: false, taskTitle: task.title };
      }
      const eligibility = await culturalStaffEligibility(manager, userId);
      if (eligibility.kind === 'not_found') {
        throw culturalError('CULTURAL_ASSIGNEE_NOT_FOUND');
      }
      if (eligibility.kind === 'ineligible') {
        throw culturalError('CULTURAL_ASSIGNEE_NOT_STAFF', {
          reason: eligibility.reason,
        });
      }
      const assigneeCount = await manager.count(CulturalTaskAssignee, {
        where: { taskId: task.id },
      });
      if (assigneeCount >= CULTURAL_MAX_ASSIGNEES) {
        throw culturalError('CULTURAL_TOO_MANY_ASSIGNEES');
      }
      await manager.insert(CulturalTaskAssignee, {
        taskId: task.id,
        userId,
        assignedById: caller.userId,
      });
      await manager.query(TOUCH_CULTURAL_TASK_SQL, [task.id]);
      return { isNewAssignment: true, taskTitle: task.title };
    });
    if (assignment.isNewAssignment && !isSameUser(userId, caller.userId)) {
      await this.notifyTaskAssigned(
        lowercaseTaskId,
        assignment.taskTitle,
        userId,
        caller,
      );
    }
    return this.readTaskDetail(
      this.dataSource.manager,
      lowercaseTaskId,
      caller,
    );
  }

  /** Takes one person off a task and answers the task. No eligibility check
   *  and no notification; a person who is not on the task answers the task
   *  unchanged. */
  async unassign(
    taskId: string,
    userId: string,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    if (!isCulturalUuid(taskId)) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    if (!isCulturalUuid(userId)) {
      throw culturalError('CULTURAL_ASSIGNEE_NOT_FOUND');
    }
    const lowercaseTaskId = taskId.toLowerCase();
    const assigneeId = userId.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      const task = await this.lockTaskRow(manager, lowercaseTaskId);
      const deleteResult = await manager.delete(CulturalTaskAssignee, {
        taskId: task.id,
        userId: assigneeId,
      });
      if (deleteResult.affected) {
        await manager.query(TOUCH_CULTURAL_TASK_SQL, [task.id]);
      }
    });
    return this.readTaskDetail(
      this.dataSource.manager,
      lowercaseTaskId,
      caller,
    );
  }

  /** Turns a guide's checklist into tasks for one event day: one task per
   *  step, sections then steps in order, each due `daysBefore` days before
   *  `eventOn`, every listed person assigned to every task. `created_at`
   *  steps one millisecond per position from the transaction's start, so the
   *  list keeps the guide's order on equal due days. Each assignee other
   *  than the caller gets one `cultural_task_batch_assigned` after the
   *  commit. Answers the new tasks in creation order. */
  async createFromGuide(
    guideId: string,
    body: CreateCulturalTaskBatchDto,
    caller: CulturalCaller,
  ): Promise<CulturalTaskBatchDTO> {
    if (!isCulturalUuid(guideId)) {
      throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
    }
    const lowercaseGuideId = guideId.toLowerCase();
    const batchBody = batchBodyOf(body);
    const eventOn = normalizeCulturalDay(
      batchBody.eventOn,
      'CULTURAL_EVENT_DATE_INVALID',
      { isNullable: false },
    );
    // Never true: `isNullable: false` refuses null. It only narrows the type.
    if (eventOn === null) {
      throw culturalError('CULTURAL_EVENT_DATE_INVALID');
    }
    const assigneeIds = normalizeAssigneeIds(batchBody.assigneeIds);
    const batch = await this.dataSource.transaction(async (manager) => {
      const guide = await manager.findOne(CulturalGuide, {
        where: { id: lowercaseGuideId },
        select: { id: true, title: true, sections: true },
        lock: { mode: 'for_key_share' },
      });
      if (!guide) {
        throw culturalError('CULTURAL_GUIDE_NOT_FOUND');
      }
      if (countGuideSteps(guide.sections) === 0) {
        throw culturalError('CULTURAL_GUIDE_HAS_NO_STEPS');
      }
      await this.assertAssigneesEligible(manager, assigneeIds);
      const startRows = await manager.query<CulturalTransactionStartRow[]>(
        CULTURAL_TRANSACTION_START_SQL,
      );
      const startedAt = startRows[0]?.started_at;
      const startMilliseconds =
        startedAt === undefined ? Date.now() : new Date(startedAt).getTime();
      const steps = guide.sections.flatMap((section) => section.steps);
      const taskRows = steps.map((step, position) => ({
        id: randomUUID(),
        title: step.text,
        notes: '',
        status: 'todo' as const,
        dueOn: dueOnForStep(eventOn, step.daysBefore),
        eventOn,
        ideaId: null,
        guideId: guide.id,
        authorId: caller.userId,
        completedAt: null,
        createdAt: new Date(startMilliseconds + position),
      }));
      await manager.insert(CulturalTask, taskRows);
      if (assigneeIds.length > 0) {
        await manager.insert(
          CulturalTaskAssignee,
          taskRows.flatMap((taskRow) =>
            assigneeIds.map((userId) => ({
              taskId: taskRow.id,
              userId,
              assignedById: caller.userId,
            })),
          ),
        );
      }
      return {
        guideTitle: guide.title,
        taskIds: taskRows.map((taskRow) => taskRow.id),
      };
    });
    for (const userId of assigneeIds) {
      if (!isSameUser(userId, caller.userId)) {
        await this.notifyBatchAssigned(
          lowercaseGuideId,
          batch.guideTitle,
          batch.taskIds.length,
          userId,
          caller,
        );
      }
    }
    return {
      items: await this.readTaskListItems(
        this.dataSource.manager,
        batch.taskIds,
        caller,
      ),
    };
  }

  /** The `assignedTo` view: the caller's tasks or nobody's. `callerId` binds
   *  the `me` view. */
  private applyAssignedToFilter(
    queryBuilder: SelectQueryBuilder<CulturalTask>,
    filters: Pick<CulturalTaskFilters, 'assignedTo'>,
    callerId: string,
  ): void {
    if (filters.assignedTo === 'me') {
      queryBuilder.andWhere(CULTURAL_ASSIGNED_TO_CALLER_SQL, { callerId });
    } else if (filters.assignedTo === 'unassigned') {
      queryBuilder.andWhere(CULTURAL_UNASSIGNED_SQL);
    }
  }

  /** The `status` view: open (todo and doing) or one status. */
  private applyStatusFilter(
    queryBuilder: SelectQueryBuilder<CulturalTask>,
    filters: Pick<CulturalTaskFilters, 'status'>,
  ): void {
    if (filters.status === 'open') {
      queryBuilder.andWhere(CULTURAL_TASK_IS_OPEN_SQL);
    } else if (filters.status !== null) {
      queryBuilder.andWhere('"task"."status" = :status', {
        status: filters.status,
      });
    }
  }

  /** Locks the task row for the rest of the transaction and answers its id
   *  and title, or throws `CULTURAL_TASK_NOT_FOUND`. Every assignee write
   *  takes this lock first, so the cap check never races. */
  private async lockTaskRow(
    manager: EntityManager,
    taskId: string,
  ): Promise<Pick<CulturalTask, 'id' | 'title'>> {
    const task = await manager.findOne(CulturalTask, {
      where: { id: taskId },
      select: { id: true, title: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!task) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    return task;
  }

  /** The linked idea, then the linked guide, must exist. Each is read with a
   *  key share lock, so it cannot be deleted before the write commits. A
   *  `null` id links nothing and reads nothing. */
  private async assertLinksExist(
    manager: EntityManager,
    ideaId: string | null,
    guideId: string | null,
  ): Promise<void> {
    if (ideaId !== null) {
      const idea = await manager.findOne(CulturalIdea, {
        where: { id: ideaId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
      if (!idea) {
        throw culturalError('CULTURAL_LINKED_IDEA_NOT_FOUND');
      }
    }
    if (guideId !== null) {
      const guide = await manager.findOne(CulturalGuide, {
        where: { id: guideId },
        select: { id: true },
        lock: { mode: 'for_key_share' },
      });
      if (!guide) {
        throw culturalError('CULTURAL_LINKED_GUIDE_NOT_FOUND');
      }
    }
  }

  /** Each person of a body list, in array order, must be eligible. The
   *  first who is not refuses the whole write, naming their id. */
  private async assertAssigneesEligible(
    manager: EntityManager,
    assigneeIds: readonly string[],
  ): Promise<void> {
    for (const userId of assigneeIds) {
      const eligibility = await culturalStaffEligibility(manager, userId);
      if (eligibility.kind === 'not_found') {
        throw culturalError('CULTURAL_ASSIGNEE_NOT_FOUND', { userId });
      }
      if (eligibility.kind === 'ineligible') {
        throw culturalError('CULTURAL_ASSIGNEE_NOT_STAFF', {
          reason: eligibility.reason,
          userId,
        });
      }
    }
  }

  /** One task with its notes, read through `manager`. */
  private async readTaskDetail(
    manager: EntityManager,
    taskId: string,
    caller: CulturalCaller,
  ): Promise<CulturalTaskDTO> {
    const task = await manager.findOne(CulturalTask, {
      where: { id: taskId },
    });
    if (!task) {
      throw culturalError('CULTURAL_TASK_NOT_FOUND');
    }
    const linksByTaskId = await readCulturalTaskLinks(manager, [task.id]);
    const links = linksByTaskId.get(task.id) ?? emptyTaskLinks();
    const people = await readCulturalStaffSummaries(
      manager,
      this.mediaCropService,
      [...links.assigneeIds, ...(task.authorId ? [task.authorId] : [])],
    );
    return toCulturalTask(task, links, people, caller);
  }

  /** The list items of `taskIds`, in that order: one task read, one link
   *  read and one summary read for every person on the page. A task gone
   *  since its id was read is dropped. */
  private async readTaskListItems(
    manager: EntityManager,
    taskIds: readonly string[],
    caller: CulturalCaller,
  ): Promise<CulturalTaskListItemDTO[]> {
    if (taskIds.length === 0) {
      return [];
    }
    const tasks = await manager.find(CulturalTask, {
      where: { id: In([...taskIds]) },
    });
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const orderedTasks = taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is CulturalTask => task !== undefined);
    const linksByTaskId = await readCulturalTaskLinks(
      manager,
      orderedTasks.map((task) => task.id),
    );
    const personIds = orderedTasks.flatMap((task) => [
      ...(linksByTaskId.get(task.id)?.assigneeIds ?? []),
      ...(task.authorId ? [task.authorId] : []),
    ]);
    const people = await readCulturalStaffSummaries(
      manager,
      this.mediaCropService,
      personIds,
    );
    return orderedTasks.map((task) =>
      toCulturalTaskListItem(
        task,
        linksByTaskId.get(task.id) ?? emptyTaskLinks(),
        people,
        caller,
      ),
    );
  }

  /** Sends `cultural_task_assigned` to one assignee: the task id, its title
   *  and the assigner's id, with no `actorId` argument. A failure is logged
   *  by id and swallowed, so the committed write still answers. */
  private async notifyTaskAssigned(
    taskId: string,
    taskTitle: string,
    userId: string,
    caller: CulturalCaller,
  ): Promise<void> {
    try {
      await this.notifications.create(
        userId,
        NotificationType.CulturalTaskAssigned,
        { taskId, taskTitle, assignedById: caller.userId },
      );
    } catch (error) {
      this.logger.warn(
        `Cultural task assignment notification failed (task ${taskId}, recipient ${userId}, assigned by ${caller.userId}): ${errorNameOf(error)}`,
      );
    }
  }

  /** Sends `cultural_task_batch_assigned` to one assignee for a whole guide
   *  batch: the guide id, its title, the task count and the assigner's id,
   *  with no `actorId` argument. A failure is logged by id and swallowed. */
  private async notifyBatchAssigned(
    guideId: string,
    guideTitle: string,
    taskCount: number,
    userId: string,
    caller: CulturalCaller,
  ): Promise<void> {
    try {
      await this.notifications.create(
        userId,
        NotificationType.CulturalTaskBatchAssigned,
        { guideId, guideTitle, taskCount, assignedById: caller.userId },
      );
    } catch (error) {
      this.logger.warn(
        `Cultural task batch notification failed (guide ${guideId}, recipient ${userId}, assigned by ${caller.userId}): ${errorNameOf(error)}`,
      );
    }
  }
}

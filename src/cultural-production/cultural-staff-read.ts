import { In, type EntityManager } from 'typeorm';
import type { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import {
  toCulturalStaffSummary,
  type CulturalStaffProfileRow,
  type CulturalStaffSummaryDTO,
  type CulturalTaskLinks,
} from './cultural-response';

/** The task list order of contract section 7.3 over the alias `"task"`: open
 *  tasks first by due day (no due day last), then done tasks newest completion
 *  first, then creation order and id. Appended to a raw query that aliases
 *  `cultural_tasks` as `"task"`. */
export const CULTURAL_TASK_ORDER_SQL = `ORDER BY CASE WHEN "task"."status" = 'done' THEN 1 ELSE 0 END, CASE WHEN "task"."status" = 'done' THEN NULL ELSE "task"."due_on" END ASC NULLS LAST, "task"."completed_at" DESC NULLS LAST, "task"."created_at" ASC, "task"."id" ASC`;

/** Every assignee of a page of tasks, in `assigned_at ASC, user_id ASC` order. */
export const CULTURAL_TASK_ASSIGNEE_IDS_SQL = `SELECT "assignee"."task_id", "assignee"."user_id" FROM "cultural_task_assignees" "assignee" WHERE "assignee"."task_id" = ANY($1::uuid[]) ORDER BY "assignee"."assigned_at" ASC, "assignee"."user_id" ASC`;

/** The linked idea id and title of each task of a page that has one. */
export const CULTURAL_TASK_IDEA_TITLES_SQL = `SELECT "task"."id" AS "task_id", "idea"."id" AS "idea_id", "idea"."title" FROM "cultural_tasks" "task" INNER JOIN "cultural_ideas" "idea" ON "idea"."id" = "task"."idea_id" WHERE "task"."id" = ANY($1::uuid[])`;

/** The linked guide id and title of each task of a page that has one. */
export const CULTURAL_TASK_GUIDE_TITLES_SQL = `SELECT "task"."id" AS "task_id", "guide"."id" AS "guide_id", "guide"."title" FROM "cultural_tasks" "task" INNER JOIN "cultural_guides" "guide" ON "guide"."id" = "task"."guide_id" WHERE "task"."id" = ANY($1::uuid[])`;

/** One row of `CULTURAL_TASK_ASSIGNEE_IDS_SQL`. */
interface CulturalTaskAssigneeIdRow {
  task_id: string;
  user_id: string;
}

/** One row of `CULTURAL_TASK_IDEA_TITLES_SQL`. */
interface CulturalTaskIdeaTitleRow {
  task_id: string;
  idea_id: string;
  title: string;
}

/** One row of `CULTURAL_TASK_GUIDE_TITLES_SQL`. */
interface CulturalTaskGuideTitleRow {
  task_id: string;
  guide_id: string;
  title: string;
}

/** The staff summaries of every distinct id in `userIds`, read in one
 *  `profiles` query that selects the six summary columns only, and one crop
 *  batch over the avatars that are shown. An id with no profile row answers
 *  an empty slug and name. Blank ids are dropped; no id reads nothing. */
export async function readCulturalStaffSummaries(
  manager: EntityManager,
  mediaCrops: MediaCropService,
  userIds: readonly string[],
): Promise<Map<string, CulturalStaffSummaryDTO>> {
  const distinctIds = [...new Set(userIds.filter(Boolean))];
  const summaries = new Map<string, CulturalStaffSummaryDTO>();
  if (distinctIds.length === 0) {
    return summaries;
  }
  const profiles = await manager.find(Profile, {
    where: { userId: In(distinctIds) },
    select: {
      userId: true,
      slug: true,
      firstName: true,
      lastName: true,
      avatarUrl: true,
      photoVisible: true,
    },
  });
  const profileByUserId = new Map<string, CulturalStaffProfileRow>(
    profiles.map((profile) => [
      profile.userId,
      {
        userId: profile.userId,
        slug: profile.slug,
        firstName: profile.firstName,
        lastName: profile.lastName,
        avatarUrl: profile.avatarUrl,
        photoVisible: profile.photoVisible === true,
      },
    ]),
  );
  const crops = await mediaCrops.getMany(
    [...profileByUserId.values()]
      .filter((profile) => profile.photoVisible)
      .map((profile) => profile.avatarUrl)
      .filter((avatarKey): avatarKey is string => Boolean(avatarKey)),
  );
  for (const userId of distinctIds) {
    summaries.set(
      userId,
      toCulturalStaffSummary(
        userId,
        profileByUserId.get(userId) ?? null,
        crops,
      ),
    );
  }
  return summaries;
}

/** The assignee ids and the linked idea and guide of each task in `taskIds`:
 *  one assignee query, one idea title read and one guide title read. Every
 *  requested id gets an entry, with no assignees and no links by default. */
export async function readCulturalTaskLinks(
  manager: EntityManager,
  taskIds: readonly string[],
): Promise<Map<string, CulturalTaskLinks>> {
  const distinctIds = [...new Set(taskIds)];
  const linksByTaskId = new Map<string, CulturalTaskLinks>(
    distinctIds.map((taskId) => [
      taskId,
      { assigneeIds: [], idea: null, guide: null },
    ]),
  );
  if (distinctIds.length === 0) {
    return linksByTaskId;
  }
  const assigneeRows = await manager.query<CulturalTaskAssigneeIdRow[]>(
    CULTURAL_TASK_ASSIGNEE_IDS_SQL,
    [distinctIds],
  );
  const ideaRows = await manager.query<CulturalTaskIdeaTitleRow[]>(
    CULTURAL_TASK_IDEA_TITLES_SQL,
    [distinctIds],
  );
  const guideRows = await manager.query<CulturalTaskGuideTitleRow[]>(
    CULTURAL_TASK_GUIDE_TITLES_SQL,
    [distinctIds],
  );
  for (const row of assigneeRows) {
    linksByTaskId.get(row.task_id)?.assigneeIds.push(row.user_id);
  }
  for (const row of ideaRows) {
    const links = linksByTaskId.get(row.task_id);
    if (links) {
      links.idea = { id: row.idea_id, title: row.title };
    }
  }
  for (const row of guideRows) {
    const links = linksByTaskId.get(row.task_id);
    if (links) {
      links.guide = { id: row.guide_id, title: row.title };
    }
  }
  return linksByTaskId;
}

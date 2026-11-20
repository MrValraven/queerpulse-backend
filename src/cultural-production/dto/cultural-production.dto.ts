import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import {
  CULTURAL_ASSIGNED_TO_FILTERS,
  CULTURAL_EVENT_TYPES,
  CULTURAL_GUIDE_LOCALES,
  CULTURAL_IDEA_STATUSES,
  CULTURAL_TASK_STATUSES,
  CULTURAL_TASK_STATUS_FILTERS,
} from '../cultural-production.constants';

// Every field below is `@Allow()` and typed `unknown`: the decorator keeps the
// property through `whitelist` and validates nothing, so the services own each
// check (`cultural-input.ts`) and a bad value always answers its own reason
// code. A property no class declares still gets the global
// `forbidNonWhitelisted` 400.

/** Query of `GET /admin/cultural-production/staff`. The service trims `q`
 *  and cuts a long one to 100 characters; a blank or repeated `q` previews
 *  five people, so no rule can answer a generic 400. */
export class CulturalStaffSearchQuery {
  @ApiPropertyOptional({
    description:
      'Search text for the staff picker over first name and last name.',
    type: String,
  })
  @Allow()
  q?: unknown;
}

/** Body of `POST /admin/cultural-production/ideas`. The service answers,
 *  first failure wins: `CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`,
 *  `CULTURAL_DESCRIPTION_TOO_LONG`, `CULTURAL_EVENT_TYPE_INVALID`,
 *  `CULTURAL_IDEA_STATUS_INVALID`. */
export class CreateCulturalIdeaDto {
  @ApiPropertyOptional({
    description: 'Required. At most 160 characters after trimming.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'At most 4000 characters. Null reads as empty.',
    type: String,
    nullable: true,
  })
  @Allow()
  description?: unknown;

  @ApiPropertyOptional({
    description: 'Required.',
    enum: [...CULTURAL_EVENT_TYPES],
  })
  @Allow()
  eventType?: unknown;

  @ApiPropertyOptional({
    description: 'Defaults to new.',
    enum: [...CULTURAL_IDEA_STATUSES],
  })
  @Allow()
  status?: unknown;
}

/** Body of `PATCH /admin/cultural-production/ideas/:id`. An absent property
 *  is left as it is. The service answers `CULTURAL_IDEA_NOT_FOUND` for a
 *  malformed id, the create codes for each present field in the create
 *  order, then `CULTURAL_IDEA_NOT_FOUND` for a missing row. */
export class UpdateCulturalIdeaDto {
  @ApiPropertyOptional({
    description: 'At most 160 characters after trimming. Null is refused.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'At most 4000 characters. Null clears it.',
    type: String,
    nullable: true,
  })
  @Allow()
  description?: unknown;

  @ApiPropertyOptional({
    description: 'Null is refused.',
    enum: [...CULTURAL_EVENT_TYPES],
  })
  @Allow()
  eventType?: unknown;

  @ApiPropertyOptional({
    description: 'Null is refused.',
    enum: [...CULTURAL_IDEA_STATUSES],
  })
  @Allow()
  status?: unknown;
}

/** Body of `POST /admin/cultural-production/ideas/:id/comments`. The service
 *  answers `CULTURAL_COMMENT_EMPTY` for a missing, non-string or blank body
 *  and `CULTURAL_COMMENT_TOO_LONG` past 2000 characters. */
export class CulturalCommentDto {
  @ApiProperty({
    description:
      'The comment text. Trimmed at both ends; inner line breaks stay.',
    type: String,
  })
  @Allow()
  body?: unknown;
}

/** Query of `GET /admin/cultural-production/tasks`. The service answers
 *  `CULTURAL_ASSIGNED_TO_INVALID`, then `CULTURAL_TASK_STATUS_INVALID`. A
 *  blank value means no filter. */
export class ListCulturalTasksQuery {
  @ApiPropertyOptional({
    description: 'Only tasks assigned to me, or only unassigned tasks.',
    enum: [...CULTURAL_ASSIGNED_TO_FILTERS],
  })
  @Allow()
  assignedTo?: unknown;

  @ApiPropertyOptional({
    description: 'Only tasks in this status; open is todo and doing.',
    enum: [...CULTURAL_TASK_STATUS_FILTERS],
  })
  @Allow()
  status?: unknown;
}

/** Body of `POST /admin/cultural-production/tasks`. The service answers,
 *  first failure wins: `CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`,
 *  `CULTURAL_NOTES_TOO_LONG`, `CULTURAL_TASK_STATUS_INVALID`,
 *  `CULTURAL_DUE_DATE_INVALID`, `CULTURAL_LINKED_IDEA_NOT_FOUND`,
 *  `CULTURAL_LINKED_GUIDE_NOT_FOUND`, 400 `CULTURAL_ASSIGNEE_NOT_FOUND`,
 *  400 `CULTURAL_TOO_MANY_ASSIGNEES`, then per assignee 404
 *  `CULTURAL_ASSIGNEE_NOT_FOUND` or `CULTURAL_ASSIGNEE_NOT_STAFF`. */
export class CreateCulturalTaskDto {
  @ApiPropertyOptional({
    description: 'Required. At most 160 characters after trimming.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'At most 4000 characters. Null reads as empty.',
    type: String,
    nullable: true,
  })
  @Allow()
  notes?: unknown;

  @ApiPropertyOptional({
    description: 'Defaults to todo.',
    enum: [...CULTURAL_TASK_STATUSES],
  })
  @Allow()
  status?: unknown;

  @ApiPropertyOptional({
    description: 'A YYYY-MM-DD day from 2000-01-01 to 2100-12-31.',
    type: String,
    format: 'date',
    nullable: true,
  })
  @Allow()
  dueOn?: unknown;

  @ApiPropertyOptional({
    description: 'Id of the idea this task belongs to.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Allow()
  ideaId?: unknown;

  @ApiPropertyOptional({
    description: 'Id of the guide this task comes from.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Allow()
  guideId?: unknown;

  @ApiPropertyOptional({
    description: 'User ids to assign, at most 10 distinct.',
    type: [String],
  })
  @Allow()
  assigneeIds?: unknown;
}

/** Body of `PATCH /admin/cultural-production/tasks/:id`. An absent property
 *  is left as it is and assignees never change here. The service answers
 *  `CULTURAL_TASK_NOT_FOUND` for a malformed id, the create codes for each
 *  present field in the create order, then `CULTURAL_TASK_NOT_FOUND`,
 *  `CULTURAL_LINKED_IDEA_NOT_FOUND` and `CULTURAL_LINKED_GUIDE_NOT_FOUND`. */
export class UpdateCulturalTaskDto {
  @ApiPropertyOptional({
    description: 'At most 160 characters after trimming. Null is refused.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'At most 4000 characters. Null clears it.',
    type: String,
    nullable: true,
  })
  @Allow()
  notes?: unknown;

  @ApiPropertyOptional({
    description: 'Null is refused.',
    enum: [...CULTURAL_TASK_STATUSES],
  })
  @Allow()
  status?: unknown;

  @ApiPropertyOptional({
    description:
      'A YYYY-MM-DD day from 2000-01-01 to 2100-12-31. Null clears it.',
    type: String,
    format: 'date',
    nullable: true,
  })
  @Allow()
  dueOn?: unknown;

  @ApiPropertyOptional({
    description: 'Id of the idea this task belongs to. Null unlinks it.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Allow()
  ideaId?: unknown;

  @ApiPropertyOptional({
    description: 'Id of the guide this task comes from. Null unlinks it.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @Allow()
  guideId?: unknown;
}

/** Body of `POST /admin/cultural-production/tasks/:id/assignees`. The
 *  service answers 400 `CULTURAL_ASSIGNEE_NOT_FOUND` for a missing or
 *  malformed id. */
export class AssignCulturalTaskDto {
  @ApiProperty({
    description: 'The user id of the staff member to assign.',
    type: String,
    format: 'uuid',
  })
  @Allow()
  userId?: unknown;
}

/** Body of `POST /admin/cultural-production/guides`. The service answers,
 *  first failure wins: `CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`,
 *  `CULTURAL_EVENT_TYPE_INVALID`, `CULTURAL_GUIDE_LOCALE_INVALID`,
 *  `CULTURAL_GUIDE_SUMMARY_TOO_LONG`, then the section codes. */
export class CreateCulturalGuideDto {
  @ApiPropertyOptional({
    description: 'Required. At most 160 characters after trimming.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'Required.',
    enum: [...CULTURAL_EVENT_TYPES],
  })
  @Allow()
  eventType?: unknown;

  @ApiPropertyOptional({
    description: 'Required. The language the guide is written in.',
    enum: [...CULTURAL_GUIDE_LOCALES],
  })
  @Allow()
  locale?: unknown;

  @ApiPropertyOptional({
    description: 'At most 500 characters. Null reads as empty.',
    type: String,
    nullable: true,
  })
  @Allow()
  summary?: unknown;

  @ApiPropertyOptional({
    description:
      'At most 30 sections, each with a heading, a body and at most 40 steps; at most 100 steps in all. Defaults to none.',
    type: 'array',
    items: { type: 'object' },
  })
  @Allow()
  sections?: unknown;
}

/** Body of `PUT /admin/cultural-production/guides/:id`. The service answers
 *  `CULTURAL_GUIDE_NOT_FOUND` for a malformed id, then
 *  `CULTURAL_GUIDE_REVISION_INVALID`, the create codes in the create order,
 *  then `CULTURAL_GUIDE_EDIT_CONFLICT` or `CULTURAL_GUIDE_NOT_FOUND`. */
export class ReplaceCulturalGuideDto {
  @ApiPropertyOptional({
    description: 'Required. The revision the edit started from.',
    type: Number,
    minimum: 1,
  })
  @Allow()
  revision?: unknown;

  @ApiPropertyOptional({
    description: 'Required. At most 160 characters after trimming.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'Required.',
    enum: [...CULTURAL_EVENT_TYPES],
  })
  @Allow()
  eventType?: unknown;

  @ApiPropertyOptional({
    description: 'Required. The language the guide is written in.',
    enum: [...CULTURAL_GUIDE_LOCALES],
  })
  @Allow()
  locale?: unknown;

  @ApiPropertyOptional({
    description: 'At most 500 characters. Null reads as empty.',
    type: String,
    nullable: true,
  })
  @Allow()
  summary?: unknown;

  @ApiPropertyOptional({
    description:
      'Required. Replaces every section. At most 30 sections, each with at most 40 steps; at most 100 steps in all.',
    type: 'array',
    items: { type: 'object' },
  })
  @Allow()
  sections?: unknown;
}

/** Body of `POST /admin/cultural-production/guides/:id/task-batches`. The
 *  service answers `CULTURAL_GUIDE_NOT_FOUND` for a malformed id, then
 *  `CULTURAL_EVENT_DATE_INVALID`, 400 `CULTURAL_ASSIGNEE_NOT_FOUND`, 400
 *  `CULTURAL_TOO_MANY_ASSIGNEES`, `CULTURAL_GUIDE_NOT_FOUND`,
 *  `CULTURAL_GUIDE_HAS_NO_STEPS`, then per assignee 404
 *  `CULTURAL_ASSIGNEE_NOT_FOUND` or `CULTURAL_ASSIGNEE_NOT_STAFF`. */
export class CreateCulturalTaskBatchDto {
  @ApiPropertyOptional({
    description:
      'Required. The YYYY-MM-DD day of the event, from 2000-01-01 to 2100-12-31.',
    type: String,
    format: 'date',
  })
  @Allow()
  eventOn?: unknown;

  @ApiPropertyOptional({
    description: 'User ids to assign to every new task, at most 10 distinct.',
    type: [String],
  })
  @Allow()
  assigneeIds?: unknown;
}

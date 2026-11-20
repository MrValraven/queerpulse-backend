import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { CulturalGuidesService } from './cultural-guides.service';
import { CulturalIdeasService } from './cultural-ideas.service';
import { CulturalTasksService } from './cultural-tasks.service';
import {
  AssignCulturalTaskDto,
  CreateCulturalGuideDto,
  CreateCulturalIdeaDto,
  CreateCulturalTaskBatchDto,
  CreateCulturalTaskDto,
  CulturalCommentDto,
  CulturalStaffSearchQuery,
  ListCulturalTasksQuery,
  ReplaceCulturalGuideDto,
  UpdateCulturalIdeaDto,
  UpdateCulturalTaskDto,
} from './dto/cultural-production.dto';

/** Swagger text of the idea field codes, in check order. */
const CULTURAL_IDEA_FIELD_CODES =
  '`CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`, `CULTURAL_DESCRIPTION_TOO_LONG`, `CULTURAL_EVENT_TYPE_INVALID`, `CULTURAL_IDEA_STATUS_INVALID`';

/** Swagger text of the task field codes, in check order. */
const CULTURAL_TASK_FIELD_CODES =
  '`CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`, `CULTURAL_NOTES_TOO_LONG`, `CULTURAL_TASK_STATUS_INVALID`, `CULTURAL_DUE_DATE_INVALID`, `CULTURAL_LINKED_IDEA_NOT_FOUND` (malformed `ideaId`), `CULTURAL_LINKED_GUIDE_NOT_FOUND` (malformed `guideId`)';

/** Swagger text of the assignee list codes a body can answer with 400. */
const CULTURAL_ASSIGNEE_LIST_CODES =
  '`CULTURAL_ASSIGNEE_NOT_FOUND` (`assigneeIds` is no array, or an item is no uuid), `CULTURAL_TOO_MANY_ASSIGNEES` (more than 10 distinct ids)';

/** Swagger text of the guide field codes, in check order. */
const CULTURAL_GUIDE_FIELD_CODES =
  '`CULTURAL_TITLE_REQUIRED`, `CULTURAL_TITLE_TOO_LONG`, `CULTURAL_EVENT_TYPE_INVALID`, `CULTURAL_GUIDE_LOCALE_INVALID`, `CULTURAL_GUIDE_SUMMARY_TOO_LONG`';

/** Swagger text of the guide section codes, in check order. */
const CULTURAL_GUIDE_SECTION_CODES =
  '`CULTURAL_GUIDE_SECTIONS_INVALID` (with `sectionIndex` and `stepIndex` when known), `CULTURAL_GUIDE_TOO_MANY_SECTIONS`, `CULTURAL_GUIDE_HEADING_REQUIRED`, `CULTURAL_GUIDE_HEADING_TOO_LONG`, `CULTURAL_GUIDE_BODY_TOO_LONG` (each with `sectionIndex`), `CULTURAL_GUIDE_TOO_MANY_STEPS` (with `sectionIndex` for one section, none for the whole guide), `CULTURAL_GUIDE_STEP_TEXT_REQUIRED`, `CULTURAL_GUIDE_STEP_TEXT_TOO_LONG`, `CULTURAL_GUIDE_STEP_DAYS_INVALID` (each with `sectionIndex` and `stepIndex`)';

/** Swagger text of the per-assignee codes a body list answers inside the transaction. */
const CULTURAL_ASSIGNEE_ELIGIBILITY_CODES =
  'then, for each id in array order, `CULTURAL_ASSIGNEE_NOT_FOUND` (404, with `userId`) or `CULTURAL_ASSIGNEE_NOT_STAFF` (400, with `reason` `no_access`, `suspended` or `deactivated` and `userId`)';

/**
 * The staff Cultural Production page: ideas staff back and comment on, tasks
 * with several assignees, due days and links to an idea and a guide, event
 * guides made of sections with checklists, and a guide-to-task-list batch.
 *
 * Moderator and Admin tiers, or the `cultural_producer` or
 * `music_manager_producer` staff grant. The class carries
 * `@Roles(UserRole.Moderator, UserRole.Admin)` and
 * `@StaffRoles('cultural_producer', 'music_manager_producer')`, so
 * `RolesOrStaffGuard` lets a Moderator or an Admin through on the tier and a
 * grant holder through on either grant. No handler adds a role or a grant. The
 * class carries no feature tag and no analytics or cache interceptor, and
 * Cultural Production paths are kept out of the request log, metrics and
 * Sentry (`cultural-production-request-log.ts`).
 *
 * Route table, in declaration order:
 *
 *   GET    staff                          staff picker: 5 with a blank `q`,
 *                                         the caller first; 20 with a typed `q`
 *   GET    tasks/due-count                nav badge count: open tasks due
 *                                         today or earlier, assigned to the
 *                                         caller
 *   GET    ideas                          every idea, newest first
 *   POST   ideas                          add an idea
 *   GET    ideas/:id                      one idea with backers, comments and
 *                                         linked tasks
 *   PATCH  ideas/:id                      change an idea
 *   DELETE ideas/:id                      delete an idea
 *   PUT    ideas/:id/backing              back an idea
 *   DELETE ideas/:id/backing               stop backing an idea
 *   POST   ideas/:id/comments             comment on an idea
 *   DELETE ideas/:id/comments/:commentId  delete a comment
 *   GET    tasks                          tasks under the two filters
 *   POST   tasks                          add a task
 *   GET    tasks/:id                      one task
 *   PATCH  tasks/:id                      change a task
 *   DELETE tasks/:id                      delete a task
 *   POST   tasks/:id/assignees            assign a staff member
 *   DELETE tasks/:id/assignees/:userId    take a staff member off
 *   GET    guides                         every guide, without sections
 *   POST   guides                         add a guide
 *   GET    guides/:id                     one guide with its sections
 *   PUT    guides/:id                     replace a guide (revision checked)
 *   DELETE guides/:id                     delete a guide
 *   POST   guides/:id/task-batches        one task per checklist step
 *
 * Reason codes per route, in check order:
 *
 *   GET    staff, tasks/due-count, ideas, guides
 *                        none
 *   POST   ideas         the idea field codes
 *   GET    ideas/:id     CULTURAL_IDEA_NOT_FOUND
 *   PATCH  ideas/:id     CULTURAL_IDEA_NOT_FOUND (malformed id), the idea
 *                        field codes, CULTURAL_IDEA_NOT_FOUND
 *   DELETE ideas/:id     CULTURAL_IDEA_NOT_FOUND, CULTURAL_IDEA_NOT_YOURS
 *   PUT    ideas/:id/backing, DELETE ideas/:id/backing
 *                        CULTURAL_IDEA_NOT_FOUND
 *   POST   ideas/:id/comments
 *                        CULTURAL_IDEA_NOT_FOUND (malformed id),
 *                        CULTURAL_COMMENT_EMPTY, CULTURAL_COMMENT_TOO_LONG,
 *                        CULTURAL_IDEA_NOT_FOUND
 *   DELETE ideas/:id/comments/:commentId
 *                        CULTURAL_IDEA_NOT_FOUND (malformed id),
 *                        CULTURAL_COMMENT_NOT_FOUND (malformed comment id),
 *                        CULTURAL_IDEA_NOT_FOUND, CULTURAL_COMMENT_NOT_FOUND,
 *                        CULTURAL_COMMENT_NOT_YOURS
 *   GET    tasks         CULTURAL_ASSIGNED_TO_INVALID,
 *                        CULTURAL_TASK_STATUS_INVALID
 *   POST   tasks         the task field codes, CULTURAL_ASSIGNEE_NOT_FOUND
 *                        (400), CULTURAL_TOO_MANY_ASSIGNEES (400), then
 *                        CULTURAL_LINKED_IDEA_NOT_FOUND,
 *                        CULTURAL_LINKED_GUIDE_NOT_FOUND, and per assignee
 *                        CULTURAL_ASSIGNEE_NOT_FOUND (404, with `userId`) or
 *                        CULTURAL_ASSIGNEE_NOT_STAFF (with `reason`, `userId`)
 *   GET    tasks/:id     CULTURAL_TASK_NOT_FOUND
 *   PATCH  tasks/:id     CULTURAL_TASK_NOT_FOUND (malformed id), the task
 *                        field codes, CULTURAL_TASK_NOT_FOUND,
 *                        CULTURAL_LINKED_IDEA_NOT_FOUND,
 *                        CULTURAL_LINKED_GUIDE_NOT_FOUND
 *   DELETE tasks/:id     CULTURAL_TASK_NOT_FOUND, CULTURAL_TASK_NOT_YOURS
 *   POST   tasks/:id/assignees
 *                        CULTURAL_TASK_NOT_FOUND (malformed id),
 *                        CULTURAL_ASSIGNEE_NOT_FOUND (400, malformed body
 *                        id), CULTURAL_TASK_NOT_FOUND,
 *                        CULTURAL_ASSIGNEE_NOT_FOUND (404),
 *                        CULTURAL_ASSIGNEE_NOT_STAFF with `reason`,
 *                        CULTURAL_TOO_MANY_ASSIGNEES (409)
 *   DELETE tasks/:id/assignees/:userId
 *                        CULTURAL_TASK_NOT_FOUND (malformed id),
 *                        CULTURAL_ASSIGNEE_NOT_FOUND (404, malformed user
 *                        id), CULTURAL_TASK_NOT_FOUND
 *   POST   guides        the guide field codes, the section codes
 *   GET    guides/:id    CULTURAL_GUIDE_NOT_FOUND
 *   PUT    guides/:id    CULTURAL_GUIDE_NOT_FOUND (malformed id),
 *                        CULTURAL_GUIDE_REVISION_INVALID, the guide field
 *                        codes, the section codes,
 *                        CULTURAL_GUIDE_EDIT_CONFLICT (with `revision`),
 *                        CULTURAL_GUIDE_NOT_FOUND
 *   DELETE guides/:id    CULTURAL_GUIDE_NOT_FOUND, CULTURAL_GUIDE_NOT_YOURS
 *   POST   guides/:id/task-batches
 *                        CULTURAL_GUIDE_NOT_FOUND (malformed id),
 *                        CULTURAL_EVENT_DATE_INVALID,
 *                        CULTURAL_ASSIGNEE_NOT_FOUND (400),
 *                        CULTURAL_TOO_MANY_ASSIGNEES (400),
 *                        CULTURAL_GUIDE_NOT_FOUND, CULTURAL_GUIDE_HAS_NO_STEPS,
 *                        and per assignee CULTURAL_ASSIGNEE_NOT_FOUND (404,
 *                        with `userId`) or CULTURAL_ASSIGNEE_NOT_STAFF (with
 *                        `reason`, `userId`)
 *
 * `:id`, `:commentId` and `:userId` are plain strings: the services check the
 * uuid shape and answer the route's not-found code, so no pipe can answer a
 * generic 400. The literal `staff` and `tasks/due-count` routes are declared
 * before every `:id` route so Nest matches the literal. Comments and assignees
 * answer 200 (the refreshed idea or task); the batch answers 201.
 */
@ApiTags('Admin - Cultural Production')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the moderator or admin tier, or the cultural_producer or music_manager_producer staff grant.',
})
@Controller('admin/cultural-production')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('cultural_producer', 'music_manager_producer')
export class AdminCulturalProductionController {
  constructor(
    private readonly culturalIdeas: CulturalIdeasService,
    private readonly culturalTasks: CulturalTasksService,
    private readonly culturalGuides: CulturalGuidesService,
  ) {}

  @Get('staff')
  @ApiOperation({
    summary: 'Search staff to assign a task',
    description:
      'Active people with Cultural Production access, matched on first name and last name. A blank `q` previews 5 people, the caller first; a typed `q` answers at most 20 matches, and a `q` over 100 characters is cut to its first 100.',
  })
  @ApiOkResponse({ description: '`{ items }`, the matching staff summaries.' })
  searchStaff(
    @Query() query: CulturalStaffSearchQuery,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.searchStaff(query.q, user);
  }

  @Get('tasks/due-count')
  @ApiOperation({
    summary: 'Count the tasks behind the nav badge',
    description:
      'Tasks in todo or doing whose due day is today or earlier, read in Europe/Lisbon, that are assigned to the caller.',
  })
  @ApiOkResponse({ description: '`{ count }`.' })
  dueCount(@CurrentUser() user: CurrentUserData) {
    return this.culturalTasks.dueCount(user);
  }

  @Get('ideas')
  @ApiOperation({
    summary: 'List ideas',
    description:
      'Every idea, newest first, at most 500, each with its first 5 backers, the backer count, the comment count and the linked task count. `isTruncated` is true when more exist.',
  })
  @ApiOkResponse({ description: '`{ items, isTruncated }`.' })
  listIdeas(@CurrentUser() user: CurrentUserData) {
    return this.culturalIdeas.listIdeas(user);
  }

  @Post('ideas')
  @ApiOperation({
    summary: 'Add an idea',
    description:
      'The caller is the author. `status` defaults to new and `description` to an empty text.',
  })
  @ApiCreatedResponse({ description: 'The new idea.' })
  @ApiBadRequestResponse({
    description: `Code ${CULTURAL_IDEA_FIELD_CODES}, checked in this order.`,
  })
  createIdea(
    @Body() body: CreateCulturalIdeaDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.createIdea(body, user);
  }

  @Get('ideas/:id')
  @ApiOperation({
    summary: 'Load an idea',
    description:
      'The idea, every backer, every comment (oldest first) and its linked tasks.',
  })
  @ApiOkResponse({ description: 'The idea.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: no idea has that id, or it is no uuid.',
  })
  getIdea(@Param('id') ideaId: string, @CurrentUser() user: CurrentUserData) {
    return this.culturalIdeas.getIdea(ideaId, user);
  }

  @Patch('ideas/:id')
  @ApiOperation({
    summary: 'Change an idea',
    description:
      'An absent property is left as it is. A body with no known property answers the idea unchanged.',
  })
  @ApiOkResponse({ description: 'The refreshed idea.' })
  @ApiBadRequestResponse({
    description: `Code ${CULTURAL_IDEA_FIELD_CODES}, checked in this order over the properties sent.`,
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: the id is no uuid (checked first), or no idea has it (checked after the fields).',
  })
  updateIdea(
    @Param('id') ideaId: string,
    @Body() body: UpdateCulturalIdeaDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.updateIdea(ideaId, body, user);
  }

  @Delete('ideas/:id')
  @ApiOperation({
    summary: 'Delete an idea',
    description:
      'Its author, a Moderator or an Admin can delete an idea. Its backers and comments go with it; its tasks stay, unlinked.',
  })
  @ApiOkResponse({ description: '`{ ok: true }`.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: no idea has that id, or it is no uuid.',
  })
  @ApiForbiddenResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_YOURS`: the caller did not write the idea and is no Moderator or Admin. Without a code: the caller lacks the moderator or admin tier and both staff grants.',
  })
  deleteIdea(
    @Param('id') ideaId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.deleteIdea(ideaId, user);
  }

  @Put('ideas/:id/backing')
  @ApiOperation({
    summary: 'Back an idea',
    description:
      'Adds the caller to the backers. Backing twice changes nothing. No body.',
  })
  @ApiOkResponse({ description: 'The refreshed idea.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: no idea has that id, or it is no uuid.',
  })
  backIdea(@Param('id') ideaId: string, @CurrentUser() user: CurrentUserData) {
    return this.culturalIdeas.backIdea(ideaId, user);
  }

  @Delete('ideas/:id/backing')
  @ApiOperation({
    summary: 'Stop backing an idea',
    description:
      'Removes the caller from the backers. Removing a backing that does not exist changes nothing.',
  })
  @ApiOkResponse({ description: 'The refreshed idea.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: no idea has that id, or it is no uuid.',
  })
  unbackIdea(
    @Param('id') ideaId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.unbackIdea(ideaId, user);
  }

  @Post('ideas/:id/comments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Comment on an idea',
    description: 'The caller is the author of the comment.',
  })
  @ApiOkResponse({ description: 'The refreshed idea with its comments.' })
  @ApiBadRequestResponse({
    description:
      'Code `CULTURAL_COMMENT_EMPTY` or `CULTURAL_COMMENT_TOO_LONG`, checked in this order.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND`: the id is no uuid (checked first), or no idea has it (checked after the body).',
  })
  addComment(
    @Param('id') ideaId: string,
    @Body() body: CulturalCommentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.addComment(ideaId, body, user);
  }

  @Delete('ideas/:id/comments/:commentId')
  @ApiOperation({
    summary: 'Delete a comment on an idea',
    description: 'Its author, a Moderator or an Admin can delete a comment.',
  })
  @ApiOkResponse({ description: 'The refreshed idea with its comments.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_IDEA_NOT_FOUND` (malformed id), `CULTURAL_COMMENT_NOT_FOUND` (malformed comment id), `CULTURAL_IDEA_NOT_FOUND` (no idea has the id) or `CULTURAL_COMMENT_NOT_FOUND` (no comment on that idea has the id), checked in this order.',
  })
  @ApiForbiddenResponse({
    description:
      'Code `CULTURAL_COMMENT_NOT_YOURS`: the caller did not write the comment and is no Moderator or Admin. Without a code: the caller lacks the moderator or admin tier and both staff grants.',
  })
  deleteComment(
    @Param('id') ideaId: string,
    @Param('commentId') commentId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalIdeas.deleteComment(ideaId, commentId, user);
  }

  @Get('tasks')
  @ApiOperation({
    summary: 'List tasks',
    description:
      'Tasks under the `assignedTo` (me or unassigned) and `status` (open, todo, doing or done) filters, open tasks first by due day, at most 500. `counts` counts todo, doing and done under `assignedTo` alone.',
  })
  @ApiOkResponse({ description: '`{ items, counts, isTruncated }`.' })
  @ApiBadRequestResponse({
    description:
      'Code `CULTURAL_ASSIGNED_TO_INVALID` or `CULTURAL_TASK_STATUS_INVALID`, checked in this order.',
  })
  listTasks(
    @Query() query: ListCulturalTasksQuery,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.listTasks(query, user);
  }

  @Post('tasks')
  @ApiOperation({
    summary: 'Add a task',
    description:
      'The caller is the author and assigns every id in `assigneeIds`. Each assignee other than the caller gets a notice.',
  })
  @ApiCreatedResponse({ description: 'The new task.' })
  @ApiBadRequestResponse({
    description: `Code ${CULTURAL_TASK_FIELD_CODES}, ${CULTURAL_ASSIGNEE_LIST_CODES}, then \`CULTURAL_LINKED_IDEA_NOT_FOUND\` or \`CULTURAL_LINKED_GUIDE_NOT_FOUND\` (no row has the id), ${CULTURAL_ASSIGNEE_ELIGIBILITY_CODES}.`,
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_ASSIGNEE_NOT_FOUND` with `userId`: no account has that id.',
  })
  createTask(
    @Body() body: CreateCulturalTaskDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.createTask(body, user);
  }

  @Get('tasks/:id')
  @ApiOperation({
    summary: 'Load a task',
    description:
      'The task with its assignees and its linked idea and guide titles.',
  })
  @ApiOkResponse({ description: 'The task.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_TASK_NOT_FOUND`: no task has that id, or it is no uuid.',
  })
  getTask(@Param('id') taskId: string, @CurrentUser() user: CurrentUserData) {
    return this.culturalTasks.getTask(taskId, user);
  }

  @Patch('tasks/:id')
  @ApiOperation({
    summary: 'Change a task',
    description:
      'An absent property is left as it is. Moving into done stamps `completedAt`; moving out of done clears it. Assignees change through the assignee routes only.',
  })
  @ApiOkResponse({ description: 'The refreshed task.' })
  @ApiBadRequestResponse({
    description: `Code ${CULTURAL_TASK_FIELD_CODES}, checked in this order over the properties sent, then \`CULTURAL_LINKED_IDEA_NOT_FOUND\` or \`CULTURAL_LINKED_GUIDE_NOT_FOUND\` (no row has the id).`,
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_TASK_NOT_FOUND`: the id is no uuid (checked first), or no task has it (checked after the fields).',
  })
  updateTask(
    @Param('id') taskId: string,
    @Body() body: UpdateCulturalTaskDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.updateTask(taskId, body, user);
  }

  @Delete('tasks/:id')
  @ApiOperation({
    summary: 'Delete a task',
    description:
      'Its author, a Moderator or an Admin can delete a task. Its assignees go with it.',
  })
  @ApiOkResponse({ description: '`{ ok: true }`.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_TASK_NOT_FOUND`: no task has that id, or it is no uuid.',
  })
  @ApiForbiddenResponse({
    description:
      'Code `CULTURAL_TASK_NOT_YOURS`: the caller did not write the task and is no Moderator or Admin. Without a code: the caller lacks the moderator or admin tier and both staff grants.',
  })
  deleteTask(
    @Param('id') taskId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.deleteTask(taskId, user);
  }

  @Post('tasks/:id/assignees')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign a staff member to a task',
    description:
      'Adds the person to the task assignees. Assigning someone already on the task changes nothing. The person gets a notice unless they assigned themselves.',
  })
  @ApiOkResponse({ description: 'The refreshed task.' })
  @ApiBadRequestResponse({
    description:
      'Code `CULTURAL_ASSIGNEE_NOT_FOUND` when `userId` is missing or no uuid, or `CULTURAL_ASSIGNEE_NOT_STAFF` with `reason` `no_access`, `suspended` or `deactivated`.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_TASK_NOT_FOUND` or `CULTURAL_ASSIGNEE_NOT_FOUND`: the task is gone or its id is no uuid, or no account has the `userId`.',
  })
  @ApiConflictResponse({
    description:
      'Code `CULTURAL_TOO_MANY_ASSIGNEES`: the task already has 10 people assigned.',
  })
  assignTask(
    @Param('id') taskId: string,
    @Body() body: AssignCulturalTaskDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.assign(taskId, body, user);
  }

  @Delete('tasks/:id/assignees/:userId')
  @ApiOperation({
    summary: 'Take a staff member off a task',
    description:
      'Removes the person from the task assignees. Removing someone who is not assigned changes nothing. No notice.',
  })
  @ApiOkResponse({ description: 'The refreshed task.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_TASK_NOT_FOUND` (malformed id), `CULTURAL_ASSIGNEE_NOT_FOUND` (malformed `:userId`) or `CULTURAL_TASK_NOT_FOUND` (no task has the id), checked in this order.',
  })
  unassignTask(
    @Param('id') taskId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.unassign(taskId, userId, user);
  }

  @Get('guides')
  @ApiOperation({
    summary: 'List guides',
    description:
      'Every guide by event type, locale and title, each with its section and step counts. The list carries no sections.',
  })
  @ApiOkResponse({ description: '`{ items }`.' })
  listGuides(@CurrentUser() user: CurrentUserData) {
    return this.culturalGuides.listGuides(user);
  }

  @Post('guides')
  @ApiOperation({
    summary: 'Add a guide',
    description:
      'The caller is the author. `sections` defaults to an empty list and the revision starts at 1.',
  })
  @ApiCreatedResponse({ description: 'The new guide with its sections.' })
  @ApiBadRequestResponse({
    description: `Code ${CULTURAL_GUIDE_FIELD_CODES}, then ${CULTURAL_GUIDE_SECTION_CODES}, checked in this order.`,
  })
  createGuide(
    @Body() body: CreateCulturalGuideDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalGuides.createGuide(body, user);
  }

  @Get('guides/:id')
  @ApiOperation({
    summary: 'Load a guide',
    description: 'The guide with its sections, steps and current revision.',
  })
  @ApiOkResponse({ description: 'The guide with its sections.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_GUIDE_NOT_FOUND`: no guide has that id, or it is no uuid.',
  })
  getGuide(@Param('id') guideId: string, @CurrentUser() user: CurrentUserData) {
    return this.culturalGuides.getGuide(guideId, user);
  }

  @Put('guides/:id')
  @ApiOperation({
    summary: 'Replace a guide',
    description:
      'Sends the whole guide with the revision the edit started from. The save lands only while that revision is current, and it moves the revision up by 1.',
  })
  @ApiOkResponse({ description: 'The saved guide with its sections.' })
  @ApiBadRequestResponse({
    description: `Code \`CULTURAL_GUIDE_REVISION_INVALID\`, ${CULTURAL_GUIDE_FIELD_CODES}, then ${CULTURAL_GUIDE_SECTION_CODES}, checked in this order.`,
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_GUIDE_NOT_FOUND`: the id is no uuid (checked first), or no guide has it (checked after the fields).',
  })
  @ApiConflictResponse({
    description:
      'Code `CULTURAL_GUIDE_EDIT_CONFLICT` with the current `revision`: someone saved the guide after the edit started.',
  })
  replaceGuide(
    @Param('id') guideId: string,
    @Body() body: ReplaceCulturalGuideDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalGuides.replaceGuide(guideId, body, user);
  }

  @Delete('guides/:id')
  @ApiOperation({
    summary: 'Delete a guide',
    description:
      'Its author, a Moderator or an Admin can delete a guide. Its tasks stay, unlinked.',
  })
  @ApiOkResponse({ description: '`{ ok: true }`.' })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_GUIDE_NOT_FOUND`: no guide has that id, or it is no uuid.',
  })
  @ApiForbiddenResponse({
    description:
      'Code `CULTURAL_GUIDE_NOT_YOURS`: the caller did not write the guide and is no Moderator or Admin. Without a code: the caller lacks the moderator or admin tier and both staff grants.',
  })
  deleteGuide(
    @Param('id') guideId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalGuides.deleteGuide(guideId, user);
  }

  @Post('guides/:id/task-batches')
  @ApiOperation({
    summary: 'Turn a guide into a task list',
    description:
      'Creates one todo task per checklist step, sections and steps in guide order, each due `daysBefore` days before `eventOn` (no due day when `daysBefore` is null), and assigns every id in `assigneeIds` to every new task. Each assignee other than the caller gets one notice for the whole batch.',
  })
  @ApiCreatedResponse({
    description: '`{ items }`, the new tasks in creation order.',
  })
  @ApiBadRequestResponse({
    description: `Code \`CULTURAL_EVENT_DATE_INVALID\`, ${CULTURAL_ASSIGNEE_LIST_CODES}, then \`CULTURAL_GUIDE_HAS_NO_STEPS\`, ${CULTURAL_ASSIGNEE_ELIGIBILITY_CODES}.`,
  })
  @ApiNotFoundResponse({
    description:
      'Code `CULTURAL_GUIDE_NOT_FOUND` (the id is no uuid, or no guide has it) or `CULTURAL_ASSIGNEE_NOT_FOUND` with `userId` (no account has that id).',
  })
  createTaskBatch(
    @Param('id') guideId: string,
    @Body() body: CreateCulturalTaskBatchDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.culturalTasks.createFromGuide(guideId, body, user);
  }
}

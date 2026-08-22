import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { RoadmapAdminService, RoadmapActor } from './roadmap-admin.service';
import { SubmitIdeaDto } from './dto/submit-idea.dto';
import { CreateRoadmapItemDto } from './dto/create-roadmap-item.dto';
import { UpdateRoadmapItemDto } from './dto/update-roadmap-item.dto';
import { UpdateIdeaDto } from './dto/update-idea.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UpdateDepsDto } from './dto/update-deps.dto';
import { ArchiveItemDto } from './dto/archive-item.dto';
import { NotifyVotersDto } from './dto/notify-voters.dto';
import { BulkItemsDto } from './dto/bulk-items.dto';
import { MergeIdeaDto } from './dto/merge-idea.dto';
import { DeclineIdeaDto } from './dto/decline-idea.dto';
import {
  CreateTeamMemberDto,
  UpdateTeamMemberDto,
} from './dto/team-member.dto';
import { AuditQueryDto } from './dto/audit-query.dto';

/**
 * Admin CRUD behind `/admin/roadmap` — items (with the slip/safety guards,
 * dependencies, duplication, archiving, voter notifications, bulk actions),
 * ideas (including moderating member-submitted pending ones), the team
 * roster, the audit trail, and the hero-stats singleton.
 *
 * These handlers used to live on `RoadmapController` under an `admin/*` path
 * prefix, each repeating its own `@UseGuards(RolesGuard) @Roles(...)` on top
 * of a member-facing class — one forgotten decorator would have exposed an
 * admin route to every active member (BE-COM-14). They now sit on a dedicated
 * `Admin*Controller` with class-level default-deny, matching every other
 * admin surface in the repo (`AdminForumController`,
 * `AdminReadingGroupProposalsController`).
 *
 * Member voting/idea submission stays on `RoadmapController`; public reads
 * live in `RoadmapPublicController` (`ActiveMemberGuard` does not honor
 * `@Public()`).
 *
 * Route order note: `PATCH items/bulk` is declared BEFORE `PATCH items/:id` —
 * both are same-verb paths of the same segment count, and Nest/Express
 * matches routes in registration order, so a `:id` route declared first would
 * swallow `bulk` as `id: 'bulk'`. Every other route either differs in segment
 * count from `items/:id`/`ideas/:id`/`team/:id` (e.g. `.../:id/deps`) or uses
 * a literal that never collides with a param segment at the same position
 * (`audit` vs. `audit.csv` are two distinct literal segments), so no other
 * reordering is required.
 */
@Feature('roadmap')
@ApiTags('Admin — Roadmap')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
@ApiForbiddenResponse({
  description:
    'Caller is not an active member or lacks the admin/moderator role.',
})
@Controller('admin/roadmap')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin, UserRole.Moderator)
export class AdminRoadmapController {
  constructor(private readonly adminService: RoadmapAdminService) {}

  // Only the caller's id is threaded through: `RoadmapAdminService` resolves
  // the audit trail's display label from `profiles` itself. The email on
  // `CurrentUserData` is deliberately NOT passed — it used to be written
  // into `roadmap_audit_log.actor_label` and handed to every Moderator
  // through the audit feed and its CSV (BE-COM-28).
  private toActor(user: CurrentUserData): RoadmapActor {
    return { actorId: user.userId };
  }

  @ApiOperation({ summary: 'Get the full admin roadmap board' })
  @ApiOkResponse({
    description:
      'All items and ideas (any status) with vote counts and hero stats.',
  })
  @Get()
  admin() {
    return this.adminService.getAdmin();
  }

  @ApiOperation({ summary: 'Create a roadmap item' })
  @ApiCreatedResponse({ description: 'The created roadmap item.' })
  @Post('items')
  createItem(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateRoadmapItemDto,
  ) {
    return this.adminService.createItem(dto, this.toActor(user));
  }

  // Declared BEFORE `PATCH items/:id` — see the class-level route
  // order note.
  @ApiOperation({
    summary: 'Apply one action (move/show/hide/archive/delete) to many items',
  })
  @ApiOkResponse({
    description: 'How many items the action actually applied to.',
  })
  @Patch('items/bulk')
  bulkItems(@CurrentUser() user: CurrentUserData, @Body() dto: BulkItemsDto) {
    return this.adminService.bulkItems(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a roadmap item' })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Patch('items/:id')
  updateItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoadmapItemDto,
  ) {
    return this.adminService.updateItem(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Delete a roadmap item and its votes' })
  @ApiOkResponse({ description: 'The item was deleted.' })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Delete('items/:id')
  deleteItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.deleteItem(id, this.toActor(user));
  }

  @ApiOperation({ summary: "Add or remove one of an item's dependency edges" })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiNotFoundResponse({
    description:
      "No roadmap item with that id, or no dependency target with `add`'s id.",
  })
  @Patch('items/:id/deps')
  updateDeps(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepsDto,
  ) {
    return this.adminService.updateDeps(id, dto, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Duplicate a roadmap item as a fresh, unpublished draft',
  })
  @ApiCreatedResponse({ description: 'The newly created duplicate item.' })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Post('items/:id/duplicate')
  duplicateItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.duplicateItem(id, this.toActor(user));
  }

  @ApiOperation({ summary: 'Archive or restore a roadmap item' })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Patch('items/:id/archive')
  archiveItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ArchiveItemDto,
  ) {
    return this.adminService.archiveItem(id, dto.archived, this.toActor(user));
  }

  @ApiOperation({ summary: 'Notify every voter on an item with a message' })
  @ApiCreatedResponse({
    description: 'How many voters were actually notified.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Post('items/:id/notify')
  notifyVoters(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotifyVotersDto,
  ) {
    return this.adminService.notifyVoters(id, dto, this.toActor(user));
  }

  // Reuses `SubmitIdeaDto` — there is no separate `CreateIdeaDto`; the admin
  // service publishes the idea directly instead of leaving it `pending`.
  @ApiOperation({ summary: 'Create a published roadmap idea (admin-authored)' })
  @ApiCreatedResponse({ description: 'The created idea.' })
  @Post('ideas')
  createIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.adminService.createIdea(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a roadmap idea (moderate, edit, reorder)' })
  @ApiOkResponse({ description: 'The updated idea.' })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Patch('ideas/:id')
  updateIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIdeaDto,
  ) {
    return this.adminService.updateIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Delete a roadmap idea and its votes' })
  @ApiOkResponse({ description: 'The idea was deleted.' })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Delete('ideas/:id')
  deleteIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.deleteIdea(id, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Promote a pending/published idea into a backlog item',
  })
  @ApiCreatedResponse({ description: 'The newly created roadmap item.' })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Post('ideas/:id/promote')
  promoteIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.promoteIdea(id, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Merge an idea into an existing item, carrying its votes',
  })
  @ApiCreatedResponse({ description: 'The item the idea was merged into.' })
  @ApiNotFoundResponse({
    description:
      'No roadmap idea with that id, or no merge target item with `intoItemId`.',
  })
  @Post('ideas/:id/merge')
  mergeIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MergeIdeaDto,
  ) {
    return this.adminService.mergeIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Decline a pending idea as "not building this, and why"',
  })
  @ApiCreatedResponse({ description: 'The declined idea.' })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Post('ideas/:id/decline')
  declineIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeclineIdeaDto,
  ) {
    return this.adminService.declineIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'List the Capacity-view team roster' })
  @ApiOkResponse({ description: 'The team roster, ordered by `sortOrder`.' })
  @Get('team')
  listTeam() {
    return this.adminService.listTeam();
  }

  @ApiOperation({ summary: 'Add a member to the team roster' })
  @ApiCreatedResponse({ description: 'The created team-roster row.' })
  @Post('team')
  createTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateTeamMemberDto,
  ) {
    return this.adminService.createTeamMember(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a team-roster row' })
  @ApiOkResponse({ description: 'The updated team-roster row.' })
  @ApiNotFoundResponse({ description: 'No team-roster row with that id.' })
  @Patch('team/:id')
  updateTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.adminService.updateTeamMember(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Remove a member from the team roster' })
  @ApiOkResponse({ description: 'The team-roster row was deleted.' })
  @ApiNotFoundResponse({ description: 'No team-roster row with that id.' })
  @Delete('team/:id')
  deleteTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.adminService.deleteTeamMember(id, this.toActor(user));
  }

  @ApiOperation({ summary: 'Get a page of the admin audit trail' })
  @ApiOkResponse({ description: 'Audit entries, newest first.' })
  @Get('audit')
  getAudit(@Query() query: AuditQueryDto) {
    return this.adminService.getAudit(query);
  }

  // Declared as a distinct literal segment from `audit` above — no
  // route-order concern (see the class-level route order note); both can be
  // registered in either order without one shadowing the other.
  @ApiOperation({ summary: 'Download the full admin audit trail as CSV' })
  @ApiOkResponse({
    description: 'The audit trail, `when,who,what`, newest first.',
  })
  @Get('audit.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="roadmap-audit.csv"')
  getAuditCsv() {
    return this.adminService.getAuditCsv();
  }

  @ApiOperation({ summary: 'Update the roadmap hero-stats settings' })
  @ApiOkResponse({ description: 'The persisted hero stats.' })
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.adminService.updateSettings(dto, this.toActor(user));
  }
}

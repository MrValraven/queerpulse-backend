import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
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
import { RoadmapService } from './roadmap.service';
import { RoadmapAdminService, RoadmapActor } from './roadmap-admin.service';
import { CastVoteDto } from './dto/cast-vote.dto';
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
 * Member voting/idea-submission plus admin CRUD for `/about/roadmap` and
 * `/admin/roadmap`. Public reads live separately in
 * `RoadmapPublicController` (`ActiveMemberGuard` does not honor `@Public()`).
 * Admin routes layer a method-level `RolesGuard` on top of the class-level
 * `ActiveMemberGuard`, mirroring `GovernanceController`'s admin section.
 *
 * Route order note: `PATCH admin/items/bulk` is declared BEFORE
 * `PATCH admin/items/:id` — both are 3-segment paths for the same HTTP verb,
 * and Nest/Express matches routes in registration order, so a `:id` route
 * declared first would swallow `bulk` as `id: 'bulk'`. Every other new route
 * either differs in segment count from `admin/items/:id`/`admin/ideas/:id`/
 * `admin/team/:id` (e.g. `.../:id/deps`) or uses a literal that never
 * collides with a param segment at the same position (`admin/audit` vs.
 * `admin/audit.csv` are two distinct literal segments), so no other
 * reordering is required.
 */
@Feature('roadmap')
@ApiTags('Roadmap')
@ApiCookieAuth('access_token')
@Controller('roadmap')
@UseGuards(ActiveMemberGuard)
export class RoadmapController {
  constructor(
    private readonly roadmapService: RoadmapService,
    private readonly adminService: RoadmapAdminService,
  ) {}

  @ApiOperation({
    summary: 'List the roadmap targets the caller has voted for',
  })
  @ApiOkResponse({ description: 'The target ids the caller has voted for.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get('my-votes')
  myVotes(@CurrentUser() user: CurrentUserData) {
    return this.roadmapService.getMyVotes(user.userId);
  }

  @ApiOperation({ summary: 'Cast a vote for a roadmap item or idea' })
  @ApiCreatedResponse({
    description: 'The target id, its recomputed vote total, and `voted: true`.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No roadmap item or idea with that id.' })
  @Post('vote')
  vote(@CurrentUser() user: CurrentUserData, @Body() dto: CastVoteDto) {
    return this.roadmapService.castVote(user.userId, dto);
  }

  @ApiOperation({ summary: 'Submit a roadmap idea for moderation' })
  @ApiCreatedResponse({
    description: 'The idea was queued (`{ status: "pending" }`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Post('ideas')
  submitIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.roadmapService.submitIdea(user.userId, dto);
  }

  // ── Admin (Admin/Moderator) ──────────────────────────────────────────────

  // `CurrentUserData` carries the caller's id, email, status, and role — no
  // display name (that lives on `Profile`, a separate lookup the JWT/session
  // payload doesn't carry). Resolving a real name here would mean this
  // controller querying `profiles` per mutating request just to build an
  // audit label; there's no existing `actorLabel`-from-`CurrentUser`
  // precedent elsewhere in the codebase to match either. The email is
  // already stable, always-present, and human-readable, so it's used as-is
  // for `actorLabel` rather than adding a per-request profile lookup this
  // task's scope (controller + module wiring only) doesn't otherwise need.
  private toActor(user: CurrentUserData): RoadmapActor {
    return { actorId: user.userId, actorLabel: user.email };
  }

  @ApiOperation({ summary: 'Get the full admin roadmap board' })
  @ApiOkResponse({
    description:
      'All items and ideas (any status) with vote counts and hero stats.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Get('admin')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  admin() {
    return this.adminService.getAdmin();
  }

  @ApiOperation({ summary: 'Create a roadmap item' })
  @ApiCreatedResponse({ description: 'The created roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Post('admin/items')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createItem(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateRoadmapItemDto,
  ) {
    return this.adminService.createItem(dto, this.toActor(user));
  }

  // Declared BEFORE `PATCH admin/items/:id` — see the class-level route
  // order note.
  @ApiOperation({
    summary: 'Apply one action (move/show/hide/archive/delete) to many items',
  })
  @ApiOkResponse({
    description: 'How many items the action actually applied to.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Patch('admin/items/bulk')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  bulkItems(@CurrentUser() user: CurrentUserData, @Body() dto: BulkItemsDto) {
    return this.adminService.bulkItems(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a roadmap item' })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Patch('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateRoadmapItemDto,
  ) {
    return this.adminService.updateItem(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Delete a roadmap item and its votes' })
  @ApiOkResponse({ description: 'The item was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Delete('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteItem(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.adminService.deleteItem(id, this.toActor(user));
  }

  @ApiOperation({ summary: "Add or remove one of an item's dependency edges" })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({
    description:
      "No roadmap item with that id, or no dependency target with `add`'s id.",
  })
  @Patch('admin/items/:id/deps')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateDeps(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateDepsDto,
  ) {
    return this.adminService.updateDeps(id, dto, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Duplicate a roadmap item as a fresh, unpublished draft',
  })
  @ApiCreatedResponse({ description: 'The newly created duplicate item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Post('admin/items/:id/duplicate')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  duplicateItem(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.adminService.duplicateItem(id, this.toActor(user));
  }

  @ApiOperation({ summary: 'Archive or restore a roadmap item' })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Patch('admin/items/:id/archive')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  archiveItem(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: ArchiveItemDto,
  ) {
    return this.adminService.archiveItem(id, dto.archived, this.toActor(user));
  }

  @ApiOperation({ summary: 'Notify every voter on an item with a message' })
  @ApiCreatedResponse({
    description: 'How many voters were actually notified.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Post('admin/items/:id/notify')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  notifyVoters(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: NotifyVotersDto,
  ) {
    return this.adminService.notifyVoters(id, dto, this.toActor(user));
  }

  // Reuses `SubmitIdeaDto` — there is no separate `CreateIdeaDto`; the admin
  // service publishes the idea directly instead of leaving it `pending`.
  @ApiOperation({ summary: 'Create a published roadmap idea (admin-authored)' })
  @ApiCreatedResponse({ description: 'The created idea.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Post('admin/ideas')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.adminService.createIdea(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a roadmap idea (moderate, edit, reorder)' })
  @ApiOkResponse({ description: 'The updated idea.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Patch('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateIdeaDto,
  ) {
    return this.adminService.updateIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Delete a roadmap idea and its votes' })
  @ApiOkResponse({ description: 'The idea was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Delete('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteIdea(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.adminService.deleteIdea(id, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Promote a pending/published idea into a backlog item',
  })
  @ApiCreatedResponse({ description: 'The newly created roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Post('admin/ideas/:id/promote')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  promoteIdea(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.adminService.promoteIdea(id, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Merge an idea into an existing item, carrying its votes',
  })
  @ApiCreatedResponse({ description: 'The item the idea was merged into.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({
    description:
      'No roadmap idea with that id, or no merge target item with `intoItemId`.',
  })
  @Post('admin/ideas/:id/merge')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  mergeIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: MergeIdeaDto,
  ) {
    return this.adminService.mergeIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({
    summary: 'Decline a pending idea as "not building this, and why"',
  })
  @ApiCreatedResponse({ description: 'The declined idea.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Post('admin/ideas/:id/decline')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  declineIdea(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: DeclineIdeaDto,
  ) {
    return this.adminService.declineIdea(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'List the Capacity-view team roster' })
  @ApiOkResponse({ description: 'The team roster, ordered by `sortOrder`.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Get('admin/team')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  listTeam() {
    return this.adminService.listTeam();
  }

  @ApiOperation({ summary: 'Add a member to the team roster' })
  @ApiCreatedResponse({ description: 'The created team-roster row.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Post('admin/team')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateTeamMemberDto,
  ) {
    return this.adminService.createTeamMember(dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Update a team-roster row' })
  @ApiOkResponse({ description: 'The updated team-roster row.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No team-roster row with that id.' })
  @Patch('admin/team/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.adminService.updateTeamMember(id, dto, this.toActor(user));
  }

  @ApiOperation({ summary: 'Remove a member from the team roster' })
  @ApiOkResponse({ description: 'The team-roster row was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No team-roster row with that id.' })
  @Delete('admin/team/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteTeamMember(
    @CurrentUser() user: CurrentUserData,
    @Param('id') id: string,
  ) {
    return this.adminService.deleteTeamMember(id, this.toActor(user));
  }

  @ApiOperation({ summary: 'Get a page of the admin audit trail' })
  @ApiOkResponse({ description: 'Audit entries, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Get('admin/audit')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  getAudit(@Query() query: AuditQueryDto) {
    return this.adminService.getAudit(query);
  }

  // Declared as a distinct literal segment from `admin/audit` above — no
  // route-order concern (see the class-level route order note); both can be
  // registered in either order without one shadowing the other.
  @ApiOperation({ summary: 'Download the full admin audit trail as CSV' })
  @ApiOkResponse({
    description: 'The audit trail, `when,who,what`, newest first.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Get('admin/audit.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="roadmap-audit.csv"')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  getAuditCsv() {
    return this.adminService.getAuditCsv();
  }

  @ApiOperation({ summary: 'Update the roadmap hero-stats settings' })
  @ApiOkResponse({ description: 'The persisted hero stats.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Patch('admin/settings')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateSettings(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.adminService.updateSettings(dto, this.toActor(user));
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
import { RoadmapAdminService } from './roadmap-admin.service';
import { CastVoteDto } from './dto/cast-vote.dto';
import { SubmitIdeaDto } from './dto/submit-idea.dto';
import { CreateRoadmapItemDto } from './dto/create-roadmap-item.dto';
import { UpdateRoadmapItemDto } from './dto/update-roadmap-item.dto';
import { UpdateIdeaDto } from './dto/update-idea.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Member voting/idea-submission plus admin CRUD for `/about/roadmap` and
 * `/admin/roadmap`. Public reads live separately in
 * `RoadmapPublicController` (`ActiveMemberGuard` does not honor `@Public()`).
 * Admin routes layer a method-level `RolesGuard` on top of the class-level
 * `ActiveMemberGuard`, mirroring `GovernanceController`'s admin section.
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

  @ApiOperation({ summary: 'List the roadmap targets the caller has voted for' })
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
  @ApiCreatedResponse({ description: 'The idea was queued (`{ status: "pending" }`).' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Post('ideas')
  submitIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.roadmapService.submitIdea(user.userId, dto);
  }

  // ── Admin (Admin/Moderator) ──────────────────────────────────────────────

  @ApiOperation({ summary: 'Get the full admin roadmap board' })
  @ApiOkResponse({
    description: 'All items and ideas (any status) with vote counts and hero stats.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
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
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Post('admin/items')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createItem(@Body() dto: CreateRoadmapItemDto) {
    return this.adminService.createItem(dto);
  }

  @ApiOperation({ summary: 'Update a roadmap item' })
  @ApiOkResponse({ description: 'The updated roadmap item.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Patch('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateItem(@Param('id') id: string, @Body() dto: UpdateRoadmapItemDto) {
    return this.adminService.updateItem(id, dto);
  }

  @ApiOperation({ summary: 'Delete a roadmap item and its votes' })
  @ApiOkResponse({ description: 'The item was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap item with that id.' })
  @Delete('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteItem(@Param('id') id: string) {
    return this.adminService.deleteItem(id);
  }

  // Reuses `SubmitIdeaDto` — there is no separate `CreateIdeaDto`; the admin
  // service publishes the idea directly instead of leaving it `pending`.
  @ApiOperation({ summary: 'Create a published roadmap idea (admin-authored)' })
  @ApiCreatedResponse({ description: 'The created idea.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Post('admin/ideas')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createIdea(@Body() dto: SubmitIdeaDto) {
    return this.adminService.createIdea(dto);
  }

  @ApiOperation({ summary: 'Update a roadmap idea (moderate, edit, reorder)' })
  @ApiOkResponse({ description: 'The updated idea.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Patch('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateIdea(@Param('id') id: string, @Body() dto: UpdateIdeaDto) {
    return this.adminService.updateIdea(id, dto);
  }

  @ApiOperation({ summary: 'Delete a roadmap idea and its votes' })
  @ApiOkResponse({ description: 'The idea was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @ApiNotFoundResponse({ description: 'No roadmap idea with that id.' })
  @Delete('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteIdea(@Param('id') id: string) {
    return this.adminService.deleteIdea(id);
  }

  @ApiOperation({ summary: 'Update the roadmap hero-stats settings' })
  @ApiOkResponse({ description: 'The persisted hero stats.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an active member or lacks the admin/moderator role.',
  })
  @Patch('admin/settings')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.adminService.updateSettings(dto);
  }
}

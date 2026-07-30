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
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
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
@ApiCookieAuth()
@Controller('roadmap')
@UseGuards(ActiveMemberGuard)
export class RoadmapController {
  constructor(
    private readonly roadmapService: RoadmapService,
    private readonly adminService: RoadmapAdminService,
  ) {}

  @Get('my-votes')
  myVotes(@CurrentUser() user: CurrentUserData) {
    return this.roadmapService.getMyVotes(user.userId);
  }

  @Post('vote')
  vote(@CurrentUser() user: CurrentUserData, @Body() dto: CastVoteDto) {
    return this.roadmapService.castVote(user.userId, dto);
  }

  @Post('ideas')
  submitIdea(@CurrentUser() user: CurrentUserData, @Body() dto: SubmitIdeaDto) {
    return this.roadmapService.submitIdea(user.userId, dto);
  }

  // ── Admin (Admin/Moderator) ──────────────────────────────────────────────

  @Get('admin')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  admin() {
    return this.adminService.getAdmin();
  }

  @Post('admin/items')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createItem(@Body() dto: CreateRoadmapItemDto) {
    return this.adminService.createItem(dto);
  }

  @Patch('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateItem(@Param('id') id: string, @Body() dto: UpdateRoadmapItemDto) {
    return this.adminService.updateItem(id, dto);
  }

  @Delete('admin/items/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteItem(@Param('id') id: string) {
    return this.adminService.deleteItem(id);
  }

  // Reuses `SubmitIdeaDto` — there is no separate `CreateIdeaDto`; the admin
  // service publishes the idea directly instead of leaving it `pending`.
  @Post('admin/ideas')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  createIdea(@Body() dto: SubmitIdeaDto) {
    return this.adminService.createIdea(dto);
  }

  @Patch('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateIdea(@Param('id') id: string, @Body() dto: UpdateIdeaDto) {
    return this.adminService.updateIdea(id, dto);
  }

  @Delete('admin/ideas/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  deleteIdea(@Param('id') id: string) {
    return this.adminService.deleteIdea(id);
  }

  @Patch('admin/settings')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.adminService.updateSettings(dto);
  }
}

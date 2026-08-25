import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreateIssueDto } from './dto/create-issue.dto';
import { UpdateCoverDto } from './dto/update-cover.dto';
import { UpdateDigestDto } from './dto/update-digest.dto';
import { UpdateIssueScheduleDto } from './dto/update-issue-schedule.dto';
import { UpdateRunOrderDto } from './dto/update-run-order.dto';
import { MagazinePieceService } from './magazine-piece.service';

// ActiveMemberGuard runs first (a suspended moderator is locked out), then
// StaffRolesGuard requires the `magazine_editor` staff role (admins are a
// superset). Route prefix is `magazine/admin/issues` — distinct from
// `magazine/admin/pieces`/`magazine/admin/pitches`/`magazine/admin/desk-summary`
// on AdminMagazinePiecesController, `magazine/admin/decks` on
// AdminMagazineDecksController, and the public `magazine/*` GET routes on
// MagazineController. `:number` is the issue's public display number (a
// varchar like "05", NOT a uuid or int) — never ParseUUIDPipe/ParseIntPipe it.
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin/issues')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineIssuesController {
  constructor(private readonly magazinePieces: MagazinePieceService) {}

  @Get()
  @ApiOperation({
    summary: 'List every issue for the desk switcher, newest number first.',
  })
  @ApiOkResponse({
    description:
      "Each issue's id, display number, title, theme, publish date, and slot fill. " +
      'Distinct from the public `GET /magazine/issues`, which omits `id` and `theme`.',
  })
  listIssues() {
    return this.magazinePieces.listIssuesForDesk();
  }

  @Post()
  @ApiOperation({ summary: 'Create a magazine issue.' })
  @ApiCreatedResponse({ description: 'The created issue.' })
  @ApiBadRequestResponse({ description: 'The issue payload is invalid.' })
  @ApiConflictResponse({
    description: 'An issue already exists with this display number.',
  })
  createIssue(
    @Body() dto: CreateIssueDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.createIssue(dto, user.userId);
  }

  // Declared BEFORE `:number` — Nest matches routes in declaration order,
  // and `current` would otherwise be swallowed as a `:number` value.
  @Get('current')
  @ApiOperation({
    summary: "Get the desk header's current-issue summary.",
  })
  @ApiOkResponse({
    description:
      'The newest issue by display number (slot fill vs. total), or null when no issue exists yet.',
  })
  getCurrentIssue() {
    return this.magazinePieces.getCurrentIssueSummary();
  }

  @Get(':number')
  @ApiOperation({ summary: 'Get the issue production record.' })
  @ApiOkResponse({
    description:
      'The issue with its running order, cover, digest, and ship checklist.',
  })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  getIssueProduction(@Param('number') number: string) {
    return this.magazinePieces.getIssueProduction(number);
  }

  @Patch(':number/run-order')
  @ApiOperation({ summary: "Replace the issue's running order." })
  @ApiOkResponse({ description: 'The updated issue production record.' })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  updateRunOrder(
    @Param('number') number: string,
    @Body() dto: UpdateRunOrderDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updateRunOrder(number, dto, user.userId);
  }

  @Patch(':number/digest')
  @ApiOperation({
    summary: "Replace the issue's members' digest and social curation.",
  })
  @ApiOkResponse({ description: 'The updated issue production record.' })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  updateDigest(@Param('number') number: string, @Body() dto: UpdateDigestDto) {
    return this.magazinePieces.updateDigest(number, dto);
  }

  @Patch(':number/cover')
  @ApiOperation({ summary: "Update the issue's cover art and coverlines." })
  @ApiOkResponse({ description: 'The updated issue production record.' })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  updateCover(
    @Param('number') number: string,
    @Body() dto: UpdateCoverDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updateCover(number, dto, user.userId);
  }

  @Patch(':number/schedule')
  @ApiOperation({
    summary:
      "Set, move, or clear the issue's publish date (`null` un-schedules it).",
  })
  @ApiOkResponse({ description: 'The updated issue production record.' })
  @ApiBadRequestResponse({ description: 'The publish date is invalid.' })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  updateIssueSchedule(
    @Param('number') number: string,
    @Body() dto: UpdateIssueScheduleDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updateIssueSchedule(number, dto, user.userId);
  }

  @Post(':number/digest/test-send')
  @ApiOperation({
    summary:
      "Send a one-off preview of the issue's current members' digest to the caller's own inbox.",
  })
  @ApiOkResponse({
    description:
      'The test email was sent (or logged, if SMTP delivery is not configured).',
  })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  sendDigestTest(
    @Param('number') number: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.sendDigestTest(number, user.email);
  }

  @Post(':number/ship')
  @ApiOperation({
    summary:
      'Ship the issue: publish every past-gate piece linked to it. Pieces behind the gate are left unpublished.',
  })
  @ApiOkResponse({ description: 'The updated issue production record.' })
  @ApiNotFoundResponse({ description: 'No issue exists for this number.' })
  shipIssue(
    @Param('number') number: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.shipIssue(number, user.userId);
  }
}

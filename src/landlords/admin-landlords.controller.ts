import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { ListAdminLandlordsQuery } from './dto/list-admin-landlords.query';
import { ListIntroRequestsQuery } from './dto/list-intro-requests.query';
import { RemoveLandlordQuery } from './dto/remove-landlord.query';
import { TriageIntroRequestDto } from './dto/triage-intro-request.dto';
import { UpdateLandlordStatusDto } from './dto/update-landlord-status.dto';
import { TakeDownRecommendationDto } from './dto/take-down-recommendation.dto';
import { UpdateLandlordDto } from './dto/update-landlord.dto';
import { LandlordsService } from './landlords.service';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/** Moderator/admin moderation of the landlord directory. */
@Feature('landlords')
@ApiTags('Admin — Landlords')
@ApiCookieAuth()
@Controller('admin/landlords')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminLandlordsController {
  constructor(private readonly service: LandlordsService) {}

  @Get()
  @ApiOperation({
    summary: 'List every landlord (including non-live) for moderation',
  })
  @ApiOkResponse({
    description:
      'One page of landlord rows, newest first, with status, submitter and decision history.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listAll(@Query() query: ListAdminLandlordsQuery) {
    return this.service.listForAdmin(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a landlord directory entry as an admin' })
  @ApiCreatedResponse({ description: 'The newly created landlord detail.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique landlord slug.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateLandlordDto) {
    return this.service.adminCreate(user.userId, dto);
  }

  // Literal `intro-requests` routes declared before `:id` so they win the match.
  @Get('intro-requests')
  @ApiOperation({
    summary: 'List intro requests, filtered by landlord and state, paginated',
  })
  @ApiOkResponse({ description: 'One page of intro requests, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listIntroRequests(@Query() query: ListIntroRequestsQuery) {
    return this.service.listIntroRequests(query);
  }

  @Patch('intro-requests/:id')
  @ApiOperation({
    summary: 'Accept or decline an intro request, and tell the member',
  })
  @ApiOkResponse({ description: 'The triaged intro request.' })
  @ApiBadRequestResponse({
    description: 'A declined introduction needs a reason.',
  })
  @ApiNotFoundResponse({ description: 'No intro request with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  triageIntroRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageIntroRequestDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.service.triageIntroRequest(id, dto, user.userId);
  }

  // Literal `recommendations` routes declared before `:id`.
  //
  // RETIRED: `DELETE /admin/landlords/recommendations/:id`, which hard-deleted
  // the row. It was the only takedown on the platform a moderator could not
  // undo, on the surface where being wrong costs the most: these
  // recommendations are how tenants warn each other about landlords, and the
  // writer is by construction the party with less power. It is replaced by the
  // reversible pair below rather than quietly repurposed, because a `DELETE`
  // that no longer deletes tells every future reader the opposite of what
  // happens. An old client calling the retired path now gets a loud 404. Any
  // recommendation already hard-deleted through it is gone for good; nothing
  // here restores it.
  //
  // NO ADMIN CONSOLE CALLS EITHER ROUTE, DELIBERATELY (decided 2026-08-31).
  // The moderator's path to both is the report queue: a member reports one
  // recommendation under the `landlord_recommendation` subject, and
  // `hide_content`/`remove_content` there writes the same `content_moderation`
  // row these two routes write, so there is exactly one takedown whichever door
  // it came through. Building a management screen beside that would invite a
  // takedown with no report behind it, and the report is what creates the record
  // of WHY a tenant's warning about a landlord was withheld, which on this
  // surface is the part worth keeping. These two stay as a documented backstop
  // for direct API use, not as the intended route. If a moderator ever needs to
  // find and lift an old takedown without the original report to hand, that is
  // the thing to build, and it is a read surface rather than a console.
  @Post('recommendations/:id/takedown')
  @ApiOperation({
    summary: 'Take one landlord recommendation down, reversibly',
    description:
      'Writes a `content_moderation` row under the `landlord_recommendation` ' +
      'subject, keyed by the recommendation uuid. This is the same mechanism the ' +
      'moderation queue writes when it acts on a report about one. The ' +
      'recommendation is withheld from every member read and from every star ' +
      'aggregate, and the row itself is untouched, so lifting the takedown ' +
      'restores the original words exactly. A note is required.',
  })
  @ApiOkResponse({
    description: 'The recommendation, with its new moderation state.',
  })
  @ApiBadRequestResponse({ description: 'A takedown needs a note.' })
  @ApiNotFoundResponse({ description: 'No recommendation with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  takeDownRecommendation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TakeDownRecommendationDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.service.takeDownRecommendation(id, user.userId, dto);
  }

  // Reads as what it does: delete the TAKEDOWN, not the recommendation.
  @Delete('recommendations/:id/takedown')
  @ApiOperation({
    summary: 'Lift the takedown on a landlord recommendation',
    description:
      "Puts the tenant's warning back, with its stars counting toward the " +
      "landlord's rating again. Idempotent on a recommendation that carries " +
      'no takedown.',
  })
  @ApiOkResponse({
    description: 'The recommendation, with its takedown lifted.',
  })
  @ApiNotFoundResponse({ description: 'No recommendation with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  restoreRecommendation(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.restoreRecommendation(id);
  }

  // The recommendations on one entry, with their moderation state: the read
  // that shows a moderator what they have already taken down, so they can lift
  // it. Declared after the literal routes above so `intro-requests` and
  // `recommendations` still win their matches.
  @Get(':id/recommendations')
  @ApiOperation({
    summary: "List one landlord's recommendations, with their takedown state",
  })
  @ApiOkResponse({
    description:
      'The newest recommendations on the entry, including any already taken ' +
      'down. Deliberately unfiltered: a takedown nobody can see is a takedown ' +
      'nobody can lift.',
  })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listRecommendations(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listRecommendationsForAdmin(id);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary:
      "Set a landlord's moderation status, and tell whoever suggested it",
  })
  @ApiOkResponse({ description: 'The updated landlord detail.' })
  @ApiBadRequestResponse({
    description: 'Holding a member-suggested entry back needs a reason.',
  })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordStatusDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.service.setStatus(id, dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a landlord directory entry' })
  @ApiOkResponse({ description: 'The updated landlord detail.' })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordDto,
  ) {
    return this.service.update(user.userId, id, dto);
  }

  // The reason rides in the query string: a DELETE body is not reliably sent
  // by every client, and this reason has to reach the member who suggested the
  // entry (the service requires it whenever there is one to tell).
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a landlord directory entry, and tell whoever suggested it',
  })
  @ApiNoContentResponse({ description: 'The landlord was deleted.' })
  @ApiBadRequestResponse({
    description: 'Removing a member-suggested entry needs a reason.',
  })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RemoveLandlordQuery,
  ) {
    return this.service.remove(id, query.reason);
  }
}

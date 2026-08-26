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

  // Literal `recommendations` route declared before `:id`.
  @Delete('recommendations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a landlord recommendation' })
  @ApiNoContentResponse({ description: 'The recommendation was removed.' })
  @ApiNotFoundResponse({ description: 'No recommendation with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  removeRecommendation(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.removeRecommendation(id);
  }

  // The recommendations on one entry, WITH their ids — the only place the API
  // hands out the key `DELETE recommendations/:id` is addressed by. Declared
  // after the literal routes above so `intro-requests` and `recommendations`
  // still win their matches.
  @Get(':id/recommendations')
  @ApiOperation({
    summary: "List one landlord's recommendations, with their ids",
  })
  @ApiOkResponse({
    description: 'The newest recommendations on the entry, ids included.',
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

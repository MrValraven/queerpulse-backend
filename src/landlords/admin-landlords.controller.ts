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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreateLandlordDto } from './dto/create-landlord.dto';
import { ListIntroRequestsQuery } from './dto/list-intro-requests.query';
import { TriageIntroRequestDto } from './dto/triage-intro-request.dto';
import { UpdateLandlordStatusDto } from './dto/update-landlord-status.dto';
import { UpdateLandlordDto } from './dto/update-landlord.dto';
import { LandlordsService } from './landlords.service';
import {
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
  @ApiOkResponse({ description: 'All landlord cards, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listAll() {
    return this.service.listAllForAdmin();
  }

  @Post()
  @ApiOperation({ summary: 'Create a landlord directory entry as an admin' })
  @ApiCreatedResponse({ description: 'The newly created landlord detail.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique landlord slug.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  create(@Body() dto: CreateLandlordDto) {
    return this.service.adminCreate(dto);
  }

  // Literal `intro-requests` routes declared before `:id` so they win the match.
  @Get('intro-requests')
  @ApiOperation({
    summary: 'List intro requests, optionally filtered by landlord',
  })
  @ApiOkResponse({ description: 'Matching intro requests, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  listIntroRequests(@Query() query: ListIntroRequestsQuery) {
    return this.service.listIntroRequests(query.landlord);
  }

  @Patch('intro-requests/:id')
  @ApiOperation({ summary: 'Accept or decline an intro request' })
  @ApiOkResponse({ description: 'The triaged intro request.' })
  @ApiNotFoundResponse({ description: 'No intro request with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  triageIntroRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriageIntroRequestDto,
  ) {
    return this.service.triageIntroRequest(id, dto.action);
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

  @Patch(':id/status')
  @ApiOperation({ summary: "Set a landlord's moderation status" })
  @ApiOkResponse({ description: 'The updated landlord detail.' })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordStatusDto,
  ) {
    return this.service.setStatus(id, dto.status);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a landlord directory entry' })
  @ApiOkResponse({ description: 'The updated landlord detail.' })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandlordDto,
  ) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a landlord directory entry' })
  @ApiNoContentResponse({ description: 'The landlord was deleted.' })
  @ApiNotFoundResponse({ description: 'No landlord with that id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}

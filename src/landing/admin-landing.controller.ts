import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateLandingFeatureDto } from './dto/create-landing-feature.dto';
import { ReorderLandingFeaturesDto } from './dto/reorder-landing-features.dto';
import { UpdateLandingFeatureDto } from './dto/update-landing-feature.dto';
import { LandingSection } from './entities/landing-feature.entity';
import { LandingService } from './landing.service';

/**
 * Admin CRUD + reorder over the landing-page feature slots: the roster per
 * section (active AND inactive, with a live eligibility flag), the
 * eligible-target picker, and create/update/reorder/delete.
 *
 * Deliberately NOT `@LockdownExempt()` — mirrors `AdminCommunitiesController`
 * / `AdminMembersController`: nothing here can lift a lockdown, so this
 * surface should go dark with everything else.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Landing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/landing')
export class AdminLandingController {
  constructor(private readonly landing: LandingService) {}

  @ApiOperation({
    summary:
      'List every landing feature in a section (active and inactive), with live eligibility.',
  })
  @ApiOkResponse({ description: 'The section’s feature rows.' })
  @ApiBadRequestResponse({ description: 'Missing or invalid section.' })
  @Get('features')
  listFeatures(
    @Query('section', new ParseEnumPipe(LandingSection))
    section: LandingSection,
  ) {
    return this.landing.listAdminFeatures(section);
  }

  @ApiOperation({
    summary:
      'List entities eligible to be featured in a section that are not already featured there.',
  })
  @ApiOkResponse({
    description: 'The eligible targets, optionally narrowed by search.',
  })
  @ApiBadRequestResponse({ description: 'Missing or invalid section.' })
  @Get('eligible')
  listEligible(
    @Query('section', new ParseEnumPipe(LandingSection))
    section: LandingSection,
    @Query('search') search?: string,
  ) {
    return this.landing.listEligible(section, search);
  }

  @ApiOperation({ summary: 'Create a landing feature.' })
  @ApiOkResponse({ description: 'The created feature.' })
  @ApiBadRequestResponse({
    description: 'Malformed copy, or the target is not currently eligible.',
  })
  @ApiConflictResponse({
    description: 'This target is already featured in this section.',
  })
  @Post('features')
  createFeature(
    @CurrentUser() currentUser: CurrentUserData,
    @Body() dto: CreateLandingFeatureDto,
  ) {
    return this.landing.createFeature(currentUser.userId, dto);
  }

  // Declared before ':id' so 'reorder' is not captured as an id param — same
  // precedent as 'flagged' in `AdminMembersController`.
  @ApiOperation({
    summary: 'Rewrite the position of every feature in a section.',
  })
  @ApiOkResponse({ description: 'The section’s features in their new order.' })
  @ApiBadRequestResponse({
    description:
      'orderedIds is not exactly the current set of feature ids for the section.',
  })
  @Patch('features/reorder')
  reorderFeatures(@Body() dto: ReorderLandingFeaturesDto) {
    return this.landing.reorderFeatures(dto);
  }

  @ApiOperation({
    summary: "Update a feature's copy and/or active flag.",
  })
  @ApiOkResponse({ description: 'The updated feature.' })
  @ApiBadRequestResponse({ description: 'Malformed copy.' })
  @ApiNotFoundResponse({ description: 'Landing feature not found.' })
  @Patch('features/:id')
  updateFeature(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLandingFeatureDto,
  ) {
    return this.landing.updateFeature(id, dto);
  }

  @ApiOperation({ summary: 'Delete a landing feature.' })
  @ApiOkResponse({ description: 'The feature was deleted.' })
  @ApiNotFoundResponse({ description: 'Landing feature not found.' })
  @Delete('features/:id')
  deleteFeature(@Param('id', ParseUUIDPipe) id: string) {
    return this.landing.deleteFeature(id);
  }
}

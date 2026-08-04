import {
  Body,
  Controller,
  Get,
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
import { CreatePartnerApplicationDto } from './dto/create-partner-application.dto';
import { ListPartnersQuery } from './dto/list-partners.query';
import { TriagePartnerApplicationDto } from './dto/triage-partner-application.dto';
import { UpdatePartnerAdminDto } from './dto/update-partner-admin.dto';
import { PartnersService } from './partners.service';
import {
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

// Public directory: approved partners only. Any active member can browse it,
// but there's no ownership/authorship concept here (unlike companies/jobs),
// so there's no CurrentUser-gated variant of these routes.
@Feature('partners')
@ApiTags('Partners')
@ApiCookieAuth()
@Controller('partners')
@UseGuards(ActiveMemberGuard)
export class PartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'List approved partners' })
  @ApiOkResponse({ description: 'A paginated page of approved partners.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an active member account.' })
  list(@Query() query: ListPartnersQuery) {
    return this.partnersService.list(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get an approved partner by slug' })
  @ApiOkResponse({ description: 'The partner detail.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an active member account.' })
  @ApiNotFoundResponse({ description: 'No approved partner with that slug.' })
  getBySlug(@Param('slug') slug: string) {
    return this.partnersService.getBySlug(slug);
  }
}

// Split from `PartnersController` because its three routes have three
// different guard shapes: any active member may submit an application, but
// only admins may list or triage the queue (mirrors `AdminTitlesController`
// being split out from `CinemaController` for the same reason).
@Feature('partners')
@ApiTags('Partners')
@ApiCookieAuth()
@Controller('partner-applications')
export class PartnerApplicationsController {
  constructor(private readonly partnersService: PartnersService) {}

  @Post()
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Submit a partner application' })
  @ApiCreatedResponse({ description: 'The submitted partner application.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an active member account.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique partner slug.',
  })
  submit(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreatePartnerApplicationDto,
  ) {
    return this.partnersService.submitApplication(user.userId, dto);
  }

  @Get()
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'List pending partner applications' })
  @ApiOkResponse({ description: 'The pending-triage application queue.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listApplications() {
    return this.partnersService.listApplications();
  }

  @Patch(':id')
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Approve or reject a partner application' })
  @ApiOkResponse({ description: 'The triaged partner application.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({
    description: 'The partner application does not exist.',
  })
  triage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriagePartnerApplicationDto,
  ) {
    return this.partnersService.triage(id, dto.action, dto.note);
  }
}

// Admin edit of an approved partner's featured/testimonial marketing fields.
// Separate controller for the same reason the applications admin routes are
// split out: a distinct guard shape (admin-only) and path prefix.
@Feature('partners')
@ApiTags('Admin — Partners')
@ApiCookieAuth()
@Controller('admin/partners')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
export class AdminPartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'List approved partners for admin editing' })
  @ApiOkResponse({ description: 'Every approved partner, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  list() {
    return this.partnersService.listApproved();
  }

  @Patch(':id')
  @ApiOperation({ summary: "Update a partner's featured/testimonial fields" })
  @ApiOkResponse({ description: 'The updated partner.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'The partner does not exist.' })
  @ApiConflictResponse({
    description: 'A testimonial quote requires an author.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePartnerAdminDto,
  ) {
    return this.partnersService.updateAdminFields(id, dto);
  }
}

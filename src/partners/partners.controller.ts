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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { QueueAssignmentDto } from '../common/queue-assignment.dto';
import { UserRole } from '../users/entities/user.entity';
import { CreatePartnerApplicationDto } from './dto/create-partner-application.dto';
import { ListPartnerApplicationsQuery } from './dto/list-partner-applications.query';
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

// Submission only. Any active member may apply to become a partner; listing
// and triaging that queue is admin work and lives on `AdminPartnersController`
// under `/admin/partners/applications` (BE-HSG-29). Keeping the two apart
// means this class has one guard shape rather than two, so a route added here
// later cannot accidentally inherit "member" reach for an admin action.
@Feature('partners')
@ApiTags('Partners')
@ApiCookieAuth()
@Controller('partner-applications')
@UseGuards(ActiveMemberGuard)
export class PartnerApplicationsController {
  constructor(private readonly partnersService: PartnersService) {}

  @Post()
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
}

// Admin edit of an approved partner's featured/testimonial marketing fields.
// Separate controller for the same reason the applications admin routes are
// split out: a distinct guard shape (admin-only) and path prefix.
@Feature('partners')
@ApiTags('Admin — Partners')
@ApiCookieAuth()
@Controller('admin/partners')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('partnerships')
export class AdminPartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get()
  @ApiOperation({ summary: 'List approved partners for admin editing' })
  @ApiOkResponse({ description: 'Every approved partner, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  list() {
    return this.partnersService.listApproved();
  }

  // The application queue. Declared before `PATCH :id` so Nest matches the
  // literal `applications` segment rather than binding it as an `id`.
  @Get('applications')
  @ApiOperation({ summary: 'List pending partner applications' })
  @ApiOkResponse({ description: 'The pending-triage application queue.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  listApplications(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListPartnerApplicationsQuery,
  ) {
    return this.partnersService.listApplications({
      // `me` is resolved here, from the session, so the wire never carries a
      // reviewer's id and one reviewer cannot ask what another is holding.
      // Mirrors `AdminVerificationController.listRequests` exactly.
      assignedTo:
        query.assignedTo === 'me'
          ? user.userId
          : (query.assignedTo ?? undefined),
    });
  }

  /**
   * Claim or release a partner application (OPS-04).
   *
   * The same route shape, body and semantics as
   * `PATCH /mod/reports/:id/assignment`: self-assign only, 409 when someone
   * else holds it, release only what you hold. Declared before
   * `PATCH applications/:id` for the literal-before-parameterized convention
   * this controller already follows, and it inherits the class gate unchanged
   * (`@Roles(Admin)` union `@StaffRoles('partnerships')`) — claiming is part
   * of working the queue, so whoever may triage an application may hold one.
   */
  @Patch('applications/:id/assignment')
  @ApiOperation({ summary: 'Claim or release a partner application' })
  @ApiOkResponse({ description: 'The updated partner application.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  @ApiNotFoundResponse({
    description: 'The partner application does not exist.',
  })
  @ApiConflictResponse({
    description:
      'Already claimed by someone else, or it changed while you were acting on it.',
  })
  setApplicationAssignment(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueAssignmentDto,
  ) {
    return this.partnersService.setApplicationAssignment(
      id,
      user.userId,
      user.role,
      dto.assign,
    );
  }

  @Patch('applications/:id')
  @ApiOperation({ summary: 'Approve or reject a partner application' })
  @ApiOkResponse({ description: 'The triaged partner application.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  @ApiNotFoundResponse({
    description: 'The partner application does not exist.',
  })
  triage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriagePartnerApplicationDto,
  ) {
    return this.partnersService.triage(id, dto.action, dto.note);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Update a partner's featured/testimonial fields" })
  @ApiOkResponse({ description: 'The updated partner.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
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

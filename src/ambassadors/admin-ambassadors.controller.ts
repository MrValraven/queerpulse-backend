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
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminAmbassadorDTO,
  AmbassadorCircleSummaryDTO,
  AmbassadorStaffSeatDTO,
} from './ambassador-response';
import { AmbassadorsService } from './ambassadors.service';
import { GrantAmbassadorDto } from './dto/grant-ambassador.dto';
import { ListAmbassadorsQuery } from './dto/list-ambassadors.query';
import { RevokeAmbassadorDto } from './dto/revoke-ambassador.dto';
import { UpdateAmbassadorDto } from './dto/update-ambassador.dto';

const FORBIDDEN_DESCRIPTION =
  'Requires the admin role, or the `partnerships` staff role.';

// Naming and standing down QueerPulse Ambassadors, plus the staff seat in
// their private circle. Same guard shape as `AdminPartnersController`: Admin,
// or a holder of the `partnerships` grant.
@ApiTags('Admin: Ambassadors')
@ApiCookieAuth()
@Controller('admin/ambassadors')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('partnerships')
export class AdminAmbassadorsController {
  constructor(private readonly ambassadorsService: AmbassadorsService) {}

  @Get()
  @ApiOperation({ summary: 'List active or past ambassador grants' })
  @ApiOkResponse({ description: 'Grants, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: FORBIDDEN_DESCRIPTION })
  list(@Query() query: ListAmbassadorsQuery): Promise<AdminAmbassadorDTO[]> {
    return this.ambassadorsService.list(query.status ?? 'active');
  }

  // Declared before the `:id` routes, so Nest matches the literal `circle`
  // segment first.
  @Get('circle')
  @ApiOperation({
    summary: 'The ambassadors circle, as the admin page sees it',
  })
  @ApiOkResponse({
    description: 'The circle slug, its head count and whether you hold a seat.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: FORBIDDEN_DESCRIPTION })
  getCircleSummary(
    @CurrentUser() user: CurrentUserData,
  ): Promise<AmbassadorCircleSummaryDTO> {
    return this.ambassadorsService.getCircleSummary(user.userId);
  }

  @Post('circle/staff-seat')
  @ApiOperation({ summary: 'Take a moderator seat in the ambassadors circle' })
  @ApiCreatedResponse({ description: 'The circle slug to open.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: FORBIDDEN_DESCRIPTION })
  takeStaffSeat(
    @CurrentUser() user: CurrentUserData,
  ): Promise<AmbassadorStaffSeatDTO> {
    return this.ambassadorsService.takeStaffSeat(user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Name a member a QueerPulse Ambassador' })
  @ApiCreatedResponse({ description: 'The new grant.' })
  @ApiBadRequestResponse({
    description: 'A system account or an account that is not active.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: `${FORBIDDEN_DESCRIPTION} Also returned for a self-grant.`,
  })
  @ApiNotFoundResponse({ description: 'No member has that handle.' })
  @ApiConflictResponse({ description: 'The member is already an ambassador.' })
  grant(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: GrantAmbassadorDto,
  ): Promise<AdminAmbassadorDTO> {
    return this.ambassadorsService.grant(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Change an active ambassador's focus area" })
  @ApiOkResponse({ description: 'The updated grant.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: FORBIDDEN_DESCRIPTION })
  @ApiNotFoundResponse({ description: 'No active grant with that id.' })
  updateFocusArea(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAmbassadorDto,
  ): Promise<AdminAmbassadorDTO> {
    return this.ambassadorsService.updateFocusArea(
      id,
      dto.focusArea,
      user.userId,
    );
  }

  @Post(':id/revoke')
  @ApiOperation({ summary: 'Stand an ambassador down' })
  @ApiCreatedResponse({ description: 'The revoked grant.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: FORBIDDEN_DESCRIPTION })
  @ApiNotFoundResponse({ description: 'No active grant with that id.' })
  revoke(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeAmbassadorDto,
  ): Promise<AdminAmbassadorDTO> {
    return this.ambassadorsService.revoke(id, dto.reason, user.userId);
  }
}

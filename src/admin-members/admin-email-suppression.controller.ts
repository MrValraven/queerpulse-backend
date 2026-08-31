import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminIdentityService } from './admin-identity.service';
import {
  LiftEmailSuppressionDto,
  LookupEmailSuppressionDto,
} from './dto/admin-identity.dto';

/**
 * The erasure suppression list (PRD-13): look one address up, and lift it.
 *
 * Its own controller under its own path rather than another `admin/members`
 * route, for two reasons. A suppression row deliberately outlives the account
 * it protected, so it belongs to no member and there is no `:memberId` to hang
 * it under. And an `admin/members/<something>/…` route would sit in the same
 * shape as the member routes two other controllers already register, which is
 * how a literal segment quietly starts being read as an id.
 *
 * BOTH routes are POST, including the lookup, and that is not REST pedantry
 * being ignored. The address is the input, a query string lands in access logs,
 * proxy logs and browser history, and the suppression table stores a hash
 * specifically so that "who has ever left this platform" is not lying around in
 * readable form. Putting the plaintext in a URL would hand back exactly what
 * the hash was chosen to avoid.
 *
 * Admin only, with the empty `@StaffRoles()` narrowing, for the same reason as
 * `AdminMemberIdentityController`.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles()
@ApiTags('Admin — Email suppression')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/email-suppressions')
export class AdminEmailSuppressionController {
  constructor(private readonly identity: AdminIdentityService) {}

  // 200 rather than 201: this creates nothing, it answers a question.
  @ApiOperation({
    summary: 'Is this address on the erasure suppression list?',
  })
  @ApiOkResponse({ description: 'What the list holds for that address.' })
  @ApiBadRequestResponse({ description: 'Malformed email address.' })
  @HttpCode(200)
  @Post('lookup')
  lookup(@Body() body: LookupEmailSuppressionDto) {
    return this.identity.lookupSuppression(body.email);
  }

  // Lifting restores nothing. It stops refusing a NEW signup on this address;
  // the erased account and its content are gone. See
  // `AdminIdentityService.liftSuppression`.
  @ApiOperation({
    summary:
      'Lift a suppression so this address can create a new account. Audited, and it restores nothing.',
  })
  @ApiOkResponse({ description: 'The lifted suppression.' })
  @ApiBadRequestResponse({
    description: 'Malformed email address, or a missing/too-short reason.',
  })
  @ApiNotFoundResponse({
    description: 'That address is not on the suppression list.',
  })
  @HttpCode(200)
  @Post('lift')
  lift(
    @CurrentUser() currentUser: CurrentUserData,
    @Body() body: LiftEmailSuppressionDto,
  ) {
    return this.identity.liftSuppression(
      currentUser.userId,
      body.email,
      body.reason,
    );
  }
}

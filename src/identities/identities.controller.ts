import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import {
  IdentityAttributionDto,
  UpdateIdentityAttributionDto,
  UpdateOwnStaffPreferenceDto,
} from './dto/identity-attribution.dto';
import { MailboxSummaryDto } from './dto/mailbox-summary.dto';
import { IdentityAttributionSettingsService } from './identity-attribution-settings.service';
import { IdentitiesService } from './identities.service';

/**
 * Task 15: the mailboxes a member may read and answer, for the header
 * mailbox switcher. Task 20: the two attribution switches
 * ("Tiago from Cafe Lisboa") for one mailbox. Always on, like messaging
 * itself: no `@Feature` flag.
 */
@ApiTags('Identities')
@ApiCookieAuth()
@Controller('identities')
@UseGuards(ActiveMemberGuard)
export class IdentitiesController {
  constructor(
    private readonly identities: IdentitiesService,
    private readonly attributionSettings: IdentityAttributionSettingsService,
  ) {}

  @Get('mailboxes')
  @ApiOperation({
    summary: 'List your mailboxes with their unread counts',
  })
  @ApiOkResponse({
    type: [MailboxSummaryDto],
    description:
      'Your profile mailbox first, then every listing, persona and company mailbox you staff.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  mailboxes(
    @CurrentUser() user: CurrentUserData,
  ): Promise<MailboxSummaryDto[]> {
    return this.identities.listMailboxesFor(user.userId);
  }

  @Get(':identityId/attribution')
  @ApiOperation({
    summary: "Read this mailbox's two attribution switches",
  })
  @ApiOkResponse({ type: IdentityAttributionDto })
  @ApiForbiddenResponse({
    description:
      'IDENTITY_NOT_STAFF: the caller does not staff this identity, or it ' +
      'does not exist.',
  })
  @ApiBadRequestResponse({
    description: 'IDENTITY_NOT_A_MAILBOX: this identity is a profile.',
  })
  attribution(
    @CurrentUser() user: CurrentUserData,
    @Param('identityId', ParseUUIDPipe) identityId: string,
  ): Promise<IdentityAttributionDto> {
    return this.attributionSettings.getAttribution(user.userId, identityId);
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Patch(':identityId/attribution')
  @ApiOperation({
    summary: "Set this mailbox owner's staff-naming switch",
  })
  @ApiOkResponse({ type: IdentityAttributionDto })
  @ApiForbiddenResponse({
    description:
      'IDENTITY_NOT_OWNER: the caller staffs this identity but is not its ' +
      'owner, including while an ownerless listing has none. ' +
      'IDENTITY_NOT_STAFF: the caller does not staff this identity, or it ' +
      'does not exist. IDENTITY_REMOVED: this persona was removed by ' +
      'moderation.',
  })
  @ApiBadRequestResponse({
    description:
      'IDENTITY_NOT_A_MAILBOX: this identity is a profile. Otherwise, an ' +
      'invalid body.',
  })
  updateAttribution(
    @CurrentUser() user: CurrentUserData,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Body() dto: UpdateIdentityAttributionDto,
  ): Promise<IdentityAttributionDto> {
    return this.attributionSettings.updateOwnerSwitch(
      user.userId,
      identityId,
      dto.shouldShowStaffNames,
    );
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Put(':identityId/staff-preferences/me')
  @ApiOperation({
    summary: 'Set your own naming preference for this mailbox',
  })
  @ApiOkResponse({ type: IdentityAttributionDto })
  @ApiForbiddenResponse({
    description:
      'IDENTITY_NOT_STAFF: the caller does not staff this identity, or it ' +
      'does not exist. IDENTITY_REMOVED: this persona was removed by ' +
      'moderation.',
  })
  @ApiBadRequestResponse({
    description:
      'IDENTITY_NOT_A_MAILBOX: this identity is a profile. Otherwise, an ' +
      'invalid body.',
  })
  updateOwnStaffPreference(
    @CurrentUser() user: CurrentUserData,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Body() dto: UpdateOwnStaffPreferenceDto,
  ): Promise<IdentityAttributionDto> {
    return this.attributionSettings.updateOwnStaffPreference(
      user.userId,
      identityId,
      dto.shouldAllowNaming,
    );
  }
}

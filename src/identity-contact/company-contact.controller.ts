import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateIdentityEnquiryDto } from './dto/create-identity-enquiry.dto';
import { IdentityContactService } from './identity-contact.service';

/**
 * Task 18: "Message" on a company page, for signed-in members. The enquiry
 * lands in the company's mailbox, answered by its owner and team members as
 * the company. Guards, throttles and response shapes follow
 * `ListingEnquiriesController`, and the feature flag follows
 * `CompaniesController`.
 */
@Feature('companies')
@ApiTags('Companies')
@ApiCookieAuth('access_token')
@Controller('companies')
@UseGuards(ActiveMemberGuard)
export class CompanyContactController {
  constructor(
    private readonly identityContactService: IdentityContactService,
  ) {}

  @Get(':slug/contact')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Whether the caller can message this company' })
  @ApiOkResponse({
    description:
      'Whether the company can be messaged, why not when it cannot, whether follow-ups wait on its first reply, any conversation the caller already has with it, and whether a counted cap would refuse their next enquiry. POST /companies/:slug/enquiries re-checks everything and is the only authority.',
  })
  @ApiNotFoundResponse({
    description:
      'No company with that slug, or one under a moderator takedown.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getContact(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.identityContactService.getCompanyContact(slug, user.userId);
  }

  @Post(':slug/enquiries')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({
    summary: 'Send a private enquiry to a company’s mailbox',
  })
  @ApiCreatedResponse({
    description: 'The conversation the enquiry was delivered into.',
  })
  @ApiBadRequestResponse({
    description:
      'Nobody can answer this company yet (IDENTITY_HAS_NO_STAFF), or the caller answers it themselves (IDENTITY_IS_YOUR_OWN).',
  })
  @ApiForbiddenResponse({
    description:
      'The caller blocked this company, or nobody who answers it can be reached by the caller (IDENTITY_BLOCKED); or the caller is acting as a business, persona or company, which cannot start a conversation (IDENTITY_CANNOT_INITIATE).',
  })
  @ApiNotFoundResponse({
    description:
      'No company with that slug, or one under a moderator takedown.',
  })
  @ApiTooManyRequestsResponse({
    description: 'The caller has hit a per-mailbox or per-day enquiry cap.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  send(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateIdentityEnquiryDto,
  ) {
    return this.identityContactService.sendToCompany(slug, user.userId, dto);
  }
}

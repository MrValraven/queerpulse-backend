import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { CreateIdentityEnquiryDto } from './dto/create-identity-enquiry.dto';
import { IdentityContactService } from './identity-contact.service';

/**
 * Task 18: "Message" on a persona, for signed-in members. The enquiry lands
 * in the persona's mailbox, answered by its owner and co-owners as the
 * persona. Guards, throttles and response shapes follow
 * `ListingEnquiriesController`: a loose throttle on the read the page calls
 * once, a tight one on the write, which puts a message in somebody's inbox.
 * Addressed by the persona's uuid, which its public view already carries for
 * linked and unlinked personas alike.
 */
@ApiTags('Subprofiles')
@ApiCookieAuth('access_token')
@Controller('subprofiles')
@UseGuards(ActiveMemberGuard)
export class PersonaContactController {
  constructor(
    private readonly identityContactService: IdentityContactService,
  ) {}

  @Get(':id/contact')
  @Throttle({ default: { limit: 60, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Whether the caller can message this persona' })
  @ApiOkResponse({
    description:
      'Whether the persona can be messaged, why not when it cannot, whether follow-ups wait on its first reply, any conversation the caller already has with it, and whether a counted cap would refuse their next enquiry. POST /subprofiles/:id/enquiries re-checks everything and is the only authority.',
  })
  @ApiNotFoundResponse({
    description:
      'No published persona with that id that the caller could see, one under a moderator takedown, or one whose owner and the caller are blocked either way.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getContact(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.identityContactService.getPersonaContact(id, user.userId);
  }

  @Post(':id/enquiries')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({
    summary: 'Send a private enquiry to a persona’s mailbox',
  })
  @ApiCreatedResponse({
    description: 'The conversation the enquiry was delivered into.',
  })
  @ApiBadRequestResponse({
    description:
      'Nobody can answer this persona (IDENTITY_HAS_NO_STAFF), or the caller answers it themselves (IDENTITY_IS_YOUR_OWN).',
  })
  @ApiForbiddenResponse({
    description:
      'The caller blocked this persona, or nobody who answers it can be reached by the caller (IDENTITY_BLOCKED); it was removed by moderation (IDENTITY_REMOVED); or the caller is acting as a business, persona or company, which cannot start a conversation (IDENTITY_CANNOT_INITIATE).',
  })
  @ApiNotFoundResponse({
    description:
      'No published persona with that id that the caller could see, including one whose owner and the caller are blocked either way.',
  })
  @ApiTooManyRequestsResponse({
    description: 'The caller has hit a per-mailbox or per-day enquiry cap.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  send(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateIdentityEnquiryDto,
  ) {
    return this.identityContactService.sendToPersona(id, user.userId, dto);
  }
}

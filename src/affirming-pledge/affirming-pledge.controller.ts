import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { AffirmingPledgeService } from './affirming-pledge.service';

/**
 * The LGBTQ+ affirming housing pledge — accept once, applies to every housing
 * write/contact action. `GET` reports the caller's standing (the frontend gate
 * reads it up front); `POST` records acceptance (idempotent, stamp-once). The
 * pledge is a community code of conduct, NOT an identity filter.
 */
@ApiTags('Housing')
@ApiCookieAuth('access_token')
@Controller('housing/affirming-pledge')
@UseGuards(ActiveMemberGuard)
export class AffirmingPledgeController {
  constructor(private readonly service: AffirmingPledgeService) {}

  @Get()
  @ApiOperation({ summary: "The current member's affirming-pledge standing" })
  @ApiOkResponse({ description: 'Whether the pledge is accepted, and when.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.service.getStatus(user.userId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept the LGBTQ+ affirming housing pledge' })
  @ApiCreatedResponse({ description: 'The updated pledge standing.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  accept(@CurrentUser() user: CurrentUserData) {
    return this.service.accept(user.userId);
  }
}

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { ListPageQuery } from './dto/list-page.query';
import { SocialService } from './social.service';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Mutes — one-way, soft silence (spec §3 Tier 1 "social"). Always-on safety
 * primitive: no `@Feature` flag. The muted member is never notified. Members
 * are addressed by slug in the path.
 */
@ApiTags('Mutes')
@ApiCookieAuth()
@Controller('mutes')
@UseGuards(ActiveMemberGuard)
export class MutesController {
  constructor(private readonly social: SocialService) {}

  @Get()
  @ApiOperation({ summary: 'List members you have muted (paginated)' })
  @ApiOkResponse({ description: 'A page of muted-member records.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListPageQuery) {
    return this.social.listMutes(user.userId, query.page);
  }

  /** Idempotent: muting an already-muted member returns the existing row. */
  @Post(':slug')
  @ApiOperation({ summary: 'Mute a member by slug (idempotent)' })
  @ApiCreatedResponse({ description: 'The mute record (new or pre-existing).' })
  @ApiBadRequestResponse({ description: 'You cannot mute yourself.' })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  mute(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.muteMember(user.userId, slug);
  }

  @Delete(':slug')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unmute a member by slug' })
  @ApiNoContentResponse({ description: 'Mute removed.' })
  @ApiBadRequestResponse({ description: 'You cannot target yourself.' })
  @ApiNotFoundResponse({
    description: 'No member with that slug, or no mute to remove.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  unmute(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.unmuteMember(user.userId, slug);
  }
}

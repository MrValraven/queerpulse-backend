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

/**
 * Mutes — one-way, soft silence (spec §3 Tier 1 "social"). Always-on safety
 * primitive: no `@Feature` flag. The muted member is never notified. Members
 * are addressed by slug in the path.
 */
@Controller('mutes')
@UseGuards(ActiveMemberGuard)
export class MutesController {
  constructor(private readonly social: SocialService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListPageQuery) {
    return this.social.listMutes(user.userId, query.page);
  }

  /** Idempotent: muting an already-muted member returns the existing row. */
  @Post(':slug')
  mute(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.muteMember(user.userId, slug);
  }

  @Delete(':slug')
  @HttpCode(204)
  unmute(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.unmuteMember(user.userId, slug);
  }
}

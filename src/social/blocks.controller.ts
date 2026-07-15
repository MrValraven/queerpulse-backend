import {
  Body,
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
import { BlockOptionsDto } from './dto/block-options.dto';
import { ListPageQuery } from './dto/list-page.query';
import { SocialService } from './social.service';

/**
 * Blocks — hard, mutual severance (spec §3 Tier 1 "social"). Always-on
 * safety primitive: no `@Feature` flag, unlike product-feature controllers.
 * Members are addressed by slug in the path.
 */
@Controller('blocks')
@UseGuards(ActiveMemberGuard)
export class BlocksController {
  constructor(private readonly social: SocialService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListPageQuery) {
    return this.social.listBlocks(user.userId, query.page);
  }

  /** Idempotent: blocking an already-blocked member returns the existing row. */
  @Post(':slug')
  block(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto?: BlockOptionsDto,
  ) {
    return this.social.blockMember(user.userId, slug, dto);
  }

  @Delete(':slug')
  @HttpCode(204)
  unblock(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.unblockMember(user.userId, slug);
  }

  /** `{ blocking, blockedBy }` — never leaks who blocked whom beyond that. */
  @Get(':slug')
  status(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.getBlockStatus(user.userId, slug);
  }
}

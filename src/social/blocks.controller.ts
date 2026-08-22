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
 * Blocks — hard, mutual severance (spec §3 Tier 1 "social"). Always-on
 * safety primitive: no `@Feature` flag, unlike product-feature controllers.
 * Members are addressed by slug in the path.
 */
@ApiTags('Blocks')
@ApiCookieAuth()
@Controller('blocks')
@UseGuards(ActiveMemberGuard)
export class BlocksController {
  constructor(private readonly social: SocialService) {}

  @Get()
  @ApiOperation({ summary: 'List members you have blocked (paginated)' })
  @ApiOkResponse({ description: 'A page of blocked-member records.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListPageQuery) {
    return this.social.listBlocks(user.userId, query.page);
  }

  /** Idempotent: blocking an already-blocked member returns the existing row. */
  @Post(':slug')
  @ApiOperation({ summary: 'Block a member by slug (idempotent)' })
  @ApiCreatedResponse({
    description: 'The block record (new or pre-existing).',
  })
  @ApiBadRequestResponse({ description: 'You cannot block yourself.' })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  block(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto?: BlockOptionsDto,
  ) {
    return this.social.blockMember(user.userId, slug, dto);
  }

  @Delete(':slug')
  @HttpCode(204)
  @ApiOperation({ summary: 'Unblock a member by slug' })
  @ApiNoContentResponse({ description: 'Block removed.' })
  @ApiBadRequestResponse({ description: 'You cannot target yourself.' })
  @ApiNotFoundResponse({
    description: 'No member with that slug, or no block to remove.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  unblock(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.unblockMember(user.userId, slug);
  }

  /**
   * `{ blocking }` — ONLY the block the caller placed. It deliberately does
   * not report whether that member blocked the caller: this endpoint is
   * pollable for any slug, and an inbound block must stay indistinguishable
   * (see `SocialService.getBlockStatus` and `ConnectionsService.request`).
   */
  @Get(':slug')
  @ApiOperation({ summary: 'Whether you have blocked this member' })
  @ApiOkResponse({
    description:
      '`{ blocking }` — whether the ACTOR blocked that member. Never reports ' +
      'a block in the other direction.',
  })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  status(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.social.getBlockStatus(user.userId, slug);
  }
}

import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityPostsService } from './community-posts.service';
import { CreateFlatPostDto } from './dto/create-flat-post.dto';
import { FlatReplyDto } from './dto/flat-reply.dto';
import { LikePostDto } from './dto/like-post.dto';

/**
 * Flat `community-posts` aliases the feed feature calls directly
 * (`features/feed/api/feed.api.ts`), on top of the same post store the
 * nested `CommunitiesController` (`/communities/:slug/posts*`) already
 * serves. Reuses `CommunityPostsService`'s by-id methods — see that file for
 * how `communitySlug` optional and the reserved `like` reaction key work.
 */
@Feature('communities')
@Controller('community-posts')
@UseGuards(ActiveMemberGuard)
export class CommunityPostsController {
  constructor(private readonly communityPostsService: CommunityPostsService) {}

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateFlatPostDto) {
    return this.communityPostsService.createFlatPost(user.userId, dto);
  }

  @Post(':id/like')
  like(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LikePostDto,
  ) {
    return this.communityPostsService.likeFlatPost(id, user.userId, dto.liked);
  }

  @Post(':id/replies')
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlatReplyDto,
  ) {
    return this.communityPostsService.addFlatReply(id, user.userId, dto.body);
  }
}

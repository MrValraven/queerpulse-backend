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
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Flat `community-posts` aliases the feed feature calls directly
 * (`features/feed/api/feed.api.ts`), on top of the same post store the
 * nested `CommunitiesController` (`/communities/:slug/posts*`) already
 * serves. Reuses `CommunityPostsService`'s by-id methods — see that file for
 * how `communitySlug` optional and the reserved `like` reaction key work.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('community-posts')
@UseGuards(ActiveMemberGuard)
export class CommunityPostsController {
  constructor(private readonly communityPostsService: CommunityPostsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a post, optionally scoped to a community by slug.',
  })
  @ApiCreatedResponse({ description: 'The created post id (`{ id }`).' })
  @ApiBadRequestResponse({ description: 'The post payload is invalid.' })
  @ApiForbiddenResponse({
    description: 'Not a member of the target community.',
  })
  @ApiNotFoundResponse({ description: 'The target community was not found.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateFlatPostDto) {
    return this.communityPostsService.createFlatPost(user.userId, dto);
  }

  @Post(':id/like')
  @ApiOperation({ summary: 'Like or unlike a post by id (idempotent toggle).' })
  @ApiCreatedResponse({
    description: 'The like state and updated like count.',
  })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({
    description: "Not a member of the post's community.",
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  like(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LikePostDto,
  ) {
    return this.communityPostsService.likeFlatPost(id, user.userId, dto.liked);
  }

  @Post(':id/replies')
  @ApiOperation({ summary: 'Reply to a post by id.' })
  @ApiCreatedResponse({ description: 'The created reply id (`{ id }`).' })
  @ApiBadRequestResponse({
    description: 'Malformed post id or invalid payload.',
  })
  @ApiForbiddenResponse({
    description: "Not a member of the post's community.",
  })
  @ApiNotFoundResponse({ description: 'No post exists for this id.' })
  reply(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FlatReplyDto,
  ) {
    return this.communityPostsService.addFlatReply(id, user.userId, dto.body);
  }
}

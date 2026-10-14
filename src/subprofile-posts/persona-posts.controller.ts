import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { CreatePersonaPostDto } from './dto/create-persona-post.dto';
import { ListPersonaPostsQuery } from './dto/list-persona-posts.query';
import { PersonaPost, PersonaPostPage } from './persona-post-response';
import { SubprofilePostsService } from './subprofile-posts.service';

// Studio v3 persona posts on a persona. `ActiveMemberGuard` is bound at the
// class level; the list carries `@Public()` (which that guard steps aside
// for) and `OptionalJwtAuthGuard`, the `by-handle` treatment, so whoever can
// open `/p/<handle>` reads its posts, signed out included.
@ApiTags('Subprofiles')
@ApiCookieAuth()
@UseGuards(ActiveMemberGuard)
@Controller('subprofiles')
export class PersonaPostsController {
  constructor(private readonly posts: SubprofilePostsService) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get(':id/posts')
  @ApiOperation({ summary: "A persona's updates, newest first." })
  @ApiOkResponse({ description: '`PersonaPostPage`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  listPosts(
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('id', ParseUUIDPipe) subprofileId: string,
    @Query() query: ListPersonaPostsQuery,
  ): Promise<PersonaPostPage> {
    return this.posts.listPosts(user, subprofileId, query.cursor);
  }

  // Named `create` on purpose: `PERSONA_SCOPED_KEY_HANDLERS` lists
  // `PersonaPostsController.create`, so a persona photo key may ride here.
  @Post(':id/posts')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post an update (owners and co-owners).' })
  @ApiCreatedResponse({ description: '`PersonaPost`.' })
  @ApiNotFoundResponse({ description: 'Not a persona you run.' })
  @ApiUnprocessableEntityResponse({
    description:
      '`persona_posts_not_available` or `persona_post_image_not_allowed`.',
  })
  @ApiTooManyRequestsResponse({ description: '`persona_post_daily_limit`.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) subprofileId: string,
    @Body() body: CreatePersonaPostDto,
  ): Promise<PersonaPost> {
    return this.posts.createPost(user.userId, subprofileId, body);
  }
}

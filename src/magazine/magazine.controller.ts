import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateReaderCommentDto } from './dto/create-reader-comment.dto';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import { ListArticlesQuery } from './dto/list-articles.query';
import { ListDecksQuery } from './dto/list-decks.query';
import { ListReaderCommentsQuery } from './dto/list-reader-comments.query';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { UpdateReaderCommentDto } from './dto/update-reader-comment.dto';
import { MagazineReaderCommentsService } from './magazine-reader-comments.service';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@Feature('magazine')
@ApiTags('Magazine')
@ApiCookieAuth()
@Controller('magazine')
@UseGuards(ActiveMemberGuard)
export class MagazineController {
  constructor(
    private readonly magazineService: MagazineService,
    private readonly storySubmissionsService: StorySubmissionsService,
    private readonly readerCommentsService: MagazineReaderCommentsService,
  ) {}

  @Get('issues')
  @ApiOperation({ summary: 'List published magazine issues' })
  @ApiOkResponse({
    description:
      'Published issues only, newest number first. An issue with no publish ' +
      'date, or one dated in the future, stays embargoed until it ships — ' +
      'the desk sees those through `GET /magazine/admin/issues`.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listIssues() {
    return this.magazineService.listIssues();
  }

  @Get('issues/:number')
  @ApiOperation({ summary: 'Get a published magazine issue by number' })
  @ApiOkResponse({ description: 'The issue.' })
  @ApiNotFoundResponse({
    description:
      'No published issue with that number (an embargoed issue 404s).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getIssue(@Param('number') number: string) {
    return this.magazineService.getIssueByNumber(number);
  }

  @Get('articles')
  @ApiOperation({ summary: 'List magazine articles, optionally filtered' })
  @ApiOkResponse({ description: 'Matching articles.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listArticles(@Query() query: ListArticlesQuery) {
    return this.magazineService.listArticles(query);
  }

  @Get('articles/:slug')
  @ApiOperation({
    summary: 'Get a magazine article by slug, in the reader’s language',
  })
  @ApiOkResponse({
    description:
      'The article. CON-16: with `?lang=`, a published translation in that ' +
      'language is served in place of the addressed piece, and the response ' +
      'states its own `slug` so the caller can correct the URL. Asking for a ' +
      'language the piece is not in returns it as written; `translations` ' +
      'lists every language it does exist in.',
  })
  @ApiNotFoundResponse({ description: 'No article with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getArticle(@Param('slug') slug: string, @Query('lang') lang?: string) {
    return this.magazineService.getArticleBySlug(slug, lang);
  }

  @Get('sections')
  @ApiOperation({ summary: 'List the magazine section/topic taxonomy' })
  @ApiOkResponse({ description: 'All sections, ordered for display.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listSections() {
    return this.magazineService.listSections();
  }

  @Get('decks')
  @ApiOperation({
    summary: 'List published magazine decks, optionally filtered',
  })
  @ApiOkResponse({ description: 'Matching published decks.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listDecks(@Query() query: ListDecksQuery) {
    return this.magazineService.listPublishedDecks(query);
  }

  @Get('decks/:slug')
  @ApiOperation({ summary: 'Get a published magazine deck by slug' })
  @ApiOkResponse({ description: 'The deck.' })
  @ApiNotFoundResponse({ description: 'No published deck with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getDeck(@Param('slug') slug: string) {
    return this.magazineService.getPublishedDeckBySlug(slug);
  }

  @Get('authors')
  @ApiOperation({ summary: 'List magazine authors' })
  @ApiOkResponse({ description: 'All authors.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listAuthors() {
    return this.magazineService.listAuthors();
  }

  // Declared BEFORE `authors/:slug`: Nest matches routes in declaration
  // order, so a literal segment registered after the wildcard would never be
  // reached ("me" would resolve as an author slug).
  @Get('authors/me')
  @ApiOperation({
    summary: "The caller's own magazine byline, or null if they have none",
  })
  @ApiOkResponse({
    description:
      'The byline linked to the caller, or null when they have never been credited.',
  })
  getMyAuthor(@CurrentUser() user: CurrentUserData) {
    return this.magazineService.getAuthorForUser(user.userId);
  }

  @Patch('authors/me')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Edit your own author bio and portrait (CON-11)',
  })
  @ApiOkResponse({ description: 'The updated byline.' })
  @ApiForbiddenResponse({
    description: 'A moderation restriction is currently in effect.',
  })
  @ApiNotFoundResponse({
    description: 'The caller has no magazine byline yet.',
  })
  updateMyAuthor(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateAuthorDto,
  ) {
    return this.magazineService.updateOwnAuthor(user.userId, dto, user.userId);
  }

  // The "Writing" surface on a member profile (CON-11). Nullable by design —
  // most members have never written for the magazine — so consume it with
  // `apiGetNullable` on the FE.
  @Get('authors/by-member/:memberSlug')
  @ApiOperation({
    summary: "A member's magazine byline, addressed by their profile slug",
  })
  @ApiOkResponse({
    description:
      'The byline, or null when this member has never been credited.',
  })
  getAuthorForMember(@Param('memberSlug') memberSlug: string) {
    return this.magazineService.getAuthorForMemberSlug(memberSlug);
  }

  @Get('authors/:slug')
  @ApiOperation({ summary: 'Get a magazine author by slug' })
  @ApiOkResponse({ description: 'The author.' })
  @ApiNotFoundResponse({ description: 'No author with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getAuthor(@Param('slug') slug: string) {
    return this.magazineService.getAuthorBySlug(slug);
  }

  @Post('submissions')
  @ApiOperation({ summary: 'Submit a story pitch to the magazine' })
  @ApiCreatedResponse({ description: 'The created story submission.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  createSubmission(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateStorySubmissionDto,
  ) {
    return this.storySubmissionsService.create(user.userId, dto);
  }

  @Get('submissions/mine')
  @ApiOperation({ summary: "List the current member's own story submissions" })
  @ApiOkResponse({ description: "The member's story submissions." })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMySubmissions(@CurrentUser() user: CurrentUserData) {
    return this.storySubmissionsService.listMine(user.userId);
  }

  @Get('articles/:slug/comments')
  @ApiOperation({
    summary: 'List reader comments on a published article (paginated)',
  })
  @ApiOkResponse({
    description: 'A page of top-level comments, each with its flat replies.',
  })
  @ApiNotFoundResponse({ description: 'No published article with that slug.' })
  listComments(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListReaderCommentsQuery,
  ) {
    return this.readerCommentsService.list(slug, user, query.page);
  }

  @Post('articles/:slug/comments')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Post a reader comment (optionally a reply via parentId)',
  })
  @ApiCreatedResponse({ description: 'The created comment.' })
  @ApiForbiddenResponse({
    description: 'A moderation restriction is currently in effect.',
  })
  @ApiBadRequestResponse({
    description:
      'Parent comment is in another article, is itself a reply, or is deleted.',
  })
  @ApiNotFoundResponse({
    description:
      'No published article with that slug, or parent comment not found.',
  })
  createComment(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateReaderCommentDto,
  ) {
    return this.readerCommentsService.create(
      slug,
      user,
      dto.body,
      dto.parentId,
    );
  }

  @Patch('comments/:id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit a reader comment (author only)' })
  @ApiOkResponse({ description: 'The updated comment.' })
  @ApiForbiddenResponse({
    description: 'Only the author can edit this comment.',
  })
  @ApiNotFoundResponse({ description: 'Comment not found or already deleted.' })
  updateComment(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReaderCommentDto,
  ) {
    return this.readerCommentsService.update(id, user, dto.body);
  }

  @Delete('comments/:id')
  @ApiOperation({ summary: 'Soft-delete a reader comment (author only)' })
  @ApiOkResponse({ description: 'The tombstoned comment.' })
  @ApiForbiddenResponse({
    description: 'Only the author can delete this comment.',
  })
  @ApiNotFoundResponse({ description: 'Comment not found.' })
  deleteComment(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.readerCommentsService.remove(id, user);
  }
}

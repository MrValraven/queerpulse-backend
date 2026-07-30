import {
  Body,
  Controller,
  Get,
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
import { Feature } from '../common/feature.decorator';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import { ListArticlesQuery } from './dto/list-articles.query';
import { MagazineService } from './magazine.service';
import { StorySubmissionsService } from './story-submissions.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
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
  ) {}

  @Get('issues')
  @ApiOperation({ summary: 'List magazine issues' })
  @ApiOkResponse({ description: 'All magazine issues.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listIssues() {
    return this.magazineService.listIssues();
  }

  @Get('issues/:number')
  @ApiOperation({ summary: 'Get a magazine issue by number' })
  @ApiOkResponse({ description: 'The issue.' })
  @ApiNotFoundResponse({ description: 'No issue with that number.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  getIssue(@Param('number') number: string) {
    return this.magazineService.getIssueByNumber(number);
  }

  @Get('articles')
  @ApiOperation({ summary: 'List magazine articles, optionally filtered' })
  @ApiOkResponse({ description: 'Matching articles.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listArticles(@Query() query: ListArticlesQuery) {
    return this.magazineService.listArticles(query);
  }

  @Get('articles/:slug')
  @ApiOperation({ summary: 'Get a magazine article by slug' })
  @ApiOkResponse({ description: 'The article.' })
  @ApiNotFoundResponse({ description: 'No article with that slug.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  getArticle(@Param('slug') slug: string) {
    return this.magazineService.getArticleBySlug(slug);
  }

  @Get('authors')
  @ApiOperation({ summary: 'List magazine authors' })
  @ApiOkResponse({ description: 'All authors.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listAuthors() {
    return this.magazineService.listAuthors();
  }

  @Get('authors/:slug')
  @ApiOperation({ summary: 'Get a magazine author by slug' })
  @ApiOkResponse({ description: 'The author.' })
  @ApiNotFoundResponse({ description: 'No author with that slug.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  getAuthor(@Param('slug') slug: string) {
    return this.magazineService.getAuthorBySlug(slug);
  }

  @Post('submissions')
  @ApiOperation({ summary: 'Submit a story pitch to the magazine' })
  @ApiCreatedResponse({ description: 'The created story submission.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  createSubmission(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateStorySubmissionDto,
  ) {
    return this.storySubmissionsService.create(user.userId, dto);
  }

  @Get('submissions/mine')
  @ApiOperation({ summary: "List the current member's own story submissions" })
  @ApiOkResponse({ description: "The member's story submissions." })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listMySubmissions(@CurrentUser() user: CurrentUserData) {
    return this.storySubmissionsService.listMine(user.userId);
  }
}

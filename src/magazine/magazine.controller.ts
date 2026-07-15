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

@Feature('magazine')
@Controller('magazine')
@UseGuards(ActiveMemberGuard)
export class MagazineController {
  constructor(
    private readonly magazineService: MagazineService,
    private readonly storySubmissionsService: StorySubmissionsService,
  ) {}

  @Get('issues')
  listIssues() {
    return this.magazineService.listIssues();
  }

  @Get('issues/:number')
  getIssue(@Param('number') number: string) {
    return this.magazineService.getIssueByNumber(number);
  }

  @Get('articles')
  listArticles(@Query() query: ListArticlesQuery) {
    return this.magazineService.listArticles(query);
  }

  @Get('articles/:slug')
  getArticle(@Param('slug') slug: string) {
    return this.magazineService.getArticleBySlug(slug);
  }

  @Get('authors')
  listAuthors() {
    return this.magazineService.listAuthors();
  }

  @Get('authors/:slug')
  getAuthor(@Param('slug') slug: string) {
    return this.magazineService.getAuthorBySlug(slug);
  }

  @Post('submissions')
  createSubmission(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateStorySubmissionDto,
  ) {
    return this.storySubmissionsService.create(user.userId, dto);
  }

  @Get('submissions/mine')
  listMySubmissions(@CurrentUser() user: CurrentUserData) {
    return this.storySubmissionsService.listMine(user.userId);
  }
}

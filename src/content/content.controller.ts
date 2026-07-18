import {
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ContentPagesService } from './content-pages.service';
import { ListTopicPostsQuery } from './dto/list-topic-posts.query';
import { ContentSection } from './entities/content-page.entity';
import { TopicsService } from './topics.service';

// Route scheme (documented per the Task 5.3 brief): a single unified
// `/pages/:section[/:slug]` path family rather than three per-section
// prefixes (`/culture-pages`, `/support-pages`, ...) — `section` is already a
// shared enum across the three frontend features this module serves, so one
// controller + one enum-validated param is both more RESTful and less to
// wire up on the frontend than three near-identical route groups.
//   GET /pages/:section        -> PageResponse[]  (a section's published pages)
//   GET /pages/:section/:slug  -> PageResponse    (one page, 404 if missing)
@Feature('content')
@Controller('pages')
@UseGuards(ActiveMemberGuard)
export class ContentController {
  constructor(private readonly contentPagesService: ContentPagesService) {}

  @Get(':section')
  listBySection(
    @Param('section', new ParseEnumPipe(ContentSection))
    section: ContentSection,
  ) {
    return this.contentPagesService.listBySection(section);
  }

  @Get(':section/:slug')
  getBySlug(
    @Param('section', new ParseEnumPipe(ContentSection))
    section: ContentSection,
    @Param('slug') slug: string,
  ) {
    return this.contentPagesService.getBySlug(section, slug);
  }
}

// Split out (mirrors `PartnersController`/`PartnerApplicationsController`):
// `topics` isn't a `ContentSection` — it's a separate directory shape (see
// `entities/topic.entity.ts`) — so it gets its own route rather than being
// squeezed under `/pages/topics`.
//   GET /topics             -> TopicResponse[]       (the full topic directory)
//   GET /topics/:slug       -> TopicDetailResponse    (one topic's meta, 404 if missing)
//   GET /topics/:slug/posts -> Paginated<TopicPostResponse> (that topic's post feed)
@Feature('content')
@Controller('topics')
@UseGuards(ActiveMemberGuard)
export class TopicsController {
  constructor(private readonly topicsService: TopicsService) {}

  @Get()
  list() {
    return this.topicsService.list();
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.topicsService.getBySlug(slug);
  }

  // Needs the viewer: the post feed is block/mute filtered per-viewer (see
  // `TopicsService.listPosts`). The two routes above are viewer-independent —
  // topic meta carries no author — so they stay unparameterized.
  @Get(':slug/posts')
  listPosts(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListTopicPostsQuery,
  ) {
    return this.topicsService.listPosts(
      slug,
      user.userId,
      query.cursor,
      query.limit,
    );
  }
}

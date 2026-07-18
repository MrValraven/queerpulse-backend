import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ContentController, TopicsController } from './content.controller';
import { ContentPagesService } from './content-pages.service';
import { ContentSection } from './entities/content-page.entity';
import { TopicsService } from './topics.service';

describe('ContentController', () => {
  let controller: ContentController;
  let contentPagesService: {
    listBySection: jest.Mock;
    getBySlug: jest.Mock;
  };

  beforeEach(async () => {
    contentPagesService = {
      listBySection: jest.fn().mockResolvedValue([]),
      getBySlug: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ContentController],
      providers: [
        { provide: ContentPagesService, useValue: contentPagesService },
      ],
    }).compile();
    controller = module.get(ContentController);
  });

  it('delegates the section listing', async () => {
    await controller.listBySection(ContentSection.Culture);
    expect(contentPagesService.listBySection).toHaveBeenCalledWith(
      ContentSection.Culture,
    );
  });

  it('delegates the page-by-slug lookup with section + slug', async () => {
    await controller.getBySlug(ContentSection.Governance, 'moderation');
    expect(contentPagesService.getBySlug).toHaveBeenCalledWith(
      ContentSection.Governance,
      'moderation',
    );
  });
});

describe('TopicsController', () => {
  let controller: TopicsController;
  let topicsService: {
    list: jest.Mock;
    getBySlug: jest.Mock;
    listPosts: jest.Mock;
  };

  const viewer: CurrentUserData = {
    userId: 'viewer-1',
    email: 'viewer@example.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    topicsService = {
      list: jest.fn().mockResolvedValue([]),
      getBySlug: jest.fn().mockResolvedValue({}),
      listPosts: jest.fn().mockResolvedValue({
        data: [],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TopicsController],
      providers: [{ provide: TopicsService, useValue: topicsService }],
    }).compile();
    controller = module.get(TopicsController);
  });

  it('delegates the topic directory listing', async () => {
    await controller.list();
    expect(topicsService.list).toHaveBeenCalled();
  });

  it('delegates the topic-detail lookup by slug', async () => {
    await controller.getBySlug('healthcare');
    expect(topicsService.getBySlug).toHaveBeenCalledWith('healthcare');
  });

  it('delegates the topic post feed with the viewer id, cursor + limit', async () => {
    await controller.listPosts(viewer, 'healthcare', {
      cursor: 'abc',
      limit: 10,
    });
    expect(topicsService.listPosts).toHaveBeenCalledWith(
      'healthcare',
      'viewer-1',
      'abc',
      10,
    );
  });

  it('delegates the topic post feed with no query params', async () => {
    await controller.listPosts(viewer, 'healthcare', {});
    expect(topicsService.listPosts).toHaveBeenCalledWith(
      'healthcare',
      'viewer-1',
      undefined,
      undefined,
    );
  });
});

import { Test, TestingModule } from '@nestjs/testing';
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
  let topicsService: { list: jest.Mock };

  beforeEach(async () => {
    topicsService = {
      list: jest.fn().mockResolvedValue([]),
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
});

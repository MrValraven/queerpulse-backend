import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumController } from './forum.controller';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';

const user: CurrentUserData = {
  userId: 'user-1',
  email: 'a@example.com',
  status: 'active',
  role: 'member',
};

describe('ForumController', () => {
  let controller: ForumController;
  let threadsService: {
    list: jest.Mock;
    getBySlug: jest.Mock;
    create: jest.Mock;
  };
  let postsService: { listPosts: jest.Mock; reply: jest.Mock; vote: jest.Mock };

  beforeEach(async () => {
    threadsService = {
      list: jest.fn().mockResolvedValue({ data: [], pageInfo: {} }),
      getBySlug: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    };
    postsService = {
      listPosts: jest.fn().mockResolvedValue({ data: [], pageInfo: {} }),
      reply: jest.fn().mockResolvedValue({}),
      vote: jest.fn().mockResolvedValue({ voteCount: 1, myVote: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ForumController],
      providers: [
        { provide: ForumThreadsService, useValue: threadsService },
        { provide: ForumPostsService, useValue: postsService },
      ],
    }).compile();
    controller = module.get(ForumController);
  });

  it('delegates listThreads with the caller id and category/cursor/limit', async () => {
    await controller.listThreads(user, {
      category: 'housing',
      cursor: 'c1',
      limit: 10,
    });
    expect(threadsService.list).toHaveBeenCalledWith(
      'user-1',
      'housing',
      'c1',
      10,
    );
  });

  it('delegates getThread by slug with the caller id', async () => {
    await controller.getThread(user, 'hello-world');
    expect(threadsService.getBySlug).toHaveBeenCalledWith(
      'hello-world',
      'user-1',
    );
  });

  it('delegates listPosts with the caller id', async () => {
    await controller.listPosts(user, 'hello-world', { cursor: 'c1', limit: 5 });
    expect(postsService.listPosts).toHaveBeenCalledWith(
      'hello-world',
      'user-1',
      'c1',
      5,
    );
  });

  it('delegates createThread with the caller id', async () => {
    const dto = { title: 'Hi', body: 'Body', category: 'general' };
    await controller.createThread(user, dto);
    expect(threadsService.create).toHaveBeenCalledWith('user-1', dto);
  });

  it('delegates reply with the caller id', async () => {
    await controller.reply(user, 'hello-world', { body: 'A reply' });
    expect(postsService.reply).toHaveBeenCalledWith(
      'hello-world',
      'user-1',
      'A reply',
    );
  });

  it('delegates vote with the caller id', async () => {
    const res = await controller.vote(user, 'post-1', { value: 1 });
    expect(postsService.vote).toHaveBeenCalledWith('post-1', 'user-1', 1);
    expect(res).toEqual({ voteCount: 1, myVote: 1 });
  });
});

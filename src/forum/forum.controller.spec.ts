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
    counts: jest.Mock;
    getBySlug: jest.Mock;
    create: jest.Mock;
    setLocked: jest.Mock;
  };
  let postsService: { listPosts: jest.Mock; reply: jest.Mock; vote: jest.Mock };

  beforeEach(async () => {
    threadsService = {
      list: jest.fn().mockResolvedValue({ data: [], pageInfo: {} }),
      counts: jest.fn().mockResolvedValue({ all: 0 }),
      getBySlug: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      setLocked: jest.fn().mockResolvedValue({}),
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

  it('delegates listThreads with the caller id and category/cursor/limit/sort/tag/q', async () => {
    await controller.listThreads(user, {
      category: 'housing',
      cursor: 'c1',
      limit: 10,
      sort: 'top',
      tag: 'rent',
      q: 'lease',
    });
    expect(threadsService.list).toHaveBeenCalledWith(
      'user-1',
      'housing',
      'c1',
      10,
      'top',
      'rent',
      'lease',
      // A plain member: the OP card lock/moderation flags stay off.
      false,
    );
  });

  it('delegates threadCounts with the caller id and q/tag', async () => {
    await controller.threadCounts(user, { q: 'lease', tag: 'rent' });
    expect(threadsService.counts).toHaveBeenCalledWith(
      'user-1',
      'lease',
      'rent',
    );
  });

  it('delegates lock/unlock with the caller and the target state', async () => {
    await controller.lockThread(user, 'hello-world');
    expect(threadsService.setLocked).toHaveBeenCalledWith(
      'hello-world',
      user,
      true,
    );

    await controller.unlockThread(user, 'hello-world');
    expect(threadsService.setLocked).toHaveBeenCalledWith(
      'hello-world',
      user,
      false,
    );
  });

  it('delegates getThread by slug with the caller id', async () => {
    await controller.getThread(user, 'hello-world');
    expect(threadsService.getBySlug).toHaveBeenCalledWith(
      'hello-world',
      'user-1',
      false,
    );
  });

  it('delegates listPosts with the caller user', async () => {
    await controller.listPosts(user, 'hello-world', { cursor: 'c1', limit: 5 });
    // listPosts takes the full CurrentUserData (it derives both the viewer id
    // and moderator role from it), so the controller forwards the whole user.
    expect(postsService.listPosts).toHaveBeenCalledWith(
      'hello-world',
      user,
      'c1',
      5,
    );
  });

  it('delegates createThread with the caller id', async () => {
    const dto = { title: 'Hi', body: 'Body', category: 'general' };
    await controller.createThread(user, dto);
    expect(threadsService.create).toHaveBeenCalledWith('user-1', dto, false);
  });

  it('threads the moderator role into the read paths', async () => {
    const mod: CurrentUserData = { ...user, role: 'moderator' };

    await controller.listThreads(mod, {});
    expect(threadsService.list).toHaveBeenLastCalledWith(
      'user-1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );

    await controller.getThread(mod, 'hello-world');
    expect(threadsService.getBySlug).toHaveBeenLastCalledWith(
      'hello-world',
      'user-1',
      true,
    );

    const dto = { title: 'Hi', body: 'Body', category: 'general' };
    await controller.createThread(mod, dto);
    expect(threadsService.create).toHaveBeenLastCalledWith('user-1', dto, true);
  });

  it('delegates reply with the caller user', async () => {
    await controller.reply(user, 'hello-world', { body: 'A reply' });
    // reply also takes the full CurrentUserData, plus the optional parentPostId
    // (undefined when replying at thread level).
    expect(postsService.reply).toHaveBeenCalledWith(
      'hello-world',
      user,
      'A reply',
      undefined,
    );
  });

  it('delegates vote with the caller id', async () => {
    const res = await controller.vote(user, 'post-1', { value: 1 });
    expect(postsService.vote).toHaveBeenCalledWith('post-1', 'user-1', 1);
    expect(res).toEqual({ voteCount: 1, myVote: 1 });
  });
});

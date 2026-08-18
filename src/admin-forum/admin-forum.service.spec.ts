import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { AdminForumService } from './admin-forum.service';

describe('AdminForumService', () => {
  let service: AdminForumService;
  let threads: jest.Mocked<Pick<ForumThreadsService, 'setOfficial'>>;

  const admin: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@example.com',
    status: 'active',
    role: 'admin',
  };

  beforeEach(() => {
    threads = {
      setOfficial: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
    };
    service = new AdminForumService(threads as unknown as ForumThreadsService);
  });

  it('delegates to ForumThreadsService.setOfficial with the same args', async () => {
    const result = await service.setThreadOfficial('hello-world', admin, true);

    expect(threads.setOfficial).toHaveBeenCalledWith(
      'hello-world',
      admin,
      true,
    );
    expect(result).toEqual({ slug: 'hello-world' });
  });
});

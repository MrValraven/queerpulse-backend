import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AdminForumController } from './admin-forum.controller';
import { AdminForumService } from './admin-forum.service';

describe('AdminForumController', () => {
  let controller: AdminForumController;
  let service: jest.Mocked<
    Pick<
      AdminForumService,
      'setThreadOfficial' | 'listReviewQueue' | 'reviewThread'
    >
  >;

  const admin: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@example.com',
    status: 'active',
    role: 'admin',
  };

  const moderator: CurrentUserData = {
    userId: 'mod-1',
    email: 'mod@example.com',
    status: 'active',
    role: 'moderator',
  };

  beforeEach(() => {
    service = {
      setThreadOfficial: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
      listReviewQueue: jest
        .fn()
        .mockResolvedValue({ data: [], pageInfo: { nextCursor: null } }),
      reviewThread: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
    };
    controller = new AdminForumController(
      service as unknown as AdminForumService,
    );
  });

  it('forwards the toggle to the service with slug, caller, and flag', async () => {
    await controller.setThreadOfficial(admin, 'hello-world', {
      isOfficial: true,
    });

    expect(service.setThreadOfficial).toHaveBeenCalledWith(
      'hello-world',
      admin,
      true,
    );
  });

  it('forwards the review queue read with the caller and the page controls', async () => {
    await controller.listReviewQueue(moderator, { cursor: 'c1', limit: 10 });

    expect(service.listReviewQueue).toHaveBeenCalledWith(moderator, 'c1', 10);
  });

  it('forwards a verdict with its note', async () => {
    await controller.reviewThread(moderator, 'hello-world', {
      decision: 'reject',
      note: 'Not while the report is open.',
    });

    expect(service.reviewThread).toHaveBeenCalledWith(
      'hello-world',
      moderator,
      { decision: 'reject', note: 'Not while the report is open.' },
    );
  });
});

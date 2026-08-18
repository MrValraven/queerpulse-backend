import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AdminForumController } from './admin-forum.controller';
import { AdminForumService } from './admin-forum.service';

describe('AdminForumController', () => {
  let controller: AdminForumController;
  let service: jest.Mocked<Pick<AdminForumService, 'setThreadOfficial'>>;

  const admin: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@example.com',
    status: 'active',
    role: 'admin',
  };

  beforeEach(() => {
    service = {
      setThreadOfficial: jest.fn().mockResolvedValue({ slug: 'hello-world' }),
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
});

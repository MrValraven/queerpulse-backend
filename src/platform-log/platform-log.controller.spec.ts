import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { PlatformLogController } from './platform-log.controller';
import type { PlatformLogService } from './platform-log.service';

describe('PlatformLogController', () => {
  it('admits moderators and admins', () => {
    expect(Reflect.getMetadata(ROLES_KEY, PlatformLogController)).toEqual([
      UserRole.Moderator,
      UserRole.Admin,
    ]);
  });

  it('passes the query and the caller role to the service', async () => {
    const page = { data: [], pageInfo: { nextCursor: null, hasMore: false } };
    const service = { list: jest.fn().mockResolvedValue(page) };
    const controller = new PlatformLogController(
      service as unknown as PlatformLogService,
    );
    const result = await controller.list(
      { range: 'week' },
      {
        userId: 'staff-1',
        email: 'staff@example.org',
        status: 'active',
        role: 'moderator',
      },
    );
    expect(service.list).toHaveBeenCalledWith(
      { range: 'week' },
      { role: 'moderator' },
    );
    expect(result).toBe(page);
  });
});

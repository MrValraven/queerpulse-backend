import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';

describe('AdminMembersController', () => {
  let controller: AdminMembersController;
  let service: {
    list: jest.Mock;
    listFlagged: jest.Mock;
    getMember: jest.Mock;
    updateInviteAccess: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      listFlagged: jest.fn(),
      getMember: jest.fn(),
      updateInviteAccess: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminMembersController],
      providers: [{ provide: AdminMembersService, useValue: service }],
    }).compile();
    controller = module.get(AdminMembersController);
  });

  it('GET / delegates to the service with the parsed query and the viewer', async () => {
    const query: ListAdminMembersQuery = { page: 2, filter: 'verified' };
    const listResult = { items: [], total: 0, page: 2, pageSize: 20 };
    service.list.mockResolvedValue(listResult);
    const viewer: CurrentUserData = {
      userId: 'user-admin',
      email: 'admin@example.com',
      status: 'active',
      role: 'admin',
    };

    const result = await controller.list(query, viewer);

    expect(service.list).toHaveBeenCalledWith(query, 'user-admin');
    expect(result).toBe(listResult);
  });

  it("GET /flagged delegates to the service's listFlagged with the viewer", async () => {
    const flaggedMembers = [{ slug: 'flagged-member' }];
    service.listFlagged.mockResolvedValue(flaggedMembers);
    const viewer: CurrentUserData = {
      userId: 'user-admin',
      email: 'admin@example.com',
      status: 'active',
      role: 'admin',
    };

    const result = await controller.listFlagged(viewer);

    expect(service.listFlagged).toHaveBeenCalledWith('user-admin');
    expect(result).toBe(flaggedMembers);
  });

  it('GET /:id delegates to the service with the id param and the viewer', async () => {
    const memberDetail = { slug: 'ines-martins' };
    service.getMember.mockResolvedValue(memberDetail);
    const viewer: CurrentUserData = {
      userId: 'user-admin',
      email: 'admin@example.com',
      status: 'active',
      role: 'admin',
    };

    const result = await controller.getMember(viewer, 'ines-martins');

    expect(service.getMember).toHaveBeenCalledWith(
      'ines-martins',
      'user-admin',
    );
    expect(result).toBe(memberDetail);
  });

  it('PATCH /:id/invite-access delegates with the slug, the flag and the acting admin', async () => {
    const inviteAccess = {
      userId: 'user-ines',
      slug: 'ines-martins',
      hasInviteAccess: false,
    };
    service.updateInviteAccess.mockResolvedValue(inviteAccess);
    const currentUser: CurrentUserData = {
      userId: 'user-admin',
      email: 'admin@example.com',
      status: 'active',
      role: 'admin',
    };

    const result = await controller.updateInviteAccess(
      currentUser,
      'ines-martins',
      { hasInviteAccess: false },
    );

    expect(service.updateInviteAccess).toHaveBeenCalledWith(
      'ines-martins',
      false,
      'user-admin',
    );
    expect(result).toBe(inviteAccess);
  });
});

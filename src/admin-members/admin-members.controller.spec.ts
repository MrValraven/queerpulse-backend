import { Test, TestingModule } from '@nestjs/testing';
import { AdminMembersController } from './admin-members.controller';
import { AdminMembersService } from './admin-members.service';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';

describe('AdminMembersController', () => {
  let controller: AdminMembersController;
  let service: {
    list: jest.Mock;
    listFlagged: jest.Mock;
    getMember: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      listFlagged: jest.fn(),
      getMember: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminMembersController],
      providers: [{ provide: AdminMembersService, useValue: service }],
    }).compile();
    controller = module.get(AdminMembersController);
  });

  it('GET / delegates to the service with the parsed query', async () => {
    const query: ListAdminMembersQuery = { page: 2, filter: 'verified' };
    const listResult = { items: [], total: 0, page: 2, pageSize: 20 };
    service.list.mockResolvedValue(listResult);

    const result = await controller.list(query);

    expect(service.list).toHaveBeenCalledWith(query);
    expect(result).toBe(listResult);
  });

  it("GET /flagged delegates to the service's listFlagged with no arguments", async () => {
    const flaggedMembers = [{ slug: 'flagged-member' }];
    service.listFlagged.mockResolvedValue(flaggedMembers);

    const result = await controller.listFlagged();

    expect(service.listFlagged).toHaveBeenCalledWith();
    expect(result).toBe(flaggedMembers);
  });

  it('GET /:id delegates to the service with the id param', async () => {
    const memberDetail = { slug: 'ines-martins' };
    service.getMember.mockResolvedValue(memberDetail);

    const result = await controller.getMember('ines-martins');

    expect(service.getMember).toHaveBeenCalledWith('ines-martins');
    expect(result).toBe(memberDetail);
  });
});

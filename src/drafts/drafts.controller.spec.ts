import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { DraftsController } from './drafts.controller';
import { DraftsService } from './drafts.service';
import { DraftKindVariant } from './entities/draft.entity';

describe('DraftsController', () => {
  let controller: DraftsController;
  let service: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DraftsController],
      providers: [{ provide: DraftsService, useValue: service }],
    })
      .overrideGuard(ActiveMemberGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(DraftsController);
  });

  it('GET / lists the caller drafts for the given page', async () => {
    const page = {
      items: [],
      total: 0,
      page: 2,
      pageSize: 20,
    };
    service.list.mockResolvedValue(page);

    const result = await controller.list(user, 2);

    expect(service.list).toHaveBeenCalledWith('u1', 2);
    expect(result).toBe(page);
  });

  it('POST / creates a draft for the caller', async () => {
    const dto = {
      id: 'invite-1720000000',
      kind: 'JOB',
      kindVariant: DraftKindVariant.Job,
      title: 't',
      desc: 'd',
      progress: 10,
    };
    const created = { ...dto };
    service.create.mockResolvedValue(created);

    const result = await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('u1', dto);
    expect(result).toBe(created);
  });

  it('PATCH /:id updates the caller draft by id', async () => {
    const dto = { progress: 90 };
    const updated = { id: 'd1', progress: 90 };
    service.update.mockResolvedValue(updated);

    const result = await controller.update(user, 'd1', dto);

    expect(service.update).toHaveBeenCalledWith('u1', 'd1', dto);
    expect(result).toBe(updated);
  });

  it('DELETE /:id removes the caller draft by id', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove(user, 'd1');

    expect(service.remove).toHaveBeenCalledWith('u1', 'd1');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ListingStatus } from './entities/listing.entity';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

describe('ListingsController', () => {
  let controller: ListingsController;
  let service: {
    create: jest.Mock;
    listMine: jest.Mock;
    getByRef: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    setStatus: jest.Mock;
  };

  const user: CurrentUserData = {
    userId: 'owner-1',
    email: 'a@b.com',
    status: 'active',
    role: 'member',
  };

  beforeEach(async () => {
    service = {
      create: jest.fn(),
      listMine: jest.fn(),
      getByRef: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      setStatus: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ListingsController],
      providers: [{ provide: ListingsService, useValue: service }],
    })
      .overrideGuard(ActiveMemberGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(ListingsController);
  });

  it('POST / creates a listing owned by the caller', async () => {
    const dto = { name: 'Lux Café' };
    const created = { ref: 'QPL-2026-0001', ...dto };
    service.create.mockResolvedValue(created);

    const result = await controller.create(user, dto);

    expect(service.create).toHaveBeenCalledWith('owner-1', dto);
    expect(result).toBe(created);
  });

  it('GET /mine lists the caller listings for the given page', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    service.listMine.mockResolvedValue(page);

    const result = await controller.listMine(user, { page: 1 });

    expect(service.listMine).toHaveBeenCalledWith('owner-1', { page: 1 });
    expect(result).toBe(page);
  });

  it('GET /:ref fetches by ref for the caller', async () => {
    const dto = { ref: 'QPL-2026-0001' };
    service.getByRef.mockResolvedValue(dto);

    const result = await controller.get(user, 'QPL-2026-0001');

    expect(service.getByRef).toHaveBeenCalledWith('QPL-2026-0001', 'owner-1');
    expect(result).toBe(dto);
  });

  it('PATCH /:ref updates by ref for the caller', async () => {
    const patch = { blurb: 'new' };
    const updated = { ref: 'QPL-2026-0001', blurb: 'new' };
    service.update.mockResolvedValue(updated);

    const result = await controller.update(user, 'QPL-2026-0001', patch);

    expect(service.update).toHaveBeenCalledWith(
      'QPL-2026-0001',
      'owner-1',
      patch,
    );
    expect(result).toBe(updated);
  });

  it('DELETE /:ref removes by ref for the caller', async () => {
    service.remove.mockResolvedValue(undefined);

    await controller.remove(user, 'QPL-2026-0001');

    expect(service.remove).toHaveBeenCalledWith('QPL-2026-0001', 'owner-1');
  });

  it('PATCH /:ref/status forwards the status transition', async () => {
    const updated = { ref: 'QPL-2026-0001', status: ListingStatus.Live };
    service.setStatus.mockResolvedValue(updated);

    const result = await controller.setStatus('QPL-2026-0001', {
      status: ListingStatus.Live,
    });

    expect(service.setStatus).toHaveBeenCalledWith(
      'QPL-2026-0001',
      ListingStatus.Live,
    );
    expect(result).toBe(updated);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminChangemakersController } from './admin-changemakers.controller';
import { ChangemakersService } from './changemakers.service';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';
import { UpdateDirectoryStatsDto } from './dto/update-directory-stats.dto';

describe('AdminChangemakersController', () => {
  let controller: AdminChangemakersController;
  let service: {
    listAdmin: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    setPublished: jest.Mock;
    remove: jest.Mock;
    updateStats: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      listAdmin: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setPublished: jest.fn(),
      remove: jest.fn(),
      updateStats: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminChangemakersController],
      providers: [{ provide: ChangemakersService, useValue: service }],
    }).compile();
    controller = module.get(AdminChangemakersController);
  });

  it('is guarded by @Roles(UserRole.Admin)', () => {
    const roles = Reflect.getMetadata(ROLES_KEY, AdminChangemakersController);
    expect(roles).toEqual([UserRole.Admin]);
  });

  it('GET / delegates to listAdmin with no arguments', async () => {
    const profiles = [{ id: 'id-1' }];
    service.listAdmin.mockResolvedValue(profiles);

    const result = await controller.list();

    expect(service.listAdmin).toHaveBeenCalledWith();
    expect(result).toBe(profiles);
  });

  it('PATCH /stats delegates to updateStats with the body', async () => {
    const dto: UpdateDirectoryStatsDto = {
      peopleHelped: 1200,
      activeCampaigns: 12,
    };
    const stats = { profiled: 3, causeAreas: 2, ...dto };
    service.updateStats.mockResolvedValue(stats);

    const result = await controller.updateStats(dto);

    expect(service.updateStats).toHaveBeenCalledWith(dto);
    expect(result).toBe(stats);
  });

  it('POST / delegates to create with the body', async () => {
    const dto: CreateChangemakerDto = {
      name: 'Ada Lovelace',
      initials: 'AL',
      cause: 'Housing',
      tint: 'jade',
      tags: [],
      summary: 'Summary',
      impact: [],
    };
    const created = { id: 'id-1', slug: 'ada-lovelace' };
    service.create.mockResolvedValue(created);

    const result = await controller.create(dto);

    expect(service.create).toHaveBeenCalledWith(dto);
    expect(result).toBe(created);
  });

  it('PATCH /:id delegates to update with the id and body', async () => {
    const dto: UpdateChangemakerDto = { name: 'Updated Name' };
    const updated = { id: 'id-1', name: 'Updated Name' };
    service.update.mockResolvedValue(updated);

    const result = await controller.update('id-1', dto);

    expect(service.update).toHaveBeenCalledWith('id-1', dto);
    expect(result).toBe(updated);
  });

  it('PATCH /:id/publish delegates to setPublished with the id and published flag', async () => {
    const published = { id: 'id-1', status: 'published' };
    service.setPublished.mockResolvedValue(published);

    const result = await controller.publish('id-1', { published: true });

    expect(service.setPublished).toHaveBeenCalledWith('id-1', true);
    expect(result).toBe(published);
  });

  it('DELETE /:id delegates to remove with the id', async () => {
    service.remove.mockResolvedValue(undefined);

    const result = await controller.remove('id-1');

    expect(service.remove).toHaveBeenCalledWith('id-1');
    expect(result).toBeUndefined();
  });
});

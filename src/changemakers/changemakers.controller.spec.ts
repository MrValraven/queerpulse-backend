import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ChangemakersController } from './changemakers.controller';
import { ChangemakersService } from './changemakers.service';

describe('ChangemakersController', () => {
  let controller: ChangemakersController;
  let service: {
    listPublic: jest.Mock;
    getPublicBySlug: jest.Mock;
  };

  beforeEach(async () => {
    service = {
      listPublic: jest.fn(),
      getPublicBySlug: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChangemakersController],
      providers: [{ provide: ChangemakersService, useValue: service }],
    }).compile();
    controller = module.get(ChangemakersController);
  });

  it('GET / delegates to listPublic with no arguments', async () => {
    const listResponse = {
      profiles: [],
      stats: {
        profiled: 0,
        causeAreas: 0,
        peopleHelped: 0,
        activeCampaigns: 0,
      },
    };
    service.listPublic.mockResolvedValue(listResponse);

    const result = await controller.list();

    expect(service.listPublic).toHaveBeenCalledWith();
    expect(result).toBe(listResponse);
  });

  it('GET /:slug delegates to getPublicBySlug with the slug param', async () => {
    const profile = { id: 'id-1', slug: 'ada-lovelace' };
    service.getPublicBySlug.mockResolvedValue(profile);

    const result = await controller.getBySlug('ada-lovelace');

    expect(service.getPublicBySlug).toHaveBeenCalledWith('ada-lovelace');
    expect(result).toBe(profile);
  });

  it('is member-only: ActiveMemberGuard on the class with private caching', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ChangemakersController),
    ).toEqual([ActiveMemberGuard]);
    for (const handlerName of ['list', 'getBySlug'] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        ChangemakersController.prototype,
        handlerName,
      )?.value as object;
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toBeUndefined();
    }
  });
});

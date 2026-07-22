import { Test, TestingModule } from '@nestjs/testing';
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
});

import { Test, TestingModule } from '@nestjs/testing';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';

describe('AdminOverviewController', () => {
  let controller: AdminOverviewController;
  let service: { getOverview: jest.Mock };

  beforeEach(async () => {
    service = {
      getOverview: jest.fn().mockResolvedValue({}),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminOverviewController],
      providers: [{ provide: AdminOverviewService, useValue: service }],
    }).compile();
    controller = module.get(AdminOverviewController);
  });

  it('GET / delegates to the service with no arguments', async () => {
    const overview = { stats: {} };
    service.getOverview.mockResolvedValue(overview);

    const result = await controller.getOverview();

    expect(service.getOverview).toHaveBeenCalledWith();
    expect(result).toBe(overview);
  });
});

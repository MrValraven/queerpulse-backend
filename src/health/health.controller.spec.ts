import { Test, TestingModule } from '@nestjs/testing';
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  const okResult = {
    status: 'ok',
    info: { database: { status: 'up' } },
    error: {},
    details: { database: { status: 'up' } },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: { check: jest.fn().mockResolvedValue(okResult) },
        },
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('reports ok when the database ping succeeds', async () => {
    await expect(controller.check()).resolves.toEqual(okResult);
  });
});

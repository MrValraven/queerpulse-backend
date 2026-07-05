import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let check: jest.Mock;
  let pingCheck: jest.Mock;
  const okResult = {
    status: 'ok',
    info: { database: { status: 'up' } },
    error: {},
    details: { database: { status: 'up' } },
  };

  beforeEach(async () => {
    check = jest.fn().mockResolvedValue(okResult);
    pingCheck = jest.fn().mockReturnValue({ database: { status: 'up' } });
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthCheckService,
          useValue: { check },
        },
        {
          provide: TypeOrmHealthIndicator,
          useValue: { pingCheck },
        },
      ],
    }).compile();

    controller = module.get(HealthController);
  });

  it('reports ok when the database ping succeeds', async () => {
    await expect(controller.check()).resolves.toEqual(okResult);
  });

  it('liveness runs no dependency checks', async () => {
    await expect(controller.live()).resolves.toEqual(okResult);
    // Called with an empty indicator array — no DB ping in the liveness path.
    const indicators = check.mock.calls[0][0] as unknown[];
    expect(indicators).toHaveLength(0);
    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('readiness pings the database', async () => {
    await expect(controller.ready()).resolves.toEqual(okResult);
    const indicators = check.mock.calls[0][0] as Array<() => unknown>;
    expect(indicators).toHaveLength(1);
    // Invoke the registered indicator to prove it drives the DB ping.
    indicators[0]();
    expect(pingCheck).toHaveBeenCalledWith('database');
  });
});

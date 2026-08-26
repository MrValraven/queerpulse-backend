import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PlatformProbesService } from './platform-probes.service';

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
        // The real probe registry, wired to the mocked indicator above: the
        // controller no longer names `pingCheck('database')` itself, it asks
        // `PlatformProbesService` for the indicator list, so the assertions
        // below still prove the DB ping is what gets registered.
        PlatformProbesService,
        // The two DB-pinging probes sit behind `MetricsTokenGuard`, which
        // Nest instantiates for the controller even though these tests call
        // the handlers directly. Its only dependency is the config.
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
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
    const calls = check.mock.calls as unknown[][];
    const indicators = (calls[0]?.[0] ?? []) as unknown[];
    expect(indicators).toHaveLength(0);
    expect(pingCheck).not.toHaveBeenCalled();
  });

  it('readiness pings the database', async () => {
    await expect(controller.ready()).resolves.toEqual(okResult);
    const calls = check.mock.calls as unknown[][];
    const indicators = (calls[0]?.[0] ?? []) as Array<() => unknown>;
    expect(indicators).toHaveLength(1);
    // Invoke the registered indicator to prove it drives the DB ping.
    const indicator = indicators[0];
    expect(indicator).toBeDefined();
    indicator?.();
    expect(pingCheck).toHaveBeenCalledWith('database');
  });
});

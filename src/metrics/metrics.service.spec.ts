import { DataSource } from 'typeorm';
import { MetricsService } from './metrics.service';

// A fake DataSource whose `driver.master` mimics the pg Pool counters the pool
// gauge reads at scrape time. `null` driver exercises the pre-init guard.
function dataSourceWithPool(
  pool: { totalCount: number; idleCount: number; waitingCount: number } | null,
): DataSource {
  return { driver: pool ? { master: pool } : {} } as unknown as DataSource;
}

describe('MetricsService', () => {
  it('exposes an isolated registry and its Prometheus content type', () => {
    const service = new MetricsService(dataSourceWithPool(null));
    expect(service.contentType).toContain('text/plain');
  });

  it('records HTTP request durations with method/route/status labels', async () => {
    const service = new MetricsService(dataSourceWithPool(null));

    service.observeHttpRequest('GET', '/v1/profiles/:slug', 200, 0.042);

    const scrape = await service.scrape();
    expect(scrape).toContain('http_request_duration_seconds');
    expect(scrape).toContain('method="GET"');
    expect(scrape).toContain('route="/v1/profiles/:slug"');
    expect(scrape).toContain('status_code="200"');
  });

  it('tracks the live websocket connection count up and down', async () => {
    const service = new MetricsService(dataSourceWithPool(null));

    service.incrementWebsocketConnections();
    service.incrementWebsocketConnections();
    service.decrementWebsocketConnections();

    const scrape = await service.scrape();
    expect(scrape).toContain('websocket_connections 1');
  });

  it('derives pool occupancy from the live pg pool at scrape time', async () => {
    const service = new MetricsService(
      dataSourceWithPool({ totalCount: 10, idleCount: 4, waitingCount: 2 }),
    );

    const scrape = await service.scrape();
    expect(scrape).toContain('database_pool_connections{state="total"} 10');
    expect(scrape).toContain('database_pool_connections{state="idle"} 4');
    // in_use = total - idle
    expect(scrape).toContain('database_pool_connections{state="in_use"} 6');
    expect(scrape).toContain('database_pool_connections{state="waiting"} 2');
  });

  it('does not throw when the pool is not yet initialised', async () => {
    const service = new MetricsService(dataSourceWithPool(null));
    await expect(service.scrape()).resolves.toEqual(expect.any(String));
  });

  it('onModuleInit wires the default process/runtime series without throwing', async () => {
    const service = new MetricsService(dataSourceWithPool(null));
    expect(() => service.onModuleInit()).not.toThrow();
    const scrape = await service.scrape();
    expect(scrape).toContain('process_cpu_user_seconds_total');
  });
});

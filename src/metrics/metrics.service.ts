import { Injectable, OnModuleInit } from '@nestjs/common';
import { Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DataSource } from 'typeorm';

/**
 * The single owner of the Prometheus registry and every custom metric.
 *
 * A DEDICATED `Registry` (not prom-client's global default) so the metrics this
 * app exposes are exactly the ones defined here — no leakage from a library that
 * happens to touch the global default, and no cross-test contamination.
 *
 * Deliberately minimal (the §D "no metrics" P1): process/runtime defaults, an
 * HTTP request-duration histogram, a Postgres pool gauge, and a WebSocket
 * connection-count gauge. It is scraped at `/metrics` (see MetricsController).
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  /**
   * HTTP request duration, labelled by method / matched-route / status code.
   * Fed by {@link HttpMetricsMiddleware} at `res` `finish`, so the status code
   * is the FINAL one the exception filter settled on, not a mid-pipeline guess.
   * Route is the ROUTE PATTERN (e.g. `/v1/profiles/:slug`), never the concrete
   * URL — using the raw URL would make `:slug` unbounded cardinality.
   */
  private readonly httpRequestDuration: Histogram<string>;

  /** Currently-connected chat WebSocket clients (see ChatGateway inc/dec). */
  private readonly websocketConnections: Gauge<string>;

  /**
   * pg pool occupancy, labelled by `state` (in_use / idle / waiting / total).
   * Read at scrape time via a `collect` callback off the live TypeORM pool, so
   * there is nothing to keep in sync — the numbers are whatever the driver holds
   * the instant Prometheus asks.
   */
  private readonly databasePoolConnections: Gauge<string>;

  constructor(private readonly dataSource: DataSource) {
    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds, by method, route and status code.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.websocketConnections = new Gauge({
      name: 'websocket_connections',
      help: 'Number of currently connected chat WebSocket clients.',
      registers: [this.registry],
    });

    const poolSource = this.dataSource;
    this.databasePoolConnections = new Gauge({
      name: 'database_pool_connections',
      help: 'Postgres connection-pool occupancy by state (in_use/idle/waiting/total).',
      labelNames: ['state'],
      registers: [this.registry],
      collect() {
        // TypeORM's PostgresDriver holds the pg Pool on `master`. Typed loosely
        // because that field is not on the public driver surface; guard for the
        // window before the pool is initialised (or a non-pg driver in a test).
        const pool = (
          poolSource?.driver as unknown as {
            master?: {
              totalCount: number;
              idleCount: number;
              waitingCount: number;
            };
          }
        )?.master;
        if (!pool) {
          return;
        }
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'in_use' }, pool.totalCount - pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }

  onModuleInit(): void {
    // Standard process/runtime series (CPU, memory, event-loop lag, GC, …).
    collectDefaultMetrics({ register: this.registry });
  }

  observeHttpRequest(
    method: string,
    route: string,
    statusCode: number,
    durationSeconds: number,
  ): void {
    this.httpRequestDuration.observe(
      { method, route, status_code: String(statusCode) },
      durationSeconds,
    );
  }

  incrementWebsocketConnections(): void {
    this.websocketConnections.inc();
  }

  decrementWebsocketConnections(): void {
    this.websocketConnections.dec();
  }

  /** The exposition text Prometheus scrapes. */
  scrape(): Promise<string> {
    return this.registry.metrics();
  }

  /** The Content-Type the scrape body must be served with. */
  get contentType(): string {
    return this.registry.contentType;
  }
}

import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
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
   * Report filings refused by a rolling flood cap (TS-05), labelled by which
   * cap was hit (`daily` or `subject`). Fed by `ReportsService`.
   *
   * This is the only view a moderation surface has of a refused filing, and it
   * exists because a refusal writes NO row. Everything watching moderation load
   * counts rows: the queue-health aggregate, the queue-depth gauges, the hourly
   * alert cron. So without this series a concerted flood becomes LESS visible
   * once the caps start biting than it was before they existed, because the
   * filings past the ceiling stop landing on the queue and turn into log lines
   * nobody watches.
   *
   * Labelled by `cap` and nothing else, deliberately. A reporter id here would
   * be unbounded cardinality, and the identity of a member who tripped a cap
   * belongs in the moderation log line rather than a public-ish scrape surface.
   */
  private readonly reportFloodRefusals: Counter<string>;

  /**
   * Moderator workload, labelled by `queue` (TS-04). Three series because a
   * queue is unhealthy in three independent ways and one number hides two of
   * them: how much is waiting, how many items are past their own published
   * window, and how long the oldest item has been waiting.
   *
   * PUSHED, not `collect`-ed. Unlike `database_pool_connections` below, these
   * cost seven database queries to produce, so a scrape-time callback would
   * run all seven every 15 seconds forever.
   * {@link recordModerationQueueHealth} is called instead by the hourly alert
   * cron and again whenever a moderator opens the console, which is recent
   * enough for a queue measured in hours.
   *
   * Label cardinality is bounded by `ModerationQueueKey`, a code-defined set
   * of five, so this can never behave like a raw URL label.
   */
  private readonly moderationQueueDepth: Gauge<string>;

  private readonly moderationQueueOverdue: Gauge<string>;

  private readonly moderationQueueOldestItemAgeSeconds: Gauge<string>;

  /**
   * Active accounts on the platform `moderator`/`admin` tier, the denominator
   * that turns a queue depth into a per-person load, and the series that makes
   * "the queues are fine, there is nobody left to work them" visible on its
   * own.
   */
  private readonly moderationActiveModerators: Gauge<string>;

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

    this.reportFloodRefusals = new Counter({
      name: 'moderation_report_flood_refusals_total',
      help: 'Report filings refused by a rolling flood cap, by which cap was hit.',
      labelNames: ['cap'],
      registers: [this.registry],
    });

    this.moderationQueueDepth = new Gauge({
      name: 'moderation_queue_depth',
      help: 'Items waiting in each moderation queue.',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.moderationQueueOverdue = new Gauge({
      name: 'moderation_queue_overdue',
      help: "Items in each moderation queue already past that queue's own published due date.",
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.moderationQueueOldestItemAgeSeconds = new Gauge({
      name: 'moderation_queue_oldest_item_age_seconds',
      help: 'Age in seconds of the oldest item still waiting in each moderation queue.',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.moderationActiveModerators = new Gauge({
      name: 'moderation_active_moderators',
      help: 'Active accounts holding the platform moderator or admin role.',
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

  /**
   * Count one report filing refused by a flood cap. `cap` is the low-cardinality
   * discriminator (`daily` or `subject`), matching the `cap` field on the
   * refusal body so a spike here and a member's 429 name the same thing.
   */
  incrementReportFloodRefusal(cap: string): void {
    this.reportFloodRefusals.inc({ cap });
  }

  /**
   * Publish one moderation-queue-health measurement to the gauges (TS-04).
   *
   * The parameter is described STRUCTURALLY rather than by importing
   * `ModerationQueueHealthDTO`, so this module keeps its "depends only on the
   * TypeORM DataSource" property and the dependency arrow points one way:
   * `admin-moderation-health` reaches into metrics, never the reverse.
   *
   * `reset()` before each write, so a queue that is removed from the code
   * stops reporting a stale label rather than freezing at its last value
   * forever. Ages are exported in SECONDS, which is the Prometheus convention
   * (`http_request_duration_seconds` above) even though the API and the
   * thresholds speak in hours; an empty queue has no oldest item and is
   * exported as 0, the only value an age gauge can honestly carry for "there
   * is nothing waiting".
   */
  recordModerationQueueHealth(health: {
    activeModeratorCount: number;
    queues: {
      queue: string;
      depth: number;
      overdueCount: number;
      oldestItemHours: number | null;
    }[];
  }): void {
    this.moderationQueueDepth.reset();
    this.moderationQueueOverdue.reset();
    this.moderationQueueOldestItemAgeSeconds.reset();
    for (const entry of health.queues) {
      const labels = { queue: entry.queue };
      this.moderationQueueDepth.set(labels, entry.depth);
      this.moderationQueueOverdue.set(labels, entry.overdueCount);
      this.moderationQueueOldestItemAgeSeconds.set(
        labels,
        (entry.oldestItemHours ?? 0) * 3600,
      );
    }
    this.moderationActiveModerators.set(health.activeModeratorCount);
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

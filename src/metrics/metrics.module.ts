import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

/**
 * Prometheus metrics: the scrape endpoint, the request-duration middleware, and
 * the pool/WS gauges owned by {@link MetricsService}.
 *
 * `@Global` so MetricsService injects into cross-cutting collectors (e.g.
 * ChatGateway's WS gauge) without every feature module importing this one.
 * MetricsService depends only on the TypeORM `DataSource`, which DatabaseModule
 * provides app-wide.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsTokenGuard, HttpMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Time every route, metrics endpoint included (harmless self-measurement).
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}

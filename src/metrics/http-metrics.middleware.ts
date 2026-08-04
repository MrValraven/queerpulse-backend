import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Times every HTTP request and feeds the duration histogram.
 *
 * Observes on `res` `finish` (not in an interceptor's `tap`) for two reasons:
 * the status code read there is the FINAL one — the exception filter has already
 * run and overwritten a mid-pipeline default — and the timing spans the whole
 * response, tail included. The route label is the matched ROUTE PATTERN, which
 * is only populated on `req.route` once routing has completed; by `finish` it
 * always is. Unmatched requests (404 before a route binds) fall back to a single
 * `unmatched` bucket so a scanner probing random paths can't explode cardinality.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startNanoseconds = process.hrtime.bigint();
    response.on('finish', () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startNanoseconds) / 1e9;
      // `req.route` is typed `any` by @types/express; a matched route carries a
      // `path` pattern, and `baseUrl` prefixes the version/mount segment. Narrow
      // the `any` to a typed shape first so the `.path` access is not unsafe.
      const matchedRoute = request.route as { path?: string } | undefined;
      const routePath = matchedRoute?.path;
      const route = routePath
        ? `${request.baseUrl ?? ''}${routePath}`
        : 'unmatched';
      this.metrics.observeHttpRequest(
        request.method,
        route,
        response.statusCode,
        durationSeconds,
      );
    });
    next();
  }
}

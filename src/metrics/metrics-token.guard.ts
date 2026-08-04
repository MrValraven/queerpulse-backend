import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Gates `/metrics` on a shared bearer token when one is configured.
 *
 * `/metrics` is `@Public()` (a Prometheus scraper carries no session cookie) and
 * would otherwise expose route inventory, pool saturation and traffic shape to
 * anyone. When `METRICS_TOKEN` is set, callers must present it as
 * `Authorization: Bearer <token>` (constant-time compared). When it is UNSET the
 * endpoint is open — the intended posture for local dev, or a deploy that
 * restricts the route at the network/private-network layer instead. The env
 * validation makes the token REQUIRED in production (see env.validation.ts), so
 * "open" can never be the accidental production state.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedToken = this.configService.get<string>('METRICS_TOKEN');
    if (!expectedToken) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const presentedToken = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';
    const presentedBuffer = Buffer.from(presentedToken);
    const expectedBuffer = Buffer.from(expectedToken);
    return (
      presentedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(presentedBuffer, expectedBuffer)
    );
  }
}

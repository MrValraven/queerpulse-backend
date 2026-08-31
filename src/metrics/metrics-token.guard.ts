import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Gates `/metrics` (and the two DB-pinging `/health` variants) on a shared
 * bearer token.
 *
 * Those routes are `@Public()` (a Prometheus scraper carries no session cookie)
 * and would otherwise expose route inventory, pool saturation and traffic shape
 * to anyone. Callers must present the token as `Authorization: Bearer <token>`,
 * constant-time compared.
 *
 * Behaviour when `METRICS_TOKEN` is UNSET depends on the environment:
 *   - production: DENY. A route publishing this much about the deployment earns
 *     failing closed on its own merits: an absent secret reads as an absent
 *     authorisation. Boot still succeeds without a token, because production
 *     may already be running that way and a fatal check would turn a
 *     configuration gap into a failed deploy. `env.validation.ts` covers the
 *     gap with a loud `[env]` warning at startup naming the three routes this
 *     closes (`/metrics`, `/health`, `/health/ready`) and how to reopen them,
 *     so the boot log is where the operator learns of the 403s.
 *   - development/test: ALLOW, so a local scrape or an e2e probe needs no
 *     setup. Neither environment is reachable from the internet.
 *
 * `/health/live` carries no guard at all, so the orchestrator healthcheck in
 * `railway.json` passes whatever this decides. A production deploy with no
 * token therefore stays green while the other three routes are shut, which is
 * precisely why the boot warning has to be loud.
 *
 * Railway's private networking is still the outer layer in production; this
 * guard is the one that survives a misrouted proxy or a custom domain.
 */
@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expectedToken = this.configService.get<string>('METRICS_TOKEN');
    if (!expectedToken) {
      // Fail closed in production, open everywhere else. See the class doc.
      return this.configService.get<string>('app.nodeEnv') !== 'production';
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

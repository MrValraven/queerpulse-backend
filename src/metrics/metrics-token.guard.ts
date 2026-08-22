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
 *   - production: DENY. `env.validation.ts` refuses to boot without the token
 *     there, so an unset token in production means something has bypassed
 *     validation. Failing closed keeps the guard a real control instead of a
 *     no-op that silently publishes the scrape.
 *   - development/test: ALLOW, so a local scrape or an e2e probe needs no
 *     setup. Neither environment is reachable from the internet.
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

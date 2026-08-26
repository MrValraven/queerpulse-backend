import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { PublicStatusDto } from './dto/public-status.dto';
import { StatusService } from './status.service';
import { STATUS_BROWSER_CACHE, STATUS_CDN_CACHE } from './status.cache';

/**
 * The one surface that has to answer when nothing else does.
 *
 * QueerPulse delivers no email, so a member who cannot get in has no channel
 * that can reach them. Without this page, "the platform is down", "I have been
 * suspended" and "my account is broken" are the same silence. Everything about
 * this controller follows from that:
 *
 *  - `@Public()` — it must answer with no session, and specifically for someone
 *    who is signed out, suspended or locked out. The frontend route is public
 *    too (`/system/status` is absent from `GATED_PATTERNS` in `authGate.ts`).
 *  - `@LockdownExempt()` — the platform kill switch is precisely the moment a
 *    member most needs this page, and skipping that guard also means the request
 *    does not read platform settings out of a database that may be the thing
 *    that is down.
 *  - `@SkipThrottle()` — the throttler keys on `req.ip` and does not honour
 *    `@Public()`, so behind a proxy an outage (when everybody reloads this page
 *    at once) is exactly when it would start returning 429s. Load is handled by
 *    the in-process memo in `StatusService` plus the CDN window below, not by
 *    turning people away. Same reasoning as `/health/live`.
 *
 * `StatusService.getPublicStatus()` never rejects, so there is no failure mode
 * here that produces a 500 in place of an answer.
 */
@ApiTags('Status')
@Public()
@LockdownExempt()
@SkipThrottle()
@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get()
  @ApiOperation({
    summary: 'Public platform status: component health and open incidents',
  })
  @ApiOkResponse({
    type: PublicStatusDto,
    description:
      'Per-component state, operator-authored incidents (current plus ' +
      'recently resolved) and an overall summary. Answers even while the ' +
      'database is unreachable, in which case every component reads `down` ' +
      'and `isIncidentHistoryUnavailable` is true.',
  })
  // Split deliberately: `stale-while-revalidate` in `Cache-Control` would hand
  // the stale window to the member's own browser. See `status.cache.ts`.
  @Header('Cache-Control', STATUS_BROWSER_CACHE)
  @Header('CDN-Cache-Control', STATUS_CDN_CACHE)
  getStatus(): Promise<PublicStatusDto> {
    return this.status.getPublicStatus();
  }
}

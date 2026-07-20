import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { PRESIGN_EXPIRY_SECONDS, StorageService } from './storage.service';
import { parseStorageKey } from './storage-key';

// `max-age` is deliberately SHORTER than `PRESIGN_EXPIRY_SECONDS`. At equal
// values a cached 302 replayed just before expiry hands the browser a
// presigned URL with a second of life left, and clock skew turns that into
// intermittently broken images. The 60s margin is the safety buffer against
// that skew, derived from the real TTL so the two can never drift apart —
// previously this was a bare literal (240) with only a comment tying it to
// the TTL, so changing the TTL would silently break the invariant.
const PUBLIC_IMAGE_MAX_AGE_SECONDS = PRESIGN_EXPIRY_SECONDS - 60;

// Railway Buckets are private and expose no public URL, so every uploaded image
// is reached through here. This route does NOT proxy bytes: it authorizes, then
// 302s to a short-lived presigned GET, and the browser fetches from the bucket
// directly. No service egress, one signature per image load.
//
// It works with a plain `<img src>` because the session is an httpOnly cookie
// (`jwt.strategy.ts`), not a Bearer header — browsers attach cookies to image
// requests. The cookie is SameSite=Lax, so this depends on the frontend and API
// being same-site, which the session already requires.
//
// Images are inert (never executed), already authorized per-kind below, and a
// lockdown that blanks the admin console's own avatars/photos would prevent
// the person lifting the lockdown from confirming who they are looking at —
// so this route stays reachable while `PlatformLockdownGuard` is active.
@LockdownExempt()
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  // `@Public()` bypasses the global JwtAuthGuard; OptionalJwtAuthGuard then
  // populates the user when a valid cookie is present without rejecting when it
  // is not. CsrfGuard exempts GET, so no token is needed.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get('*key')
  async serve(
    // Under Express 5 / path-to-regexp 8, a named wildcard (`*key`) makes Nest
    // hand back an ARRAY of decoded path segments, not a joined string — for
    // `/files/avatars/<uuid>/<uuid>.jpg` this is
    // `["avatars", "<uuid>", "<uuid>.jpg"]`. Do not annotate this as `string`;
    // that lie is exactly what let this route 404 on every real request.
    @Param('key') rawKey: string | string[],
    @CurrentUser() user: CurrentUserData | null,
    @Res() response: Response,
  ): Promise<void> {
    // Re-join the segments path-to-regexp split apart. This is safe: the
    // anchored UUID regex in `parseStorageKey` still rejects a `%2F`-smuggled
    // segment, so no extra sanitising or re-decoding belongs here.
    const storageKey = Array.isArray(rawKey) ? rawKey.join('/') : rawKey;
    const kindSpec = parseStorageKey(storageKey);
    // A malformed key, an unknown prefix, and a probe all 404 identically —
    // never 401 — so the route never discloses which keys exist.
    if (!kindSpec) {
      throw new NotFoundException();
    }
    if (kindSpec.requiresSession && !user) {
      throw new UnauthorizedException();
    }
    const downloadUrl = await this.storage.createPresignedDownload(storageKey);
    // Railway's edge cache once served authenticated responses to the wrong
    // users (incident 2026-03-30), so shared/CDN caches are refused on every
    // kind via `private` — that half is non-negotiable. Browser-local caching
    // is safe to allow for kinds that never require a session (avatars, work
    // images, story covers): the response is the same for every viewer, and
    // caching stops a page of avatars from burning a quarter of the per-IP
    // rate-limit budget on every view. Session-gated kinds (gathering photos)
    // keep `no-store` since the response is specific to who is asking.
    response.setHeader(
      'Cache-Control',
      kindSpec.requiresSession
        ? 'private, no-store'
        : `private, max-age=${PUBLIC_IMAGE_MAX_AGE_SECONDS}`,
    );
    response.redirect(302, downloadUrl);
  }
}

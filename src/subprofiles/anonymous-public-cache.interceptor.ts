import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

// Public persona reads (`by-handle/:handle`, the nested
// `:slug/subprofiles/:subslug` GET) are best-effort authenticated: a signed-out
// visitor gets the identical, viewer-independent public view, while a signed-in
// member may get a per-viewer variant (block/mute gating, owner signals). So the
// response is only CDN/shared-cacheable when the request is ANONYMOUS.
//
// This interceptor sets the cache headers accordingly:
//   - anonymous (`req.user` absent): the shared `PUBLIC_READ_CACHE` /
//     `PUBLIC_READ_CDN_CACHE` pair, so a shared cache may hold the hot public
//     view for a minute and serve it stale for five while it revalidates,
//     while the visitor's OWN browser cache is given no stale window. See
//     `common/public-read-cache.ts`: the stale window used to reach browsers
//     too, which meant a persona owner could edit their page and still be
//     shown the pre-edit copy until their next load.
//   - authenticated: `private, no-store` on both headers, so neither a shared
//     cache nor a CDN reading the specific header can keep a per-viewer
//     variant.
//
// Guards run before interceptors (see `app.module.ts` and
// `storage-key-ownership.interceptor.ts`), so `req.user` — populated by the
// route's `OptionalJwtAuthGuard` — is already resolved here.
//
// `Vary: Cookie` is set on BOTH branches and is not optional. A shared cache
// keyed on the URL alone would store the anonymous variant and then hand it to
// the next request for the same URL regardless of its cookie — serving the
// public view to a member the persona's owner has blocked, and serving a stale
// public view back to the owner right after they edited. That exact failure
// has already happened on this platform's edge once (see the incident note in
// `files.controller.ts`), which is why the header is stated explicitly rather
// than assumed. Naming the header also keeps the authenticated `no-store`
// branch honest for any intermediary that caches despite it.
const AUTHENTICATED_CACHE_CONTROL = 'private, no-store';
const VARY_ON_SESSION = 'Cookie';

@Injectable()
export class AnonymousPublicCacheInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context
        .switchToHttp()
        .getRequest<Request & { user?: unknown }>();
      const response = context.switchToHttp().getResponse<Response>();
      response.setHeader(
        'Cache-Control',
        request.user ? AUTHENTICATED_CACHE_CONTROL : PUBLIC_READ_CACHE,
      );
      response.setHeader(
        'CDN-Cache-Control',
        request.user ? AUTHENTICATED_CACHE_CONTROL : PUBLIC_READ_CDN_CACHE,
      );
      // `res.vary()` APPENDS rather than replacing, so the `Vary: Origin` the
      // CORS layer already set survives alongside it.
      response.vary(VARY_ON_SESSION);
    }
    return next.handle();
  }
}

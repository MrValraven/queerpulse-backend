import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable } from 'rxjs';

// Public persona reads (`by-handle/:handle`, the nested
// `:slug/subprofiles/:subslug` GET) are best-effort authenticated: a signed-out
// visitor gets the identical, viewer-independent public view, while a signed-in
// member may get a per-viewer variant (block/mute gating, owner signals). So the
// response is only CDN/shared-cacheable when the request is ANONYMOUS.
//
// This interceptor sets `Cache-Control` accordingly:
//   - anonymous (`req.user` absent): `public, s-maxage=60,
//     stale-while-revalidate=300` — a shared cache may hold the hot public view
//     for a minute and serve it stale for five while it revalidates.
//   - authenticated: `private, no-store` — never let a shared cache keep a
//     per-viewer variant.
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
const ANONYMOUS_CACHE_CONTROL =
  'public, s-maxage=60, stale-while-revalidate=300';
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
        request.user ? AUTHENTICATED_CACHE_CONTROL : ANONYMOUS_CACHE_CONTROL,
      );
      // `res.vary()` APPENDS rather than replacing, so the `Vary: Origin` the
      // CORS layer already set survives alongside it.
      response.vary(VARY_ON_SESSION);
    }
    return next.handle();
  }
}

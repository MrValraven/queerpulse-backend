import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { Observable, catchError, throwError } from 'rxjs';
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

// PRD-204. A moved answer forwards an address its owner renamed away from, and
// it is true only while the reclaim cooldown is running and nothing holds the
// name in the live registry. It has to stop the instant either fails, which
// means it can never be held anywhere. The anonymous branch above hands a
// shared cache 60 seconds of freshness plus a five-minute stale window, and a
// cache is free to store a 404 that is explicitly marked cacheable — so a
// moved answer stored just before the boundary would keep forwarding visitors
// for minutes after the handle became someone else's to claim. That is the
// exact failure this forwarding was designed around, in miniature, so a moved
// response is downgraded to `no-store` on both headers.
const MOVED_CACHE_CONTROL = 'no-store';
const MOVED_CODES = new Set(['PERSONA_MOVED', 'PROFILE_MOVED']);

// Whether a thrown response is one of the forwarding payloads. The body is the
// object handed to `NotFoundException`, so it reaches us before any exception
// filter has serialized it.
function isMovedResponse(err: unknown): boolean {
  if (!(err instanceof HttpException)) return false;
  const body = err.getResponse();
  if (typeof body !== 'object' || body === null) return false;
  const { code } = body as { code?: unknown };
  return typeof code === 'string' && MOVED_CODES.has(code);
}

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
      // The headers above are set BEFORE the handler runs, so they land on a
      // thrown response too. That is what the plain 404 wants. A moved 404
      // wants the opposite, and this is the only place that holds both the
      // response object and the thrown payload.
      return next.handle().pipe(
        catchError((err: unknown) => {
          if (isMovedResponse(err)) {
            response.setHeader('Cache-Control', MOVED_CACHE_CONTROL);
            response.setHeader('CDN-Cache-Control', MOVED_CACHE_CONTROL);
          }
          return throwError(() => err);
        }),
      );
    }
    return next.handle();
  }
}

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
const ANONYMOUS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const AUTHENTICATED_CACHE_CONTROL = 'private, no-store';

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
    }
    return next.handle();
  }
}

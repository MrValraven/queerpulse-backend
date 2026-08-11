import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { storageKeyFromImageUrl } from '../common/image-url';
import { storageKeyOwnerId } from './storage-key';

// This interceptor does two related things to every image-ish string in a
// state-changing request body, in one walk:
//
// 1. NORMALIZE our own resolved URLs. `toImageUrl` serves each stored key as
//    `<apiBaseUrl>/files/<key>`, and frontend edit forms are seeded with that
//    URL (not the raw key); several re-send it on save. Left alone it would be
//    persisted verbatim, baking this environment's origin into the column — and
//    for an `http://` dev base the next read fails `toImageUrl`'s `https://`
//    check and returns null, blanking the image. So `storageKeyFromImageUrl`
//    rewrites `<apiBaseUrl>/files/<key>` back to the bare `<key>` IN PLACE,
//    before the value reaches the ValidationPipe/service, keeping storage
//    canonical (keys, not URLs) and the round-trip idempotent.
//
// 2. ENFORCE ownership of BARE keys. INVARIANT: you may only reference storage
//    keys you uploaded. A storage key (`<prefix>/<ownerUserId>/<uuid><ext>`,
//    minted in `uploads.controller.ts`) embeds the id of whoever presigned the
//    upload, but nothing else checks that segment on write — a member could
//    PATCH a field validated only by `@IsImageReference()` (which accepts any
//    well-formed key regardless of whose it is) with another member's key and
//    display that member's photo as their own. Enforced here, globally, rather
//    than in each of the DTOs/services that carry an image field, because
//    per-service enforcement has already failed once in practice — a DTO was
//    added without the check. A single request-body walk is impossible to
//    forget on the next new image field.
//
// A value normalized in step 1 is SERVER-ISSUED — the API only ever mints a
// `/files/<key>` URL for a viewer already authorised to see that image — so it
// is NOT subjected to the foreign-owner check (this is what lets a co-owner
// re-save an entity whose photo another co-owner uploaded without a spurious
// 403). The foreign-owner check applies only to a BARE key in the body, which
// is the actual write-side attack vector (a guessed/enumerated key never shown
// to the requester).
//
// Guards run before interceptors (see `app.module.ts`), so `request.user` is
// already populated here when a route is authenticated.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Bodies nest at most a few levels deep in every real DTO in this codebase
// (the deepest today is `CreateJobDto.company.work[].imageUrl`, four levels —
// see `create-job.dto.ts` -> `create-company.dto.ts`). 10 gives generous
// headroom for legitimate shapes while still capping a hostile
// deeply-nested body well short of blowing the call stack.
const MAX_TRAVERSAL_DEPTH = 10;

type BodyContainer = Record<string, unknown> | unknown[];

@Injectable()
export class StorageKeyOwnershipInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // HTTP only — a WebSocket message has no `request.body` to walk.
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) {
      return next.handle();
    }
    const body: unknown = request.body;
    if (body === null || body === undefined) {
      return next.handle();
    }

    const requesterUserId = (request as { user?: { userId?: string } }).user
      ?.userId;

    if (typeof body === 'string') {
      // A top-level string body can't be rewritten in place (nothing owns the
      // reference), but it is still ownership-checked. `inspectString`'s
      // normalized result is discarded here — a bare foreign key throws, our
      // own resolved URLs are left untouched.
      this.inspectString(body, requesterUserId);
    } else if (typeof body === 'object') {
      this.normalizeAndAssert(
        body as BodyContainer,
        requesterUserId,
        new Set(),
      );
    }

    return next.handle();
  }

  // Normalizes one string: our own `<apiBaseUrl>/files/<key>` URL → the bare
  // key (server-issued, so NOT ownership-checked); a bare foreign key throws;
  // anything else is returned verbatim. Returns the value to store back.
  private inspectString(
    value: string,
    requesterUserId: string | undefined,
  ): string {
    const normalized = storageKeyFromImageUrl(value);
    if (normalized !== value) {
      // Was one of our own resolved URLs — trusted, rewritten to its key.
      return normalized;
    }
    const ownerUserId = storageKeyOwnerId(value);
    if (ownerUserId === null) {
      return value;
    }
    // A bare storage key: enforce ownership. No authenticated user but the body
    // references a key is illegitimate too — there is no way to own one.
    if (!requesterUserId || ownerUserId !== requesterUserId) {
      throw new ForbiddenException('Referenced upload does not belong to you');
    }
    return value;
  }

  // Recursively walks plain objects and arrays, rewriting each string child in
  // place (see `inspectString`). `visited` guards against a cyclic body (not
  // reachable through normal JSON but cheap to defend anyway) and `depth` caps
  // how far a hostile deeply-nested body can push the recursion.
  private normalizeAndAssert(
    container: BodyContainer,
    requesterUserId: string | undefined,
    visited: Set<object>,
    depth = 0,
  ): void {
    // MUST throw here, never return. This is a security walk: returning
    // silently on overflow means anything nested past the cap is never
    // inspected, which is a bypass an attacker can simply choose to take —
    // e.g. `CreateListingDto.hours` (`create-listing.dto.ts`) is a bare
    // `@IsObject()` field that class-validator never descends into, so a
    // foreign storage key nested past `MAX_TRAVERSAL_DEPTH` inside `hours`
    // would reach `ListingsService` and Postgres completely unchecked. Do
    // not soften this back to a silent return.
    if (depth > MAX_TRAVERSAL_DEPTH) {
      throw new ForbiddenException(
        'Request body is nested too deeply to verify uploads',
      );
    }
    if (visited.has(container)) {
      return;
    }
    visited.add(container);

    if (Array.isArray(container)) {
      for (let index = 0; index < container.length; index += 1) {
        container[index] = this.processEntry(
          container[index],
          requesterUserId,
          visited,
          depth,
        );
      }
      return;
    }
    for (const key of Object.keys(container)) {
      container[key] = this.processEntry(
        container[key],
        requesterUserId,
        visited,
        depth,
      );
    }
  }

  // Handles one property/element value: a string is inspected (and possibly
  // rewritten to its key); a nested container recurses one level deeper.
  private processEntry(
    value: unknown,
    requesterUserId: string | undefined,
    visited: Set<object>,
    depth: number,
  ): unknown {
    if (typeof value === 'string') {
      return this.inspectString(value, requesterUserId);
    }
    if (value !== null && typeof value === 'object') {
      this.normalizeAndAssert(
        value as BodyContainer,
        requesterUserId,
        visited,
        depth + 1,
      );
    }
    return value;
  }
}

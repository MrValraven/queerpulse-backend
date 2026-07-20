import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { storageKeyOwnerId } from './storage-key';

// INVARIANT: you may only reference storage keys you uploaded. A storage key
// (`<prefix>/<ownerUserId>/<uuid><ext>`, minted in `uploads.controller.ts`)
// embeds the id of whoever presigned the upload, but nothing checked that
// segment on write — a member could PATCH a DTO field validated only by
// `@IsImageReference()` (which accepts any well-formed key, regardless of
// whose it is) with another member's key and display that member's photo as
// their own.
//
// This is enforced here, globally, rather than in each of the nine DTOs/
// services that carry an image field, because per-service enforcement has
// already failed once in practice — a DTO was added without the check during
// recent work. A single request-body walk that rejects any foreign key is
// impossible to forget on the next new image field.
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

    this.assertNoForeignStorageKey(body, requesterUserId, new Set());

    return next.handle();
  }

  // Recursively walks plain objects and arrays looking for storage-key-shaped
  // strings. `visited` guards against a cyclic body (not reachable through
  // normal JSON but cheap to defend anyway) and `depth` caps how far a
  // hostile deeply-nested body can push the recursion.
  private assertNoForeignStorageKey(
    value: unknown,
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
    if (typeof value === 'string') {
      const ownerUserId = storageKeyOwnerId(value);
      if (ownerUserId === null) {
        return;
      }
      // No authenticated user but the body references a storage key: there is
      // no legitimate way for an anonymous request to own one.
      if (!requesterUserId || ownerUserId !== requesterUserId) {
        throw new ForbiddenException(
          'Referenced upload does not belong to you',
        );
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        this.assertNoForeignStorageKey(
          item,
          requesterUserId,
          visited,
          depth + 1,
        );
      }
      return;
    }
    for (const propertyValue of Object.values(value)) {
      this.assertNoForeignStorageKey(
        propertyValue,
        requesterUserId,
        visited,
        depth + 1,
      );
    }
  }
}

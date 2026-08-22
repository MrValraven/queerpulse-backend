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
import { allowsSharedUploads } from './shared-upload-handlers';
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
// BOTH FORMS ARE OWNERSHIP-CHECKED. A normalized `/files/<key>` URL used to be
// exempted as "server-issued and therefore trusted". It is not: that URL is
// exactly what every `<img src>` on every page carries, so any member could
// copy another member's avatar URL out of the DOM and PATCH it onto their own
// profile — impersonation, plus a later replace/clear of that field deletes the
// victim's object from the bucket. The check now runs on the NORMALIZED value
// whichever form it arrived in.
//
// The multi-editor case that exemption was protecting (a moderator re-saving a
// community whose cover another moderator uploaded) survives as an ENUMERATED
// per-handler allowance — see `shared-upload-handlers.ts`, which also records
// the intended end state: the service compares against the entity's currently
// stored value and allows a foreign key only when it is unchanged.
//
// Guards run before interceptors (see `app.module.ts`), so `request.user` is
// already populated here when a route is authenticated.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Bodies nest at most a few levels deep in every real DTO in this codebase
// (the deepest today is `CreateJobDto.company.work[].imageUrl`, four levels —
// see `create-job.dto.ts` -> `create-company.dto.ts`). 10 gives generous
// headroom for legitimate shapes while still capping a hostile
// deeply-nested body well short of blowing the call stack.
const MAX_TRAVERSAL_DEPTH = 15;

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

    // Resolved per REQUEST, not per string: the handler is fixed for the whole
    // body walk. Unknown handlers are not exempt (fail-closed).
    const sharedUploadsAllowed = allowsSharedUploads(
      // Read defensively: a hand-rolled `ExecutionContext` (unit tests, a
      // future non-controller caller) may not implement these, and a missing
      // name must fail CLOSED into the strict rule, never crash the request.
      typeof context.getClass === 'function'
        ? context.getClass()?.name
        : undefined,
      typeof context.getHandler === 'function'
        ? context.getHandler()?.name
        : undefined,
    );

    if (typeof body === 'string') {
      // A top-level string body can't be rewritten in place (nothing owns the
      // reference), but it is still ownership-checked. `inspectString`'s
      // normalized result is discarded here — a foreign key throws in either
      // form.
      this.inspectString(body, requesterUserId, sharedUploadsAllowed);
    } else if (typeof body === 'object') {
      this.normalizeAndAssert(
        body as BodyContainer,
        requesterUserId,
        sharedUploadsAllowed,
        new Set(),
      );
    }

    return next.handle();
  }

  // Normalizes one string: our own `<apiBaseUrl>/files/<key>` URL → the bare
  // key; then ownership-checks whatever key came out of that, in EITHER form.
  // A foreign key throws; anything that is not one of our keys is returned
  // verbatim. Returns the value to store back.
  private inspectString(
    value: string,
    requesterUserId: string | undefined,
    sharedUploadsAllowed: boolean,
  ): string {
    const normalized = storageKeyFromImageUrl(value);
    const arrivedAsResolvedUrl = normalized !== value;

    const ownerUserId = storageKeyOwnerId(normalized);
    if (ownerUserId === null) {
      // Not one of our storage keys (external URL, ordinary text) — untouched.
      return normalized;
    }
    // A storage key: enforce ownership. No authenticated user but the body
    // references a key is illegitimate too — there is no way to own one.
    if (!requesterUserId || ownerUserId !== requesterUserId) {
      // The only exemption: an ENUMERATED multi-editor handler re-saving an
      // image that was rendered to the requester (so it arrived as the
      // resolved URL, not a bare key an attacker guessed). See
      // `shared-upload-handlers.ts` — the service owns the unchanged-value
      // check for these.
      if (arrivedAsResolvedUrl && sharedUploadsAllowed) {
        return normalized;
      }
      throw new ForbiddenException('Referenced upload does not belong to you');
    }
    return normalized;
  }

  // Recursively walks plain objects and arrays, rewriting each string child in
  // place (see `inspectString`). `visited` guards against a cyclic body (not
  // reachable through normal JSON but cheap to defend anyway) and `depth` caps
  // how far a hostile deeply-nested body can push the recursion.
  private normalizeAndAssert(
    container: BodyContainer,
    requesterUserId: string | undefined,
    sharedUploadsAllowed: boolean,
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
          sharedUploadsAllowed,
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
        sharedUploadsAllowed,
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
    sharedUploadsAllowed: boolean,
    visited: Set<object>,
    depth: number,
  ): unknown {
    if (typeof value === 'string') {
      return this.inspectString(value, requesterUserId, sharedUploadsAllowed);
    }
    if (value !== null && typeof value === 'object') {
      this.normalizeAndAssert(
        value as BodyContainer,
        requesterUserId,
        sharedUploadsAllowed,
        visited,
        depth + 1,
      );
    }
    return value;
  }
}

import {
  CallHandler,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, from, mergeMap } from 'rxjs';
import { DataSource } from 'typeorm';
import { codedErrorBody, PLATFORM_ERROR_CODE } from '../common/coded-error';
import {
  filesUrlOrNull,
  publicMediaReferenceFromImageUrl,
  storageKeyFromImageUrl,
} from '../common/image-url';
import {
  PublicMediaReference,
  parsePublicMediaReference,
} from './public-media-reference';
import { findPublicMediaReferenceValues } from './public-media-reference-route';
import { UPLOAD_ERROR_CODE } from './upload-error-codes';
import {
  allowsPersonaScopedKeys,
  allowsSharedUploads,
  allowsStudioLandingScopedKeys,
  allowsStudioSceneScopedKeys,
  allowsVjKeys,
} from './shared-upload-handlers';
import {
  isPersonaScopedKey,
  isStudioLandingScopedKey,
  isStudioSceneScopedKey,
  isVjKey,
  storageKeyOwnerId,
} from './storage-key';

// The one refusal every ownership branch below throws: a stable code beside
// the unchanged English sentence.
const UPLOAD_NOT_YOURS_BODY = codedErrorBody(
  PLATFORM_ERROR_CODE.UPLOAD_NOT_YOURS,
  'Referenced upload does not belong to you',
);

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
// 3. RESOLVE public media references (SEC-01 / SEC-04). A public read renders a
//    forum, listing or review photo by an opaque reference
//    (`<apiBaseUrl>/files/listing-reviews/<reviewId>/photo` and its siblings,
//    see `public-media-reference.ts`), and an edit form seeded from that read
//    (a reviewer editing their own review) sends it back. Before the walk
//    above, each such value is looked up server-side and rewritten IN PLACE to
//    the bare storage key the row holds, which then meets the ownership rule
//    as a BARE key: the shared-upload allowance does not apply, so a
//    reference resolves only to the requester's own upload and can never be
//    used to learn, or attach, somebody else's key. A reference that names
//    nothing is refused like a foreign key. A body that carries no reference
//    costs no query and is checked synchronously, exactly as before.
//
// Guards run before interceptors (see `app.module.ts`), so `request.user` is
// already populated here when a route is authenticated.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The most public media references one body may carry. A real edit form
// carries at most a listing gallery (12) plus its cover and shop items, so 32
// is headroom; past it the body is refused with a code before any lookup.
export const MAX_PUBLIC_MEDIA_REFERENCES_PER_BODY = 32;

const TOO_MANY_REFERENCES_BODY = codedErrorBody(
  UPLOAD_ERROR_CODE.UPLOAD_TOO_MANY_REFERENCES,
  'Request body references too many photos to verify',
);

// The only routes where a public media reference is rewritten to its
// resolved `/files/<key>` URL, which the walk then treats with the route's
// shared-upload allowance: the two listing photo framing saves, whose service
// accepts a photo only when it is already in that listing's gallery
// (`ListingsService.savePhotoFraming`) and echoes the gallery on the owner
// wire. Every other route, shared or not, gets the bare key under the strict
// owner rule, so a reference can never hand back somebody else's key.
const REFERENCE_URL_REWRITE_HANDLERS: ReadonlySet<string> = new Set([
  'ListingsController.updatePhotoFraming',
  'AdminListingsController.updatePhotoFraming',
]);

// The reference kinds a framing save addresses: a listing's gallery photos
// and its own cover.
const REFERENCE_URL_REWRITE_KINDS: ReadonlySet<PublicMediaReference['kind']> =
  new Set(['listing-gallery-photo', 'listing-cover-photo']);

// Bodies nest at most a few levels deep in every real DTO in this codebase
// (the deepest today is `CreateJobDto.company.work[].imageUrl`, four levels —
// see `create-job.dto.ts` -> `create-company.dto.ts`). 10 gives generous
// headroom for legitimate shapes while still capping a hostile
// deeply-nested body well short of blowing the call stack.
const MAX_TRAVERSAL_DEPTH = 15;

type BodyContainer = Record<string, unknown> | unknown[];

// What the handling route may reference beyond the requester's own uploads.
// Resolved once per request (the handler is fixed for the whole body walk).
interface UploadAllowances {
  /** The `SHARED_UPLOAD_HANDLERS` exemption, see `shared-upload-handlers.ts`. */
  sharedUploads: boolean;
  /** T17: a persona-scoped key, see `PERSONA_SCOPED_KEY_HANDLERS`. */
  personaScopedKeys: boolean;
  /** Studio discovery: a scene-scoped key, see
   *  `STUDIO_SCENE_SCOPED_KEY_HANDLERS`. */
  studioSceneScopedKeys: boolean;
  /** Studio landing v2: a landing-scoped key, see
   *  `STUDIO_LANDING_SCOPED_KEY_HANDLERS`. */
  studioLandingScopedKeys: boolean;
  /** VJ: a clip or thumbnail key, see `VJ_KEY_HANDLERS`. */
  vjKeys: boolean;
}

@Injectable()
export class StorageKeyOwnershipInterceptor implements NestInterceptor {
  // Optional so a spec can build the interceptor bare; without it a body that
  // carries a public media reference is refused (nothing can resolve it).
  constructor(@Optional() private readonly dataSource?: DataSource) {}

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
    // Read defensively: a hand-rolled `ExecutionContext` (unit tests, a
    // future non-controller caller) may not implement these, and a missing
    // name must fail CLOSED into the strict rule while the request carries on.
    const controllerName =
      typeof context.getClass === 'function'
        ? context.getClass()?.name
        : undefined;
    const handlerName =
      typeof context.getHandler === 'function'
        ? context.getHandler()?.name
        : undefined;
    const allowances: UploadAllowances = {
      sharedUploads: allowsSharedUploads(controllerName, handlerName),
      personaScopedKeys: allowsPersonaScopedKeys(controllerName, handlerName),
      studioSceneScopedKeys: allowsStudioSceneScopedKeys(
        controllerName,
        handlerName,
      ),
      studioLandingScopedKeys: allowsStudioLandingScopedKeys(
        controllerName,
        handlerName,
      ),
      vjKeys: allowsVjKeys(controllerName, handlerName),
    };

    const walkBody = (): void => {
      if (typeof body === 'string') {
        // A top-level string body can't be rewritten in place (nothing owns
        // the reference), but it is still ownership-checked.
        // `inspectString`'s normalized result is discarded here: a foreign
        // key throws in either form.
        this.inspectString(body, requesterUserId, allowances);
      } else if (typeof body === 'object') {
        this.normalizeAndAssert(
          body as BodyContainer,
          requesterUserId,
          allowances,
          new Set(),
        );
      }
    };

    // A top-level string body is never an edit form, so only an object body
    // is searched for public media references.
    const references =
      typeof body === 'object'
        ? this.collectPublicMediaReferences(body as BodyContainer)
        : new Set<string>();
    if (references.size === 0) {
      walkBody();
      return next.handle();
    }
    // Nobody can own an upload without a session, so a reference from a
    // signed-out caller is refused before any lookup runs.
    if (!requesterUserId) {
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
    if (references.size > MAX_PUBLIC_MEDIA_REFERENCES_PER_BODY) {
      throw new BadRequestException(TOO_MANY_REFERENCES_BODY);
    }
    return from(
      this.resolvePublicMediaReferences(
        body as BodyContainer,
        references,
        controllerName !== undefined &&
          handlerName !== undefined &&
          REFERENCE_URL_REWRITE_HANDLERS.has(
            `${controllerName}.${handlerName}`,
          ),
      ),
    ).pipe(
      mergeMap(() => {
        walkBody();
        return next.handle();
      }),
    );
  }

  // Every string in the body that is a public media reference, in either
  // form. Bounded by the same depth cap as the walk; anything deeper is left
  // for that walk, which refuses the body outright. Collection stops one past
  // the per-body cap, which is enough for the caller to refuse the body.
  private collectPublicMediaReferences(
    container: BodyContainer,
    found = new Set<string>(),
    visited = new Set<object>(),
    depth = 0,
  ): Set<string> {
    if (depth > MAX_TRAVERSAL_DEPTH || visited.has(container)) {
      return found;
    }
    visited.add(container);
    const values = Array.isArray(container)
      ? container
      : Object.values(container);
    for (const value of values) {
      if (found.size > MAX_PUBLIC_MEDIA_REFERENCES_PER_BODY) {
        return found;
      }
      if (typeof value === 'string') {
        if (publicMediaReferenceFromImageUrl(value) !== null) {
          found.add(value);
        }
      } else if (value !== null && typeof value === 'object') {
        this.collectPublicMediaReferences(
          value as BodyContainer,
          found,
          visited,
          depth + 1,
        );
      }
    }
    return found;
  }

  // Looks every collected reference up, one query per table, and rewrites it
  // in place to the stored value it names. A reference that names no member
  // storage key (a missing row, an empty slot, an external URL) is refused
  // with the ownership code, as a foreign key is.
  //
  // On a `REFERENCE_URL_REWRITE_HANDLERS` route, a listing gallery or cover
  // reference is rewritten to the resolved `/files/<key>` URL, the form a
  // read rendered before references existed, so the walk gives it that
  // route's shared-upload allowance: a co-manager or an admin repositioning a
  // photo the owner uploaded still saves, and the service keeps its own check
  // that the photo is already in the listing's gallery. Every other
  // reference, on every other route, becomes the bare key, which the walk
  // holds to the requester's own uploads (a foreign one is a 403).
  private async resolvePublicMediaReferences(
    body: BodyContainer,
    references: Set<string>,
    isFramingRoute: boolean,
  ): Promise<void> {
    if (!this.dataSource) {
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
    const values = [...references];
    const parsed: PublicMediaReference[] = [];
    for (const value of values) {
      const reference = parsePublicMediaReference(
        publicMediaReferenceFromImageUrl(value) ?? '',
      );
      if (!reference) {
        throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
      }
      parsed.push(reference);
    }
    const storedValues = await findPublicMediaReferenceValues(
      this.dataSource,
      parsed,
    );
    const storedValueByReference = new Map<string, string>();
    values.forEach((value, index) => {
      const storedValue = storedValues[index];
      if (!storedValue || storageKeyOwnerId(storedValue) === null) {
        throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
      }
      const isFramedListingPhoto =
        isFramingRoute && REFERENCE_URL_REWRITE_KINDS.has(parsed[index]!.kind);
      storedValueByReference.set(
        value,
        (isFramedListingPhoto ? filesUrlOrNull(storedValue) : null) ??
          storedValue,
      );
    });
    this.replaceStrings(body, storedValueByReference, new Set(), 0);
  }

  // Rewrites, in place, every string child that is one of the collected
  // references (the keys of `replacements`). Any other string is left
  // exactly as it arrived.
  private replaceStrings(
    container: BodyContainer,
    replacements: Map<string, string>,
    visited: Set<object>,
    depth: number,
  ): void {
    if (depth > MAX_TRAVERSAL_DEPTH || visited.has(container)) {
      return;
    }
    visited.add(container);
    const rewrite = (value: unknown): unknown => {
      if (typeof value === 'string' && replacements.has(value)) {
        return replacements.get(value);
      }
      if (value !== null && typeof value === 'object') {
        this.replaceStrings(
          value as BodyContainer,
          replacements,
          visited,
          depth + 1,
        );
      }
      return value;
    };
    if (Array.isArray(container)) {
      for (let index = 0; index < container.length; index += 1) {
        container[index] = rewrite(container[index]);
      }
      return;
    }
    for (const key of Object.keys(container)) {
      container[key] = rewrite(container[key]);
    }
  }

  // Normalizes one string: our own `<apiBaseUrl>/files/<key>` URL → the bare
  // key; then ownership-checks whatever key came out of that, in EITHER form.
  // A foreign key throws; anything that is not one of our keys is returned
  // verbatim. Returns the value to store back.
  private inspectString(
    value: string,
    requesterUserId: string | undefined,
    allowances: UploadAllowances,
  ): string {
    const normalized = storageKeyFromImageUrl(value);
    const arrivedAsResolvedUrl = normalized !== value;

    // T17: a persona-scoped key names no uploader, so the ownership rule
    // below cannot see it (`storageKeyOwnerId` is null for it, which would
    // read as "not one of our keys" and wave it through). It is refused on
    // every route except `PERSONA_SCOPED_KEY_HANDLERS`, each of which checks
    // the requester against the key's persona itself. Bare and URL forms
    // alike: those checks are exact, so the form does not matter there.
    if (isPersonaScopedKey(normalized)) {
      if (requesterUserId && allowances.personaScopedKeys) {
        return normalized;
      }
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
    // Studio discovery: a scene-scoped key names no uploader either. It is
    // refused on every route except `STUDIO_SCENE_SCOPED_KEY_HANDLERS`,
    // whose service keeps it only as the scene's stored cover.
    if (isStudioSceneScopedKey(normalized)) {
      if (requesterUserId && allowances.studioSceneScopedKeys) {
        return normalized;
      }
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
    // Studio landing v2: a landing-scoped key names no uploader either. It is
    // refused on every route except `STUDIO_LANDING_SCOPED_KEY_HANDLERS`,
    // whose service keeps it only as the slot's stored photo.
    if (isStudioLandingScopedKey(normalized)) {
      if (requesterUserId && allowances.studioLandingScopedKeys) {
        return normalized;
      }
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }
    // VJ: a clip or thumbnail key names no uploader either. It is refused on
    // every route except `VJ_KEY_HANDLERS`, whose service checks the key's
    // shape, existence and magic bytes itself.
    if (isVjKey(normalized)) {
      if (requesterUserId && allowances.vjKeys) {
        return normalized;
      }
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
    }

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
      if (arrivedAsResolvedUrl && allowances.sharedUploads) {
        return normalized;
      }
      throw new ForbiddenException(UPLOAD_NOT_YOURS_BODY);
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
    allowances: UploadAllowances,
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
          allowances,
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
        allowances,
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
    allowances: UploadAllowances,
    visited: Set<object>,
    depth: number,
  ): unknown {
    if (typeof value === 'string') {
      return this.inspectString(value, requesterUserId, allowances);
    }
    if (value !== null && typeof value === 'object') {
      this.normalizeAndAssert(
        value as BodyContainer,
        requesterUserId,
        allowances,
        visited,
        depth + 1,
      );
    }
    return value;
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { StorageService, StoredObject } from '../storage/storage.service';
import {
  isPrivateMessageKey,
  PRIVATE_MESSAGE_PREFIXES,
  UPLOAD_KIND_SPECS,
} from '../storage/upload-kinds';
import { IMAGE_UPLOAD_TYPES } from '../storage/upload-content-types';
import { parseStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { toImageUrl } from '../common/image-url';
import { escapeLikeTerm } from '../common/like-escape';
import {
  foldedHaystack,
  foldedSearchTerm,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  AdminMediaBrowseCursor,
  decodeBrowseCursor,
  encodeBrowseCursor,
} from './admin-media-browse-cursor';
import type {
  AdminMediaHeadResponse,
  AdminMediaListQuery,
  AdminMediaListResponse,
  AdminMediaObjectDTO,
  AdminMediaUploaderDTO,
  AdminMediaUploaderSearchResultDTO,
} from './dto/admin-media.dto';

/** A search term shorter than this returns no uploader results — a one- or
 *  two-character `LIKE '%x%'` would match almost everyone. */
const MIN_UPLOADER_SEARCH_LENGTH = 2;

/** Cap on uploader typeahead rows — the picker is a "find this person" jump,
 *  not a browsable roster. */
const UPLOADER_SEARCH_LIMIT = 20;

/** What the uploader typeahead matches: names and handle, accent-folded
 *  (ENG-503) so an admin typing "joao" finds "João". Database column names,
 *  qualified by the builder alias. */
const UPLOADER_SEARCH_HAYSTACK = foldedHaystack(
  'profile',
  PROFILE_NAME_SEARCH_COLUMNS,
);

const DEFAULT_LIMIT = 100;
// Was 1000. The shipped console (`useAdminMedia`) never sends `limit` at all
// — it always takes `DEFAULT_LIMIT` and paginates on `continuationToken` —
// so `MAX_LIMIT` only bounds a caller hitting this endpoint directly (e.g.
// via Swagger). `list()` mints a fresh short-TTL presigned GET credential for
// every returned row (`presignedUrl`, read straight off the cached list item
// by the drawer's "copy presigned URL" action — see
// `AdminMediaPage.tsx`'s `AdminMediaDrawer`, which has no separate per-object
// presign fetch to fall back to). That per-row presign is local SigV4
// signing, not a network round trip like `headObject`'s real per-click
// `HeadObject` call, so it isn't pool/latency pressure — but it IS a live
// bucket-read credential handed to the client for every listed row whether
// or not the admin ever opens it. Capping the page at 200 bounds how many of
// those credentials one request can mint, without touching the console's
// real (100-per-page) usage. Removing per-row presigning entirely — signing
// only the one object the admin opens, mirroring `headObject`'s "one per
// click" shape — needs a dedicated `GET /admin/media/presign?key=` endpoint
// plus a frontend change to call it lazily; both are out of scope for this
// single-file change.
const MAX_LIMIT = 200;

/** The upload-kind prefixes the console may browse, e.g. { avatars, work, ... }.
 *  Private message prefixes are left out: DM attachments are served only to
 *  conversation participants (`PRIVATE_MESSAGE_PREFIXES`), so the console never
 *  lists, signs, inspects or deletes them. */
const KNOWN_PREFIXES: ReadonlySet<string> = new Set(
  Object.values(UPLOAD_KIND_SPECS)
    .map((spec) => spec.prefix)
    .filter((prefix) => !PRIVATE_MESSAGE_PREFIXES.has(prefix)),
);

/** `KNOWN_PREFIXES` in lexical order: the order the "All" browse walks them,
 *  which matches the order a whole-bucket listing would have shown them. */
const BROWSE_PREFIX_ORDER: readonly string[] = [...KNOWN_PREFIXES].sort();

/** Extension → content type, built as the reverse of `IMAGE_UPLOAD_TYPES` (the
 *  single source of truth for accepted upload content types — see
 *  `upload-content-types.ts`) so this can never drift from what uploads
 *  actually accept, e.g. by hand-inventing an extension nothing here mints. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(IMAGE_UPLOAD_TYPES).map(([contentType, spec]) => [
    spec.extension,
    contentType,
  ]),
);

@Injectable()
export class AdminMediaService {
  private readonly logger = new Logger(AdminMediaService.name);

  constructor(
    private readonly storage: StorageService,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly references: MediaReferenceResolver,
    private readonly modAudit: ModAuditService,
  ) {}

  /** Resolve a kind name to its storage prefix (with trailing slash), or
   *  undefined for "all". Rejects an unknown kind rather than silently
   *  listing the whole bucket. */
  resolvePrefix(kind?: string): string | undefined {
    if (kind === undefined || kind === '' || kind === 'all') {
      return undefined;
    }
    if (!KNOWN_PREFIXES.has(kind)) {
      throw new BadRequestException(`Unknown upload kind: ${kind}`);
    }
    return `${kind}/`;
  }

  /** A key the console may inspect must be a well-formed key for a known kind
   *  (same authority as `GET /files/*`). 404 (not 403) on a malformed/unknown
   *  key, matching the don't-leak posture of the file route. A private
   *  message key 404s the same way, so the console cannot probe whether a DM
   *  attachment exists. */
  assertKnownKey(key: string): void {
    if (!parseStorageKey(key) || isPrivateMessageKey(key)) {
      throw new NotFoundException();
    }
  }

  async list(query: AdminMediaListQuery): Promise<AdminMediaListResponse> {
    // The "filter by uploader" view overrides kind + pagination: a member's
    // uploads span every kind prefix and are a bounded set, so they come back
    // in one page (no continuation token) sourced from a per-kind fan-out.
    const { objects: listedObjects, nextContinuationToken } = query.uploaderId
      ? await this.listByUploader(query.uploaderId)
      : await this.listByPrefixPage(query);
    // The one chokepoint before anything is resolved or signed: no private
    // message key reaches the response, and none gets a presigned GET.
    const objects = listedObjects.filter(
      (object) => !isPrivateMessageKey(object.key),
    );

    const uploaderById = await this.resolveUploaders(
      objects.map((object) => object.key),
    );
    const { references: referencesByKey, degraded } =
      await this.references.resolve(objects.map((object) => object.key));

    const mapped: AdminMediaObjectDTO[] = await Promise.all(
      objects.map(async (object) => {
        const uploaderId = storageKeyOwnerId(object.key);
        return {
          key: object.key,
          size: object.size,
          lastModified: object.lastModified,
          kind: object.key.split('/')[0] ?? '',
          uploaderId,
          contentType: this.contentTypeForKey(object.key),
          fileUrl: `/files/${object.key}`,
          presignedUrl: await this.storage.createPresignedDownload(object.key),
          uploader: uploaderId ? (uploaderById.get(uploaderId) ?? null) : null,
          references: referencesByKey.get(object.key) ?? [],
        };
      }),
    );

    return { objects: mapped, nextContinuationToken, degraded };
  }

  /** One page for the kind tab or the "All" browse. A kind tab is a single
   *  `ListObjectsV2` page paginated on the raw S3 continuation token. "All"
   *  walks the public prefixes in order (`listAcrossBrowsePrefixes`) and
   *  paginates on an opaque composite cursor. */
  private async listByPrefixPage(query: AdminMediaListQuery): Promise<{
    objects: StoredObject[];
    nextContinuationToken: string | null;
  }> {
    const prefix = this.resolvePrefix(query.prefix);
    // Defense-in-depth: `AdminMediaListQueryDto` + the global `ValidationPipe`
    // already reject a non-numeric/out-of-range `limit` at the controller
    // boundary, but this clamp does not trust that alone — an unfinite value
    // (NaN, ±Infinity) falls back to `DEFAULT_LIMIT` rather than propagating
    // into `MaxKeys` and reaching the S3 SDK as an uncaught 500.
    const requestedLimit = Number.isFinite(query.limit)
      ? (query.limit as number)
      : DEFAULT_LIMIT;
    const maxKeys = Math.min(Math.max(requestedLimit, 1), MAX_LIMIT);
    if (prefix !== undefined) {
      // A kind tab is already scoped to one browsable prefix.
      return this.storage.listObjects({
        prefix,
        continuationToken: query.continuationToken,
        maxKeys,
      });
    }

    return this.listAcrossBrowsePrefixes(query.continuationToken, maxKeys);
  }

  /**
   * The "All" browse: walks `BROWSE_PREFIX_ORDER` one prefix at a time, so the
   * private message prefixes are never requested from the bucket. A page fills
   * across prefix boundaries: when one prefix runs out, the walk moves to the
   * next and asks only for the rows still missing, so the response never
   * exceeds `maxKeys` and S3 work stays proportional to the rows returned.
   *
   * The cursor names the prefix and the S3 token inside it; it is null once
   * the last prefix is exhausted. A cursor that fails validation is a 400.
   */
  private async listAcrossBrowsePrefixes(
    continuationToken: string | undefined,
    maxKeys: number,
  ): Promise<{
    objects: StoredObject[];
    nextContinuationToken: string | null;
  }> {
    const start: AdminMediaBrowseCursor = continuationToken
      ? decodeBrowseCursor(continuationToken, KNOWN_PREFIXES)
      : { prefix: BROWSE_PREFIX_ORDER[0] ?? '', token: null };
    let prefixIndex = BROWSE_PREFIX_ORDER.indexOf(start.prefix);
    let prefixToken = start.token;
    const objects: StoredObject[] = [];

    while (prefixIndex !== -1 && prefixIndex < BROWSE_PREFIX_ORDER.length) {
      const page = await this.storage.listObjects({
        prefix: `${BROWSE_PREFIX_ORDER[prefixIndex]}/`,
        continuationToken: prefixToken ?? undefined,
        maxKeys: maxKeys - objects.length,
      });
      objects.push(...page.objects);
      if (page.nextContinuationToken !== null) {
        prefixToken = page.nextContinuationToken;
      } else {
        prefixIndex += 1;
        prefixToken = null;
      }
      if (objects.length >= maxKeys) {
        break;
      }
    }

    const nextPrefix =
      prefixIndex === -1 ? undefined : BROWSE_PREFIX_ORDER[prefixIndex];
    return {
      objects,
      nextContinuationToken:
        nextPrefix === undefined
          ? null
          : encodeBrowseCursor({ prefix: nextPrefix, token: prefixToken }),
    };
  }

  /** Every object owned by one member, across all kinds, newest-first — the
   *  "filter by uploader" view. One page, no continuation token (the set is
   *  bounded). Sorted by `lastModified` descending with nulls last, since the
   *  per-kind fan-out returns each kind's objects concatenated, not interleaved
   *  by date. The fan-out covers the private message prefixes too; `list()`
   *  drops those keys before anything is returned or signed. */
  private async listByUploader(uploaderId: string): Promise<{
    objects: StoredObject[];
    nextContinuationToken: string | null;
  }> {
    const objects = await this.storage.listUserObjects(uploaderId);
    objects.sort((first, second) => {
      const firstTime = first.lastModified ? Date.parse(first.lastModified) : 0;
      const secondTime = second.lastModified
        ? Date.parse(second.lastModified)
        : 0;
      return secondTime - firstTime;
    });
    return { objects, nextContinuationToken: null };
  }

  /**
   * Typeahead behind the console's "filter by uploader" search box. An
   * accent-folded LIKE over `first_name`/`last_name`/`slug` (the same match
   * shape as the landing eligible-member search), joined to an ACTIVE user so
   * deactivated/erased accounts don't surface, ordered by first name and
   * capped. Returns `[]` for a term under `MIN_UPLOADER_SEARCH_LENGTH`, which
   * would match almost everyone.
   *
   * Deliberately does NOT restrict to members who actually have uploads —
   * verifying that would mean a bucket sweep per candidate. A picked member with
   * no objects simply yields an empty grid, which the UI states plainly.
   */
  async searchUploaders(
    term: string | undefined,
  ): Promise<AdminMediaUploaderSearchResultDTO[]> {
    const trimmed = (term ?? '').trim();
    if (trimmed.length < MIN_UPLOADER_SEARCH_LENGTH) {
      return [];
    }
    const pattern = `%${escapeLikeTerm(trimmed)}%`;
    const rows = await this.profiles
      .createQueryBuilder('profile')
      .innerJoin('profile.user', 'user', 'user.status = :active', {
        active: UserStatus.Active,
      })
      .where(
        `${UPLOADER_SEARCH_HAYSTACK} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern },
      )
      .orderBy('profile.firstName', 'ASC')
      .addOrderBy('profile.lastName', 'ASC')
      .take(UPLOADER_SEARCH_LIMIT)
      .getMany();

    return rows.map((row) => ({
      id: row.userId,
      displayName: `${row.firstName} ${row.lastName}`.trim(),
      handle: row.slug,
      avatarUrl: toImageUrl(row.avatarUrl),
    }));
  }

  async head(key: string): Promise<AdminMediaHeadResponse> {
    this.assertKnownKey(key);
    const { contentType, contentLength } = await this.storage.headObject(key);
    return { key, contentType, contentLength };
  }

  /**
   * Permanently delete one stored object.
   *
   * This is the same bug `MyMediaService.deleteMine` was fixed for (CNT-02),
   * on the admin side: the console deleted the bucket object with NO
   * reference check at all, so one click on a still-live avatar, community
   * cover, listing photo, cinema still or magazine byline left a permanently
   * broken image with no way back. The `references` column the list renders is
   * a hint the admin may not have looked at, on data that may be a page load
   * stale; a UI warning is not an authority. It also takes the key as a QUERY
   * PARAM, which is why the global `StorageKeyOwnershipInterceptor` (a
   * body-inspecting interceptor) never saw this route either.
   *
   * Order matters. `assertKnownKey` stays FIRST so a malformed/unknown key
   * 404s with the same don't-leak posture as `head`. Then the key is proven
   * unreferenced, exactly as `deleteMine` does it:
   *  - `degraded` (a reference source threw and was swallowed) is a 503, not a
   *    green light — "no references" is UNVERIFIED, and a bucket delete is not
   *    recoverable, so "try again" is the honest answer.
   *  - a live reference is a 409 carrying the reference list, so the console
   *    can name the places to detach it from.
   *
   * `force` is the one thing this has that `deleteMine` does not, and it is
   * deliberate: unlike a member tidying their own uploads, an admin sometimes
   * MUST remove an image that is still live — an abuse/illegal-content
   * takedown is exactly the case where the object is attached to something.
   * Refusing outright would turn a safety tool into a dead end. It is
   * opt-in per request, never the default, and every use is logged with the
   * references it overrode so the action is auditable after the fact.
   *
   * A forced delete also writes a `media_force_delete` row to the moderation
   * audit trail naming the acting admin, BEFORE the object is removed: if the
   * audit write fails, the irreversible delete does not happen. Private
   * message keys 404 in `assertKnownKey`, forced or not; moderating a DM
   * attachment goes through its report.
   */
  async delete(key: string, actorId: string, force = false): Promise<void> {
    this.assertKnownKey(key);

    const { references, degraded } = await this.references.resolve([key]);
    const referencingPlaces = references.get(key) ?? [];

    if (force) {
      this.logger.warn(
        `Admin ${actorId} force-deleted stored object ${key} with ` +
          `${referencingPlaces.length} live reference(s)` +
          `${degraded ? ' (reference check degraded)' : ''}: ` +
          JSON.stringify(referencingPlaces),
      );
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        'media_force_delete',
        undefined,
        key,
      );
      await this.storage.deleteObjectByKey(key);
      return;
    }

    if (degraded) {
      throw new ServiceUnavailableException(
        'Could not verify where this upload is used. Please try again, or re-send with force=true to delete anyway.',
      );
    }
    if (referencingPlaces.length > 0) {
      throw new ConflictException({
        message:
          'This upload is still used. Detach it there first, or re-send with force=true to delete anyway.',
        references: referencingPlaces,
      });
    }

    await this.storage.deleteObjectByKey(key);
  }

  /** One batched profile lookup for every distinct owner id on this page. */
  private async resolveUploaders(
    keys: string[],
  ): Promise<Map<string, AdminMediaUploaderDTO>> {
    const ownerIds = [
      ...new Set(
        keys
          .map((key) => storageKeyOwnerId(key))
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ownerIds.length === 0) {
      return new Map();
    }
    const rows = await this.profiles.find({
      where: { userId: In(ownerIds) },
      select: ['userId', 'firstName', 'lastName', 'slug'],
    });
    return new Map(
      rows.map((row) => [
        row.userId,
        {
          id: row.userId,
          displayName: `${row.firstName} ${row.lastName}`.trim(),
          handle: row.slug,
        },
      ]),
    );
  }

  private contentTypeForKey(key: string): string | null {
    const dotIndex = key.lastIndexOf('.');
    if (dotIndex === -1) {
      return null;
    }
    const extension = key.slice(dotIndex).toLowerCase();
    return CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
  }
}

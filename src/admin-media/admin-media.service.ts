import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { StorageService, StoredObject } from '../storage/storage.service';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { IMAGE_UPLOAD_TYPES } from '../storage/upload-content-types';
import { parseStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { toImageUrl } from '../common/image-url';
import { escapeLikeTerm } from '../common/like-escape';
import { MediaReferenceResolver } from '../media-references/media-reference.resolver';
import type {
  AdminMediaHeadResponse,
  AdminMediaListQuery,
  AdminMediaListResponse,
  AdminMediaObjectDTO,
  AdminMediaUploaderDTO,
  AdminMediaUploaderSearchResultDTO,
} from './dto/admin-media.dto';

/** A search term shorter than this returns no uploader results — a one- or
 *  two-character `ILIKE '%x%'` would match almost everyone. */
const MIN_UPLOADER_SEARCH_LENGTH = 2;

/** Cap on uploader typeahead rows — the picker is a "find this person" jump,
 *  not a browsable roster. */
const UPLOADER_SEARCH_LIMIT = 20;

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

/** The set of valid upload-kind prefixes, e.g. { avatars, work, ... }. */
const KNOWN_PREFIXES = new Set(
  Object.values(UPLOAD_KIND_SPECS).map((spec) => spec.prefix),
);

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
  constructor(
    private readonly storage: StorageService,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly references: MediaReferenceResolver,
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
   *  key, matching the don't-leak posture of the file route. */
  assertKnownKey(key: string): void {
    if (!parseStorageKey(key)) {
      throw new NotFoundException();
    }
  }

  async list(query: AdminMediaListQuery): Promise<AdminMediaListResponse> {
    // The "filter by uploader" view overrides kind + pagination: a member's
    // uploads span every kind prefix and are a bounded set, so they come back
    // in one page (no continuation token) sourced from a per-kind fan-out.
    const { objects, nextContinuationToken } = query.uploaderId
      ? await this.listByUploader(query.uploaderId)
      : await this.listByPrefixPage(query);

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

  /** One `ListObjectsV2` page for the kind-tab / all-kinds browse, paginated on
   *  the S3 continuation token — the console's original list path. */
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
    return this.storage.listObjects({
      prefix,
      continuationToken: query.continuationToken,
      maxKeys,
    });
  }

  /** Every object owned by one member, across all kinds, newest-first — the
   *  "filter by uploader" view. One page, no continuation token (the set is
   *  bounded). Sorted by `lastModified` descending with nulls last, since the
   *  per-kind fan-out returns each kind's objects concatenated, not interleaved
   *  by date. */
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
   * Typeahead behind the console's "filter by uploader" search box. ILIKE over
   * `firstName`/`lastName`/`slug` (the same match shape as the landing
   * eligible-member search), joined to an ACTIVE user so deactivated/erased
   * accounts don't surface, ordered by first name and capped. Returns `[]` for a
   * term under `MIN_UPLOADER_SEARCH_LENGTH` rather than matching almost everyone.
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
        '(profile.firstName ILIKE :pattern OR profile.lastName ILIKE :pattern OR profile.slug ILIKE :pattern)',
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
   * Permanently delete one stored object. `assertKnownKey` first, so a
   * malformed/unknown key 404s with the same don't-leak posture as `head`
   * rather than reaching the storage SDK. Deletes the RAW bucket object only —
   * this console deliberately does not reverse-look-up and clear DB columns that
   * still reference the key (a still-referencing avatar/listing image simply
   * stops loading), matching its raw-bucket / orphan-cleanup purpose. The UI
   * warns the admin of exactly that before confirming.
   */
  async delete(key: string): Promise<void> {
    this.assertKnownKey(key);
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

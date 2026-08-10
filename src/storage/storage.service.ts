import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { IMAGE_UPLOAD_TYPES } from './upload-content-types';
import { UPLOAD_KIND_SPECS, UploadKind } from './upload-kinds';
import { isStorageKey } from './storage-key';

export const PRESIGN_EXPIRY_SECONDS = 300; // 5 minutes

// Orphan cleanup is UNSOLVED and deliberately out of scope. A presigned upload
// can be abandoned (a user gets the URL and never uploads, or uploads then
// discards the draft), leaving objects no DB row references. Railway Buckets
// have no lifecycle rules, so this cannot be pushed onto the bucket the way an
// S3 deployment would. The cost is storage only, never correctness. The fix,
// when it is worth building, is a scheduled sweep that lists bucket keys and
// deletes those not referenced by any image column.

export interface PresignedUpload {
  /** Short-lived presigned URL to `PUT` the raw bytes to (direct-to-storage). */
  uploadUrl: string;
  /** The storage key the caller persists once the PUT succeeds. */
  key: string;
  /** Seconds until `uploadUrl` expires. */
  expiresIn: number;
}

/** One object as returned by an admin bucket listing (metadata only). */
export interface StoredObject {
  /** Full storage key, e.g. `avatars/<userId>/<uuid>.jpg`. */
  key: string;
  /** Object size in bytes (0 when the listing omits it). */
  size: number;
  /** ISO timestamp of the object's last modification, or null when absent. */
  lastModified: string | null;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  constructor(private readonly config: ConfigService) {}

  // Upload policy lives here (not in `UploadsController`): resolve the kind's
  // storage-key prefix + byte cap, validate the requested content type against
  // the image whitelist, reject an over-cap declared `byteSize` before any
  // signature is minted, then build a user-scoped unguessable object key and
  // presign the PUT. The controller passes already-authenticated params through
  // (the caller's `userId` + the validated DTO fields) and owns none of this.
  //
  // `byteSize` is optional because the legacy avatar/work-image routes don't
  // send one — only `/presign` gets the early over-cap reject; the others rely
  // on `createPresignedUpload` pinning `ContentLength` when a size is present.
  async presignImageUpload(params: {
    kind: UploadKind;
    userId: string;
    contentType: string;
    byteSize?: number;
  }): Promise<PresignedUpload> {
    const { kind, userId, contentType, byteSize } = params;
    const typeSpec = IMAGE_UPLOAD_TYPES[contentType];
    if (!typeSpec) {
      throw new BadRequestException(`Unsupported content type: ${contentType}`);
    }
    const kindSpec = UPLOAD_KIND_SPECS[kind];
    if (!kindSpec) {
      throw new BadRequestException(`Unsupported upload kind: ${kind}`);
    }
    if (byteSize !== undefined && byteSize > kindSpec.maxBytes) {
      throw new BadRequestException(
        `File too large for ${kind}: max ${kindSpec.maxBytes} bytes`,
      );
    }
    const key = `${kindSpec.prefix}/${userId}/${randomUUID()}${typeSpec.extension}`;
    // Pass the declared size through so the presigned PUT pins `ContentLength`:
    // storage then enforces the cap itself (the client can't PUT more bytes than
    // it declared), rather than trusting the client-declared `byteSize` alone.
    return this.createPresignedUpload(key, contentType, byteSize);
  }

  // Presigned PUT: the caller `PUT`s the raw bytes straight to `uploadUrl`
  // with no cookies/CSRF — the signature alone authorizes writing this one
  // key, and the pinned `ContentType` means a client can't silently swap it
  // after the signature is minted.
  //
  // A presigned PUT cannot carry a content-length-*range* condition the way a
  // POST policy can, but signing an exact `ContentLength` DOES bind the upload
  // to that byte count: it becomes a signed header, so a client that streams
  // more (or fewer) bytes than declared fails the signature. `UploadsController`
  // still rejects an over-cap `byteSize` up front (a large declared size never
  // gets a signature at all); pinning `ContentLength` here closes the gap where
  // a client declared a small `byteSize` to pass that check, then PUT a much
  // larger body — previously the client-declared size was the *only* limit.
  // `contentLength` is optional because the legacy avatar/work-image routes
  // don't send a byte size; those keep the up-front check only.
  async createPresignedUpload(
    key: string,
    contentType: string,
    contentLength?: number,
  ): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.requireConfig('storage.bucket'),
      Key: key,
      ContentType: contentType,
      ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
    });
    const uploadUrl = await getSignedUrl(this.storageClient(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
    return { uploadUrl, key, expiresIn: PRESIGN_EXPIRY_SECONDS };
  }

  // Presigned GET: Railway Buckets are private with no public URL, so this is
  // the only way to hand bytes to a browser. `FilesController` authorizes the
  // request first, then redirects here — the bytes come straight from the
  // bucket and never pass through this service.
  async createPresignedDownload(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.requireConfig('storage.bucket'),
      Key: key,
    });
    return getSignedUrl(this.storageClient(), command, {
      expiresIn: PRESIGN_EXPIRY_SECONDS,
    });
  }

  /**
   * Best-effort delete of a SINGLE stored object, addressed by the raw value an
   * image column holds. Used on avatar / listing-photo / community-post media
   * REPLACE or CLEAR so the object the column USED to point at stops orphaning
   * in the bucket the moment that column is overwritten — the per-object twin of
   * {@link deleteUserObjects}, which only ever ran at whole-account erasure.
   *
   * The stored value is one of two things (see `common/image-url.ts`): a storage
   * KEY this service minted, or an external `https://…` URL (a Google OAuth
   * avatar, a seeded Unsplash image). Only a key is ours to delete — anything
   * that is not a well-formed key (external URL, empty, malformed) is ignored
   * and returns `false` WITHOUT touching storage, so a caller can pass the old
   * column value blindly.
   *
   * Callers treat this as non-fatal: it is invoked AFTER the DB mutation that
   * dropped the reference has committed, object deletion is not transactional,
   * and a stale object is a storage-cost issue never a correctness one — so a
   * genuine storage failure DOES throw here and the caller wraps the call in
   * try/catch + log rather than letting it roll back (or fail) the primary
   * write. Returns whether a delete was actually issued.
   */
  async deleteObjectByReference(
    storedValue: string | null | undefined,
  ): Promise<boolean> {
    if (!storedValue || !isStorageKey(storedValue)) {
      return false;
    }
    await this.storageClient().send(
      new DeleteObjectCommand({
        Bucket: this.requireConfig('storage.bucket'),
        Key: storedValue,
      }),
    );
    return true;
  }

  // The S3 `DeleteObjects` API deletes at most 1000 keys per request.
  private static readonly DELETE_BATCH_SIZE = 1000;

  /**
   * Erase every stored object a member uploaded — the storage-side half of
   * account erasure (audit §B P1). The DB rows that referenced these objects
   * (avatar, work images, listing/gathering photos, group/story covers) are
   * cascaded away when the `users` row is hard-deleted, but the objects
   * themselves live in the bucket outside Postgres and would otherwise keep
   * serving through `GET /files/*` forever.
   *
   * Enumeration is by key PREFIX, not from the DB: every key this service mints
   * embeds the uploader's user id as its middle segment
   * (`<prefix>/<userId>/<uuid><ext>` — see `presignImageUpload` and
   * `storageKeyOwnerId`), so listing `<prefix>/<userId>/` under each upload kind
   * returns exactly this member's objects — including any abandoned/orphaned
   * uploads that were presigned but never persisted to a DB column, which a
   * DB-column sweep would miss.
   *
   * Returns the number of objects deleted. Per-object delete errors are logged
   * and counted out (the batch call itself does not fail on them), so the caller
   * gets an honest count. The caller runs this AFTER the erasure DB transaction
   * commits and treats a thrown failure as best-effort — object deletion is not
   * transactional, so it must never run before the row removal it mirrors.
   */
  async deleteUserObjects(userId: string): Promise<number> {
    const bucket = this.requireConfig('storage.bucket');
    const client = this.storageClient();
    let deletedCount = 0;
    // Distinct prefixes only — every upload kind namespaces under its own.
    const prefixes = new Set(
      Object.values(UPLOAD_KIND_SPECS).map((spec) => spec.prefix),
    );
    for (const prefix of prefixes) {
      const keys = await this.listObjectKeys(
        client,
        bucket,
        `${prefix}/${userId}/`,
      );
      deletedCount += await this.deleteObjectsByKey(client, bucket, keys);
    }
    return deletedCount;
  }

  /**
   * ONE page of raw bucket objects for the admin media console (audit tooling).
   * Unlike the private `listObjectKeys` sweep used by account erasure, this does
   * NOT follow pagination internally — it returns a single `ListObjectsV2` page
   * plus the continuation token, so the admin UI can page on demand. `prefix` is
   * validated to a known upload-kind prefix by the caller (`AdminMediaService`);
   * an absent prefix lists the whole user-upload space, which is intended here.
   */
  async listObjects(params: {
    prefix?: string;
    continuationToken?: string;
    maxKeys: number;
  }): Promise<{
    objects: StoredObject[];
    nextContinuationToken: string | null;
  }> {
    const { prefix, continuationToken, maxKeys } = params;
    const response = await this.storageClient().send(
      new ListObjectsV2Command({
        Bucket: this.requireConfig('storage.bucket'),
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: maxKeys,
      }),
    );
    const objects: StoredObject[] = (response.Contents ?? [])
      .filter(
        (object): object is typeof object & { Key: string } =>
          typeof object.Key === 'string',
      )
      .map((object) => ({
        key: object.Key,
        size: object.Size ?? 0,
        lastModified: object.LastModified
          ? object.LastModified.toISOString()
          : null,
      }));
    return {
      objects,
      nextContinuationToken: response.IsTruncated
        ? (response.NextContinuationToken ?? null)
        : null,
    };
  }

  /**
   * The object's REAL content type + length straight from storage metadata,
   * for the admin console's on-demand content-type-spoofing check (a `.png`
   * key whose stored `Content-Type` is actually `text/html`). One `HeadObject`
   * per click — never run across a whole listing.
   */
  async headObject(
    key: string,
  ): Promise<{ contentType: string | null; contentLength: number | null }> {
    const response = await this.storageClient().send(
      new HeadObjectCommand({
        Bucket: this.requireConfig('storage.bucket'),
        Key: key,
      }),
    );
    return {
      contentType: response.ContentType ?? null,
      contentLength: response.ContentLength ?? null,
    };
  }

  // Every key under a prefix, following `ListObjectsV2` pagination to the end so
  // a member with more than one page of objects is fully enumerated.
  private async listObjectKeys(
    client: S3Client,
    bucket: string,
    prefix: string,
  ): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key) {
          keys.push(object.Key);
        }
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  }

  // Deletes keys in `DeleteObjects`-sized batches, returning how many actually
  // went. `DeleteObjects` reports per-object failures in `Errors` WITHOUT failing
  // the request, so each is logged and subtracted from the deleted count.
  private async deleteObjectsByKey(
    client: S3Client,
    bucket: string,
    keys: string[],
  ): Promise<number> {
    let deletedCount = 0;
    for (
      let start = 0;
      start < keys.length;
      start += StorageService.DELETE_BATCH_SIZE
    ) {
      const batch = keys.slice(start, start + StorageService.DELETE_BATCH_SIZE);
      const response = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
      for (const error of response.Errors ?? []) {
        this.logger.error(
          `Failed to delete object ${error.Key}: ${error.Code ?? ''} ${error.Message ?? ''}`.trim(),
        );
      }
      deletedCount += batch.length - (response.Errors?.length ?? 0);
    }
    return deletedCount;
  }

  private storageClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        endpoint: this.requireConfig('storage.endpoint'),
        region: this.requireConfig('storage.region'),
        // Railway Buckets use virtual-hosted-style URLs (bucket as subdomain).
        // Path-style requests are rejected.
        forcePathStyle: false,
        credentials: {
          accessKeyId: this.requireConfig('storage.accessKey'),
          secretAccessKey: this.requireConfig('storage.secretKey'),
        },
      });
    }
    return this.client;
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      // Log the exact missing key for operators; never leak internal config
      // key names to API clients.
      this.logger.error(`Object storage is not configured (missing ${key})`);
      throw new InternalServerErrorException(
        'Object storage is not configured',
      );
    }
    return value;
  }
}

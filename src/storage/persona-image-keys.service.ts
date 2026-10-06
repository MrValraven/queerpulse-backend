import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { toBareKey } from './bare-key';
import { PersonaStorageKey } from './entities/persona-storage-key.entity';
import {
  isPersonaScopedExtension,
  isPersonaScopedKey,
  parseStorageKey,
  storageKeyOwnerId,
} from './storage-key';
import { StorageService, StoredObject } from './storage.service';
import { UPLOAD_KIND_SPECS, UploadKind } from './upload-kinds';

/** Stored value (as the column holds it) to the value that replaces it.
 *  `null` clears a reference that could not be re-homed: its object is gone
 *  (so the image was unservable anyway) or it is not an image. Keeping the
 *  key would keep the uploader's id on the persona. */
export type RehomedKeys = ReadonlyMap<string, string | null>;

/**
 * What happens to a persona-scoped key among the values:
 * - `keep-own`: a key registered to THIS persona stays. A key registered to
 *   another persona (or to none) is copied, so no key is ever shown by two
 *   personas.
 * - `copy-all`: every persona-scoped key is copied to a fresh one (except
 *   `keepValues`). The unlink uses it: a key the persona showed while it was
 *   linked must not follow it into the pseudonym.
 */
export type PersonaScopedKeyMode = 'keep-own' | 'copy-all';

export interface RehomeOptions {
  /** Copy member-scoped keys (the ones carrying a user id). On for an
   *  unlinked persona, off for a linked one. Defaults to true. */
  shouldCopyMemberScoped?: boolean;
  /** Defaults to `keep-own`. */
  personaScopedMode?: PersonaScopedKeyMode;
  /** Values `copy-all` leaves alone (an image already shown by the
   *  pseudonymous persona). */
  keepValues?: readonly (string | null | undefined)[];
}

/** The persona fields `rehomeUnlinkedPersona` rewrites in memory as well, for
 *  a caller about to save its own copy of the row. */
export interface PersonaImageColumns {
  id: string;
  avatarUrl: string | null;
  coverUrl: string | null;
}

/** A persona-scoped object a member uploaded, as My uploads, the export and
 *  the admin console list it. */
export interface PersonaStoredObject extends StoredObject {
  uploadKind: UploadKind | null;
}

const UPLOAD_KIND_BY_PREFIX = new Map<string, UploadKind>(
  (Object.keys(UPLOAD_KIND_SPECS) as UploadKind[]).map((kind) => [
    UPLOAD_KIND_SPECS[kind].prefix,
    kind,
  ]),
);

/** One value to copy, with what its registry row will carry. */
interface CopyCandidate {
  storedValue: string;
  sourceKey: string;
  isPersonaScopedSource: boolean;
  uploadedById: string | null;
  uploadKind: UploadKind | null;
}

/**
 * T17: keeps an unlinked (pseudonymous) persona's images under keys that
 * name nobody.
 *
 * A member's upload is keyed `<prefix>/<userId>/<uuid><ext>`, and every
 * image a persona shows is published as `/files/<key>`. On an unlinked
 * persona that middle segment would tie the persona to the person behind it.
 * So every image an unlinked persona references is a COPY under a
 * persona-scoped key (`persona/<uuid>/<uuid><ext>`), recorded in
 * `persona_storage_keys` with the persona it belongs to, its uploader and
 * its upload kind. A persona-scoped key is also never shared by two
 * personas: one copied from another persona gets its own copy.
 *
 * Copying is a bucket side effect, so the order is: copy first, then write
 * the registry row and the rewritten columns through the caller's
 * `EntityManager`. A transaction that rolls back takes the registry row with
 * it, and `GET /files/*` serves a persona-scoped key only while a row names
 * it, so a copy left behind by a rollback is never served (the orphan sweep
 * reclaims it). Nothing old is deleted here: the source object may still be
 * referenced elsewhere, and the named persona already published it. The
 * orphan sweep reclaims it once nothing references it.
 */
@Injectable()
export class PersonaImageKeysService {
  private readonly logger = new Logger(PersonaImageKeysService.name);

  constructor(
    private readonly storage: StorageService,
    @InjectRepository(PersonaStorageKey)
    private readonly registry: Repository<PersonaStorageKey>,
  ) {}

  /** `value` after re-homing: its replacement when `rehomed` has one. */
  static applyRehome<Value extends string | null | undefined>(
    rehomed: RehomedKeys,
    value: Value,
  ): Value | string | null {
    if (value === null || value === undefined || !rehomed.has(value)) {
      return value;
    }
    return rehomed.get(value) ?? null;
  }

  /**
   * Copies the values `options` select (bare or `/files/<key>` form) to fresh
   * persona-scoped keys registered to `subprofileId`, and returns what
   * replaces each one. Values left alone (external URLs, empty values, keys
   * the options keep) are absent from the result. A crop saved on the source
   * key is copied to the new key too. The registry row keeps the source's
   * uploader and upload kind: from the key's own segment for a member-scoped
   * source, from the source's registry row for a persona-scoped one.
   *
   * The registry rows are written through `manager`: pass the transaction
   * that writes the rewritten columns, so both commit or neither does.
   */
  async rehomeKeys(
    manager: EntityManager,
    subprofileId: string,
    values: readonly (string | null | undefined)[],
    options: RehomeOptions = {},
  ): Promise<Map<string, string | null>> {
    const candidates = await this.copyCandidates(
      manager,
      subprofileId,
      values,
      options,
    );
    const rehomed = new Map<string, string | null>();
    for (const candidate of candidates) {
      const freshKey = await this.copyOrDrop(candidate);
      rehomed.set(candidate.storedValue, freshKey);
      if (freshKey === null) {
        continue;
      }
      await this.registerKey(
        manager,
        freshKey,
        subprofileId,
        candidate.uploadedById,
        candidate.uploadKind,
      );
      await manager.query(
        `INSERT INTO "media_crops" ("storage_key", "owner_id", "crop", "created_at", "updated_at")
         SELECT $1, "owner_id", "crop", now(), now()
           FROM "media_crops"
          WHERE "storage_key" = $2
         ON CONFLICT ("storage_key") DO NOTHING`,
        [freshKey, candidate.sourceKey],
      );
    }
    return rehomed;
  }

  /**
   * Records a persona-scoped key the server wrote itself
   * (`StorageService.putPersonaServerObject`) as belonging to
   * `subprofileId`, so `GET /files/*` serves it.
   */
  async registerKey(
    manager: EntityManager,
    storageKey: string,
    subprofileId: string,
    uploadedById: string | null,
    uploadKind: UploadKind | null,
  ): Promise<void> {
    await manager.insert(PersonaStorageKey, {
      storageKey,
      subprofileId,
      uploadedById,
      uploadKind,
    });
  }

  /**
   * `rehomeKeys` for an image write to a persona whose link state the caller
   * already holds (the state the write is about to save):
   * - unlinked: member-scoped keys are copied, and so is any persona-scoped
   *   key that is not this persona's own (all of them under
   *   `shouldRefreshOwnKeys`, except `keepValues`);
   * - linked: member-scoped keys stay (today's scheme), and a persona-scoped
   *   key that is not this persona's own is still copied.
   */
  async rehomeForPersona(
    manager: EntityManager,
    subprofileId: string,
    values: readonly (string | null | undefined)[],
    state: {
      isUnlinked: boolean;
      shouldRefreshOwnKeys?: boolean;
      keepValues?: readonly (string | null | undefined)[];
    },
  ): Promise<Map<string, string | null>> {
    return this.rehomeKeys(manager, subprofileId, values, {
      shouldCopyMemberScoped: state.isUnlinked,
      personaScopedMode:
        state.isUnlinked && state.shouldRefreshOwnKeys
          ? 'copy-all'
          : 'keep-own',
      keepValues: state.keepValues,
    });
  }

  /**
   * `rehomeForPersona` decided on the link state as `manager` reads it. Call
   * it under the persona row lock so the state cannot move before the write
   * commits.
   */
  async rehomeForPersonaWrite(
    manager: EntityManager,
    subprofileId: string,
    values: readonly (string | null | undefined)[],
    options: {
      shouldRefreshOwnKeys?: boolean;
      keepValues?: readonly (string | null | undefined)[];
    } = {},
  ): Promise<Map<string, string | null>> {
    const hasStorageKey = values.some(
      (value) => value && PersonaImageKeysService.isOurKey(toBareKey(value)),
    );
    if (!hasStorageKey) {
      return new Map();
    }
    const rows: { link_visibility: string }[] = await manager.query(
      `SELECT "link_visibility" FROM "subprofiles" WHERE "id" = $1`,
      [subprofileId],
    );
    return this.rehomeForPersona(manager, subprofileId, values, {
      isUnlinked:
        rows[0]?.link_visibility === SubprofileLinkVisibility.Unlinked,
      ...options,
    });
  }

  /**
   * Re-homes every image an unlinked persona shows and rewrites each
   * reference in place: the avatar and cover, every item image, and every
   * connected feed's show art. `persona.avatarUrl`/`coverUrl` are rewritten
   * in memory too, for a caller that saves its own copy of the row next.
   *
   * - `unlink` (in the unlink transaction, right after the fresh id is
   *   issued, so `persona.id` is that id): EVERY image gets a fresh key,
   *   persona-scoped ones included, since the persona may be going unlinked
   *   for the second time and showed those keys while linked.
   * - `backfill` (the one-off CLI): only member-scoped keys and keys that
   *   are not this persona's own are copied, so a re-run does nothing new.
   *
   * Item revisions are left as they are: they are read by the persona's
   * members only, and `SubprofilesService.restoreRevision` re-homes an image
   * when a revision is restored onto an unlinked persona. That keeps the
   * bucket work inside the persona lock bounded by what the persona shows.
   */
  async rehomeUnlinkedPersona(
    manager: EntityManager,
    persona: PersonaImageColumns,
    mode: 'unlink' | 'backfill',
  ): Promise<RehomedKeys> {
    const itemRows: { image_url: string }[] = await manager.query(
      `SELECT DISTINCT "image_url" FROM "subprofile_items"
        WHERE "subprofile_id" = $1 AND "image_url" IS NOT NULL`,
      [persona.id],
    );
    const feedRows: { image_key: string }[] = await manager.query(
      `SELECT DISTINCT "image_key" FROM "subprofile_feeds"
        WHERE "subprofile_id" = $1 AND "image_key" IS NOT NULL`,
      [persona.id],
    );
    const rehomed = await this.rehomeKeys(
      manager,
      persona.id,
      [
        persona.avatarUrl,
        persona.coverUrl,
        ...itemRows.map((row) => row.image_url),
        ...feedRows.map((row) => row.image_key),
      ],
      {
        shouldCopyMemberScoped: true,
        personaScopedMode: mode === 'unlink' ? 'copy-all' : 'keep-own',
      },
    );
    if (rehomed.size === 0) {
      return rehomed;
    }

    persona.avatarUrl = PersonaImageKeysService.applyRehome(
      rehomed,
      persona.avatarUrl,
    );
    persona.coverUrl = PersonaImageKeysService.applyRehome(
      rehomed,
      persona.coverUrl,
    );
    await manager.query(
      `UPDATE "subprofiles" SET "avatar_url" = $2, "cover_url" = $3 WHERE "id" = $1`,
      [persona.id, persona.avatarUrl, persona.coverUrl],
    );
    for (const [storedValue, freshKey] of rehomed) {
      await manager.query(
        `UPDATE "subprofile_items" SET "image_url" = $3
          WHERE "subprofile_id" = $1 AND "image_url" = $2`,
        [persona.id, storedValue, freshKey],
      );
      await manager.query(
        `UPDATE "subprofile_feeds" SET "image_key" = $3
          WHERE "subprofile_id" = $1 AND "image_key" = $2`,
        [persona.id, storedValue, freshKey],
      );
    }
    return rehomed;
  }

  /**
   * The registry row for a persona-scoped key, or null when no persona holds
   * it (never minted, rolled back, or its persona was deleted).
   */
  async findRegistration(
    storageKey: string,
  ): Promise<PersonaStorageKey | null> {
    return this.registry.findOne({ where: { storageKey } });
  }

  /**
   * What `GET /files/*` needs to serve a persona-scoped key, in ONE read:
   * whether a persona holds it, and its uploader's account status. Null when
   * no row names the key. `uploaderStatus` is null when the uploader is
   * unknown or erased.
   */
  async findServingRegistration(storageKey: string): Promise<{
    uploadedById: string | null;
    uploaderStatus: string | null;
  } | null> {
    const rows: {
      uploaded_by_id: string | null;
      uploader_status: string | null;
    }[] = await this.registry.query(
      `SELECT "registry"."uploaded_by_id", "uploader"."status" AS "uploader_status"
         FROM "persona_storage_keys" "registry"
         LEFT JOIN "users" "uploader" ON "uploader"."id" = "registry"."uploaded_by_id"
        WHERE "registry"."storage_key" = $1`,
      [storageKey],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      uploadedById: row.uploaded_by_id,
      uploaderStatus: row.uploader_status,
    };
  }

  /** Whether `userId` co-owns the persona a persona-scoped key belongs to. */
  async isMemberOfKeyPersona(
    storageKey: string,
    userId: string,
  ): Promise<boolean> {
    const rows: unknown[] = await this.registry.query(
      `SELECT 1 FROM "persona_storage_keys" "registry"
         JOIN "subprofile_members" "member"
           ON "member"."subprofile_id" = "registry"."subprofile_id"
        WHERE "registry"."storage_key" = $1 AND "member"."user_id" = $2
        LIMIT 1`,
      [storageKey, userId],
    );
    return rows.length > 0;
  }

  /** Every persona-scoped key registered to one persona, read through
   *  `manager` (a persona delete reads them before the row goes). */
  async listKeysOf(
    manager: EntityManager,
    subprofileId: string,
  ): Promise<string[]> {
    const rows = await manager.find(PersonaStorageKey, {
      where: { subprofileId },
      select: { storageKey: true },
    });
    return rows.map((row) => row.storageKey);
  }

  /** Every persona-scoped key a member uploaded (erasure reads them before
   *  the account row goes, since the column is set null with it). */
  async listKeysUploadedBy(userId: string): Promise<string[]> {
    const rows = await this.registry.find({
      where: { uploadedById: userId },
      select: { storageKey: true },
    });
    return rows.map((row) => row.storageKey);
  }

  /**
   * Every persona-scoped object a member uploaded that still exists in the
   * bucket, with its size and date (one HEAD each: these keys cannot be
   * listed by a prefix). For My uploads, the Art. 20 export and the admin
   * console's uploader view.
   */
  async listObjectsUploadedBy(userId: string): Promise<PersonaStoredObject[]> {
    const rows = await this.registry.find({
      where: { uploadedById: userId },
      select: { storageKey: true, uploadKind: true },
    });
    const objects: PersonaStoredObject[] = [];
    for (const row of rows) {
      const object = await this.storage.describeObject(row.storageKey);
      if (object) {
        objects.push({ ...object, uploadKind: row.uploadKind });
      }
    }
    return objects;
  }

  /** The uploader each registered persona-scoped key records, for keys in
   *  `storageKeys` (other keys are absent from the map). */
  async uploaderIdsFor(
    storageKeys: readonly string[],
  ): Promise<Map<string, string>> {
    const personaKeys = storageKeys.filter((key) => isPersonaScopedKey(key));
    if (personaKeys.length === 0) {
      return new Map();
    }
    const rows = await this.registry.find({
      where: { storageKey: In(personaKeys) },
      select: { storageKey: true, uploadedById: true },
    });
    const uploaderIdByKey = new Map<string, string>();
    for (const row of rows) {
      if (row.uploadedById) {
        uploaderIdByKey.set(row.storageKey, row.uploadedById);
      }
    }
    return uploaderIdByKey;
  }

  /** Drops the registry rows of persona-scoped keys whose objects are gone. */
  async unregister(storageKeys: readonly string[]): Promise<void> {
    if (storageKeys.length === 0) {
      return;
    }
    await this.registry.delete({ storageKey: In([...storageKeys]) });
  }

  /**
   * Forgets persona-scoped keys whose objects were just deleted outside the
   * persona flows (the admin media console): drops their registry rows, so
   * `GET /files/*` answers them with a 404 the moment the object is gone,
   * and any reframe crop saved on them. Keys that are not persona-scoped are
   * ignored.
   */
  async forgetDeletedKeys(storageKeys: readonly string[]): Promise<void> {
    const personaKeys = storageKeys.filter((key) => isPersonaScopedKey(key));
    if (personaKeys.length === 0) {
      return;
    }
    await this.unregister(personaKeys);
    await this.registry.query(
      `DELETE FROM "media_crops" WHERE "storage_key" = ANY($1)`,
      [personaKeys],
    );
  }

  /**
   * Best-effort delete of persona-scoped objects after the rows that showed
   * them are gone (a persona delete). A persona-scoped key is never shared
   * by two personas, so nothing else can still show one. A failure is
   * logged: the bytes are already unservable, since the registry rows went
   * with the persona, and the orphan sweep can reclaim them.
   */
  async deleteObjects(storageKeys: readonly string[]): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.deleteObjectByKey(storageKey);
      } catch (error) {
        this.logger.error(
          `Could not delete persona image ${storageKey}: ${String(error)}`,
        );
      }
    }
  }

  // Whether a bare value is a storage key this service can act on.
  private static isOurKey(bareValue: string): boolean {
    return (
      storageKeyOwnerId(bareValue) !== null || isPersonaScopedKey(bareValue)
    );
  }

  // The values `options` select for copying, deduplicated, each with what
  // its registry row will carry. Persona-scoped values are resolved against
  // the registry in one read.
  private async copyCandidates(
    manager: EntityManager,
    subprofileId: string,
    values: readonly (string | null | undefined)[],
    options: RehomeOptions,
  ): Promise<CopyCandidate[]> {
    const shouldCopyMemberScoped = options.shouldCopyMemberScoped ?? true;
    const personaScopedMode = options.personaScopedMode ?? 'keep-own';
    const keepValues = new Set(options.keepValues ?? []);
    const distinctValues = [...new Set(values)].filter(
      (value): value is string => Boolean(value),
    );

    const personaScopedSources = distinctValues
      .map((value) => toBareKey(value))
      .filter((bareValue) => isPersonaScopedKey(bareValue));
    const registrationByKey = new Map<string, PersonaStorageKey>();
    if (personaScopedSources.length > 0) {
      const rows = await manager.find(PersonaStorageKey, {
        where: { storageKey: In(personaScopedSources) },
      });
      for (const row of rows) {
        registrationByKey.set(row.storageKey, row);
      }
    }

    const candidates: CopyCandidate[] = [];
    for (const storedValue of distinctValues) {
      const sourceKey = toBareKey(storedValue);
      const uploaderUserId = storageKeyOwnerId(sourceKey);
      if (uploaderUserId !== null) {
        if (shouldCopyMemberScoped) {
          candidates.push({
            storedValue,
            sourceKey,
            isPersonaScopedSource: false,
            uploadedById: uploaderUserId,
            uploadKind: PersonaImageKeysService.uploadKindOf(sourceKey),
          });
        }
        continue;
      }
      if (!isPersonaScopedKey(sourceKey) || keepValues.has(storedValue)) {
        continue;
      }
      const registration = registrationByKey.get(sourceKey);
      const isOwnKey = registration?.subprofileId === subprofileId;
      if (personaScopedMode === 'keep-own' && isOwnKey) {
        continue;
      }
      candidates.push({
        storedValue,
        sourceKey,
        isPersonaScopedSource: true,
        uploadedById: registration?.uploadedById ?? null,
        uploadKind: registration?.uploadKind ?? null,
      });
    }
    return candidates;
  }

  private static uploadKindOf(sourceKey: string): UploadKind | null {
    const kindSpec = parseStorageKey(sourceKey);
    return kindSpec
      ? (UPLOAD_KIND_BY_PREFIX.get(kindSpec.prefix) ?? null)
      : null;
  }

  // The fresh persona-scoped key for a candidate, or null when it cannot be
  // re-homed (see `RehomedKeys`). Any other bucket error is thrown, which
  // fails the write so it can be retried: the uploader's id must never be
  // left on the persona.
  private async copyOrDrop(candidate: CopyCandidate): Promise<string | null> {
    const extension = candidate.sourceKey.slice(
      candidate.sourceKey.lastIndexOf('.'),
    );
    if (!isPersonaScopedExtension(extension)) {
      return this.dropUnhomeable(candidate.sourceKey);
    }
    try {
      return await this.storage.copyObjectToPersonaScope(candidate.sourceKey, {
        allowsPersonaScopedSource: candidate.isPersonaScopedSource,
      });
    } catch (error) {
      if (StorageService.isMissingObjectError(error)) {
        return this.dropUnhomeable(candidate.sourceKey);
      }
      throw error;
    }
  }

  private dropUnhomeable(sourceKey: string): null {
    // A member-scoped key names the uploader, so only its kind is logged.
    this.logger.warn(
      `Dropped a persona image reference that could not be re-homed (${sourceKey.split('/')[0] ?? 'unknown'})`,
    );
    return null;
  }
}

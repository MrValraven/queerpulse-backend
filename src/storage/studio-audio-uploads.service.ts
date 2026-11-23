import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StudioErrorCode,
  isStudioArtistPersonaKind,
  studioAudioMaxBytesForKind,
  studioError,
} from '../studio/studio.constants';
import { StudioAudioUpload } from './entities/studio-audio-upload.entity';
import {
  PresignedUpload,
  StorageService,
  StoredObject,
} from './storage.service';

/** A Studio audio object a member uploaded, as the Art. 20 export lists it. */
export interface StudioAudioStoredObject extends StoredObject {
  uploadKind: 'studio_audio';
}

/** The refusals the presign checks answer, in the order they run. */
type StudioUploadCheckRefusal = Extract<
  StudioErrorCode,
  | 'studio_access_required'
  | 'studio_not_persona_owner'
  | 'studio_persona_kind_not_allowed'
>;

/** Why a confirm of a Studio audio key is refused: the Studio grant, the
 *  key belonging to no persona the caller owns, or the persona kind. */
export type StudioAudioConfirmRefusal =
  | 'studio_access_required'
  | 'upload_not_yours'
  | 'studio_persona_kind_not_allowed';

interface UploadCheckRow {
  has_grant: boolean;
  persona_kind: string | null;
  is_member: boolean;
}

/**
 * Studio v1: the storage side of a track upload. Lives in `StorageModule`
 * because `POST /uploads/presign` is a storage route; the Studio module reads
 * the same registry through `findRegistration`. The checks run as one raw
 * statement over the Studio grant, the persona and its roster, so this
 * module needs no import of the Studio or persona modules.
 */
@Injectable()
export class StudioAudioUploadsService {
  private readonly logger = new Logger(StudioAudioUploadsService.name);

  constructor(
    private readonly storage: StorageService,
    @InjectRepository(StudioAudioUpload)
    private readonly uploads: Repository<StudioAudioUpload>,
  ) {}

  /**
   * Presigns a track upload for `subprofileId`. The caller needs a Studio
   * grant and a membership of a persona of a Studio artist kind; a podcast
   * kind may upload up to 250 MB, every other kind 50 MB. The registry row is
   * written once the presign succeeds, so a refused or over-cap request
   * leaves nothing behind.
   */
  async presign(
    userId: string,
    request: { subprofileId: string; contentType: string; byteSize: number },
  ): Promise<PresignedUpload> {
    const { refusal, personaKind } = await this.uploadChecksFor(
      userId,
      request.subprofileId,
    );
    if (refusal) {
      throw studioError(refusal);
    }
    const presigned = await this.storage.presignStudioAudioUpload({
      contentType: request.contentType,
      byteSize: request.byteSize,
      maxBytes: studioAudioMaxBytesForKind(personaKind),
    });
    await this.uploads.insert({
      storageKey: presigned.key,
      subprofileId: request.subprofileId,
      uploadedById: userId,
    });
    return presigned;
  }

  /**
   * Why `userId` may not confirm (`POST /uploads/confirm`) the Studio audio
   * object stored under `storageKey`, or null when they may. The caller must
   * pass the very checks the presign ran for the persona the key's registry
   * row names, in the presign's order:
   *  - no Studio grant: `studio_access_required`, answered before the key is
   *    looked at, so it says nothing about the key;
   *  - no registry row, or no membership of that persona: `upload_not_yours`,
   *    one answer for both, so the refusal never says whether a key exists;
   *  - a persona kind that cannot upload audio:
   *    `studio_persona_kind_not_allowed`.
   * The uploader and every co-owner of the persona pass alike, as each of
   * them could have presigned the key.
   */
  async confirmUploadRefusal(
    userId: string,
    storageKey: string,
  ): Promise<StudioAudioConfirmRefusal | null> {
    const registration = await this.findRegistration(storageKey);
    const { refusal } = await this.uploadChecksFor(
      userId,
      registration?.subprofileId ?? null,
    );
    if (refusal === 'studio_not_persona_owner') {
      return 'upload_not_yours';
    }
    return refusal;
  }

  /** The registry row for a Studio audio key, or null when none names it. */
  findRegistration(storageKey: string): Promise<StudioAudioUpload | null> {
    return this.uploads.findOne({ where: { storageKey } });
  }

  /**
   * Best-effort delete of Studio audio objects whose tracks are gone or
   * replaced, each followed by its registry row. A failure is logged and the
   * row kept: the orphan sweep reclaims an unreferenced object later.
   */
  async deleteObjectsAndForget(storageKeys: readonly string[]): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.deleteObjectByKey(storageKey);
        await this.uploads.delete({ storageKey });
      } catch (error) {
        this.logger.error(
          `Could not delete Studio audio ${storageKey}: ${String(error)}`,
        );
      }
    }
  }

  /** Every Studio audio object a member uploaded that still exists (one HEAD
   *  each), for the Art. 20 export. */
  async listObjectsUploadedBy(
    userId: string,
  ): Promise<StudioAudioStoredObject[]> {
    const rows = await this.uploads.find({
      where: { uploadedById: userId },
      select: { storageKey: true },
    });
    const objects: StudioAudioStoredObject[] = [];
    for (const row of rows) {
      const object = await this.storage.describeObject(row.storageKey);
      if (object) {
        objects.push({ ...object, uploadKind: 'studio_audio' });
      }
    }
    return objects;
  }

  // One statement answers all three checks and reads the persona kind the
  // cap depends on. An unknown persona reads as "not your persona", so the
  // refusal never confirms a persona id exists.
  //
  // A null persona (a confirm whose key has no registry row) still answers
  // the grant check, and reads as "not your persona" after it.
  private async uploadChecksFor(
    userId: string,
    subprofileId: string | null,
  ): Promise<{
    refusal: StudioUploadCheckRefusal | null;
    personaKind: string | null;
  }> {
    const rows: UploadCheckRow[] = await this.uploads.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM "studio_access_grants" "grant"
            WHERE "grant"."user_id" = $1
         ) AS "has_grant",
         (
           SELECT "persona"."kind"::text FROM "subprofiles" "persona"
            WHERE "persona"."id" = $2
         ) AS "persona_kind",
         EXISTS (
           SELECT 1 FROM "subprofile_members" "member"
            WHERE "member"."subprofile_id" = $2 AND "member"."user_id" = $1
         ) AS "is_member"`,
      [userId, subprofileId],
    );
    const row = rows[0];
    const personaKind = row?.persona_kind ?? null;
    if (!row?.has_grant) {
      return { refusal: 'studio_access_required', personaKind };
    }
    if (personaKind === null || !row.is_member) {
      return { refusal: 'studio_not_persona_owner', personaKind };
    }
    if (!isStudioArtistPersonaKind(personaKind)) {
      return { refusal: 'studio_persona_kind_not_allowed', personaKind };
    }
    return { refusal: null, personaKind };
  }
}

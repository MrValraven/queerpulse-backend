import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  StudioErrorCode,
  isStudioArtistPersonaKind,
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
   * grant and a membership of a musician or DJ persona. The registry row is
   * written once the presign succeeds, so a refused or over-cap request
   * leaves nothing behind.
   */
  async presign(
    userId: string,
    request: { subprofileId: string; contentType: string; byteSize: number },
  ): Promise<PresignedUpload> {
    const refusal = await this.uploadRefusalFor(userId, request.subprofileId);
    if (refusal) {
      throw studioError(refusal);
    }
    const presigned = await this.storage.presignStudioAudioUpload({
      contentType: request.contentType,
      byteSize: request.byteSize,
    });
    await this.uploads.insert({
      storageKey: presigned.key,
      subprofileId: request.subprofileId,
      uploadedById: userId,
    });
    return presigned;
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

  // One statement answers all three checks. An unknown persona reads as
  // "not your persona", so the refusal never confirms a persona id exists.
  private async uploadRefusalFor(
    userId: string,
    subprofileId: string,
  ): Promise<StudioErrorCode | null> {
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
    if (!row?.has_grant) {
      return 'studio_access_required';
    }
    if (row.persona_kind === null || !row.is_member) {
      return 'studio_not_persona_owner';
    }
    if (!isStudioArtistPersonaKind(row.persona_kind)) {
      return 'studio_persona_kind_not_allowed';
    }
    return null;
  }
}

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import {
  isStudioLandingScopedKey,
  parseStorageKey,
  storageKeyOwnerId,
} from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import {
  AdminLandingPhotoRow,
  AdminStudioLanding,
  AdminStudioLandingPhoto,
  toAdminStudioLandingPhoto,
} from './admin-studio-landing-response';
import { PutStudioLandingPhotoDto } from './dto/admin-studio-landing.dto';
import { invalidateStudioLandingMemo } from './studio-landing-memo';
import {
  STUDIO_LANDING_PHOTO_SLOTS,
  StudioLandingPhotoSlot,
  studioError,
} from './studio.constants';

/** `$1` the slot. Locks the row for the rest of the transaction and reads the
 *  key it holds right now, so a save is decided against the stored value and
 *  never against a read taken before another save. */
export const LOCK_PHOTO_SQL =
  'SELECT "image_key" FROM "studio_landing_photos" WHERE "slot" = $1 FOR UPDATE';

/** `$1` the slot. The key the slot holds, read without a lock. */
const STORED_PHOTO_KEY_SQL =
  'SELECT "image_key" FROM "studio_landing_photos" WHERE "slot" = $1';

const PHOTO_COLUMNS_SQL = `"slot", "image_key", "alt_text_en", "alt_text_pt", "credit", "consented_at", "updated_by_id"`;

const ALL_PHOTOS_SQL = `SELECT ${PHOTO_COLUMNS_SQL} FROM "studio_landing_photos" ORDER BY "slot" ASC`;

/** `$1` slot, `$2` image key, `$3`/`$4` alt texts, `$5` credit or null, `$6` the
 *  staff member. The consent tick was checked before the write, and every save
 *  restamps `consented_at`. */
const UPSERT_PHOTO_SQL = `INSERT INTO "studio_landing_photos"
  ("slot", "image_key", "alt_text_en", "alt_text_pt", "credit", "has_consent", "consented_at", "updated_by_id", "updated_at")
VALUES ($1, $2, $3, $4, $5, true, now(), $6, now())
ON CONFLICT ("slot") DO UPDATE SET
  "image_key" = EXCLUDED."image_key",
  "alt_text_en" = EXCLUDED."alt_text_en",
  "alt_text_pt" = EXCLUDED."alt_text_pt",
  "credit" = EXCLUDED."credit",
  "has_consent" = true,
  "consented_at" = now(),
  "updated_by_id" = EXCLUDED."updated_by_id",
  "updated_at" = now()
RETURNING ${PHOTO_COLUMNS_SQL}`;

/** `$1` the slot. */
const DELETE_PHOTO_SQL = `DELETE FROM "studio_landing_photos" WHERE "slot" = $1`;

interface LockedPhotoRow {
  image_key: string;
}

/**
 * Studio landing v2: the staff side of the two photo slots (`hero`,
 * `manifesto`), Moderator and Admin. Contract 8 and 9.5, the scene cover
 * sequence of `AdminStudioScenesService.update`.
 *
 * A photo arrives as the staff member's own `work-image` upload, whose key
 * names them. It is stored as a landing-scoped copy
 * (`studio-landing/<uuid>/<uuid><ext>`), so the copy names nobody: copy
 * first, then write the row. `GET /files/*` serves the copy only while a
 * `studio_landing_photos` row stores it, so a copy whose write rolled back is
 * never served and the orphan sweep reclaims it with the original upload. A
 * replaced or deleted copy goes after the write commits, best effort, and the
 * sweep reclaims it when that fails.
 */
@Injectable()
export class AdminStudioLandingPhotosService {
  private readonly logger = new Logger(AdminStudioLandingPhotosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly modAudit: ModAuditService,
  ) {}

  async getPhotos(): Promise<AdminStudioLanding['photos']> {
    const rows: AdminLandingPhotoRow[] =
      await this.dataSource.query(ALL_PHOTOS_SQL);
    const staffNames = await this.staffNamesOf(rows);
    const photos: AdminStudioLanding['photos'] = {
      hero: null,
      manifesto: null,
    };
    for (const slot of STUDIO_LANDING_PHOTO_SLOTS) {
      const row = rows.find((candidate) => candidate.slot === slot);
      photos[slot] = row ? toAdminStudioLandingPhoto(row, staffNames) : null;
    }
    return photos;
  }

  async putPhoto(
    staffUserId: string,
    slot: StudioLandingPhotoSlot,
    body: PutStudioLandingPhotoDto,
  ): Promise<AdminStudioLandingPhoto> {
    if (body.hasConsent !== true) {
      throw studioError('studio_landing_consent_required');
    }
    const storedKey = await this.readStoredKey(slot);
    // A fresh photo is a work image the staff member uploaded. Their other
    // uploads (a message image, an avatar) answer not_yours.
    const isOwnUpload =
      storageKeyOwnerId(body.imageKey) === staffUserId &&
      parseStorageKey(body.imageKey) === UPLOAD_KIND_SPECS['work-image'];
    const isStoredKeyResent =
      isStudioLandingScopedKey(body.imageKey) && body.imageKey === storedKey;
    if (!isOwnUpload && !isStoredKeyResent) {
      throw studioError('studio_landing_photo_not_yours');
    }
    assertNoForeignUploadIntroduced(staffUserId, body.imageKey, [storedKey]);
    const freshCopyKey = isOwnUpload
      ? await this.copyUpload(body.imageKey)
      : null;
    const imageKey = freshCopyKey ?? body.imageKey;
    let replacedKey: string | null = null;
    let savedRow: AdminLandingPhotoRow;
    try {
      savedRow = await this.dataSource.transaction(async (manager) => {
        // The row lock serializes saves of one slot. Everything below
        // compares against the key stored now.
        const [lockedRow]: LockedPhotoRow[] = await manager.query(
          LOCK_PHOTO_SQL,
          [slot],
        );
        const lockedKey = lockedRow ? lockedRow.image_key : null;
        // A re-sent stored copy is a claim about what the slot holds. If
        // another save replaced it first, saving it would point the slot at
        // the copy that save deleted.
        if (freshCopyKey === null && imageKey !== lockedKey) {
          throw studioError('studio_landing_photo_not_yours');
        }
        const credit = body.credit?.trim();
        const [row]: AdminLandingPhotoRow[] = await manager.query(
          UPSERT_PHOTO_SQL,
          [
            slot,
            imageKey,
            body.altTextEn,
            body.altTextPt,
            credit ? credit : null,
            staffUserId,
          ],
        );
        if (!row) {
          throw new InternalServerErrorException(
            'The Studio page photo was not saved',
          );
        }
        if (lockedKey !== null && lockedKey !== imageKey) {
          replacedKey = lockedKey;
        }
        return row;
      });
    } catch (error) {
      await this.discardUnusedCopy(freshCopyKey);
      throw error;
    }
    invalidateStudioLandingMemo();
    // The copy the write replaced is the one the locked row held, so a live
    // copy is never the one deleted.
    await this.deleteLandingCopy(replacedKey);
    const photo = toAdminStudioLandingPhoto(
      savedRow,
      await this.staffNamesOf([savedRow]),
    );
    if (photo === null) {
      throw new InternalServerErrorException(
        'The Studio page photo has no servable address',
      );
    }
    return photo;
  }

  /** Idempotent: an empty slot answers quietly. */
  async deletePhoto(slot: StudioLandingPhotoSlot): Promise<void> {
    const deletedKey = await this.dataSource.transaction(async (manager) => {
      const [lockedRow]: LockedPhotoRow[] = await manager.query(
        LOCK_PHOTO_SQL,
        [slot],
      );
      if (!lockedRow) {
        return null;
      }
      await manager.query(DELETE_PHOTO_SQL, [slot]);
      return lockedRow.image_key;
    });
    if (deletedKey === null) {
      return;
    }
    invalidateStudioLandingMemo();
    await this.deleteLandingCopy(deletedKey);
  }

  private async readStoredKey(
    slot: StudioLandingPhotoSlot,
  ): Promise<string | null> {
    const [row]: LockedPhotoRow[] = await this.dataSource.query(
      STORED_PHOTO_KEY_SQL,
      [slot],
    );
    return row ? row.image_key : null;
  }

  private async staffNamesOf(
    rows: readonly { updated_by_id: string | null }[],
  ): Promise<Map<string, string>> {
    const staffUserIds = rows.flatMap((row) =>
      row.updated_by_id === null ? [] : [row.updated_by_id],
    );
    return this.modAudit.namesForUserIds(staffUserIds);
  }

  // A staff member's own upload becomes a fresh landing-scoped copy.
  private async copyUpload(uploadKey: string): Promise<string> {
    try {
      return await this.storage.copyObjectToStudioLandingScope(uploadKey);
    } catch (error) {
      if (StorageService.isMissingObjectError(error)) {
        throw new BadRequestException('Photo upload not found');
      }
      throw error;
    }
  }

  // A copy minted for a write that did not commit is named by no row. The
  // files route never served it; this reclaims it now. Best effort, logged.
  private async discardUnusedCopy(freshCopyKey: string | null): Promise<void> {
    if (freshCopyKey === null) {
      return;
    }
    try {
      await this.storage.deleteObjectByKey(freshCopyKey);
    } catch (error) {
      this.logger.error(
        `Could not delete the photo copy of a failed Studio page write: ${String(error)}`,
      );
    }
  }

  // A landing-scoped copy belongs to one slot, so the one a save replaced or
  // a delete removed can go. A failure is logged: the files route stopped
  // serving it at commit.
  private async deleteLandingCopy(previousKey: string | null): Promise<void> {
    if (previousKey === null || !isStudioLandingScopedKey(previousKey)) {
      return;
    }
    try {
      await this.storage.deleteObjectByKey(previousKey);
    } catch (error) {
      this.logger.error(
        `Could not delete a Studio page photo copy: ${String(error)}`,
      );
    }
  }
}

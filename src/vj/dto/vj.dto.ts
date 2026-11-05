import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { VJ_FIT_MODES } from '../vj.contract';

// Every field below is `@Allow()` and typed `unknown`: the decorator keeps the
// property through `whitelist` and validates nothing, so the service owns each
// check and a bad value always answers its own reason code. A property no
// class declares still gets the global `forbidNonWhitelisted` 400.

/** Body of `POST /admin/vj/packs`. The service answers
 *  `VJ_PACK_NAME_REQUIRED` and `VJ_PACK_NAME_TOO_LONG` for a bad `name`. */
export class CreateVjPackDto {
  @ApiPropertyOptional({
    description: 'Pack name. Trimmed, 1 to 60 characters.',
    type: String,
  })
  @Allow()
  name?: unknown;
}

/** Body of `PATCH /admin/vj/packs/:id`. The service answers
 *  `VJ_PACK_NAME_REQUIRED` and `VJ_PACK_NAME_TOO_LONG` for a bad `name`. */
export class RenameVjPackDto {
  @ApiPropertyOptional({
    description: 'New pack name. Trimmed, 1 to 60 characters.',
    type: String,
  })
  @Allow()
  name?: unknown;
}

/** Body of `PATCH /admin/vj/packs/reorder`. The service answers
 *  `VJ_PACK_REORDER_MISMATCH` for a list that is no permutation of every
 *  pack id. */
export class ReorderVjPacksDto {
  @ApiPropertyOptional({
    description: 'Every pack id exactly once, in the new order.',
    type: [String],
  })
  @Allow()
  packIds?: unknown;
}

/** Body of `POST /admin/vj/packs/:id/clips`. The service answers
 *  `VJ_CLIP_NOT_FOUND` for a `clipId` that is no uuid of a stored clip. */
export class AddVjPackClipDto {
  @ApiPropertyOptional({
    description: 'The clip to append to the pack.',
    type: String,
  })
  @Allow()
  clipId?: unknown;
}

/** Body of `PATCH /admin/vj/packs/:id/clips/reorder`. The service answers
 *  `VJ_PACK_CLIPS_REORDER_MISMATCH` for a list that is no permutation of the
 *  pack's clip ids. */
export class ReorderVjPackClipsDto {
  @ApiPropertyOptional({
    description: 'Every clip id of the pack exactly once, in the new order.',
    type: [String],
  })
  @Allow()
  clipIds?: unknown;
}

/** Body of `POST /admin/vj/clips`. The service answers, in this order,
 *  `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG`, `VJ_CLIP_KEY_INVALID`,
 *  `VJ_CLIP_DIMENSIONS_INVALID`, `VJ_CLIP_DURATION_INVALID`,
 *  `VJ_CLIP_FIT_MODE_INVALID` and `VJ_PACK_NOT_FOUND`, then the upload codes. */
export class CreateVjClipDto {
  @ApiPropertyOptional({
    description: 'Clip title. Trimmed, 1 to 120 characters.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'Storage key from the vj_clip presign.',
    type: String,
  })
  @Allow()
  storageKey?: unknown;

  @ApiPropertyOptional({
    description: 'Storage key from the vj_thumbnail presign.',
    type: String,
  })
  @Allow()
  thumbnailStorageKey?: unknown;

  @ApiPropertyOptional({
    description: 'Width in pixels, a whole number from 1 to 16384.',
    type: Number,
  })
  @Allow()
  width?: unknown;

  @ApiPropertyOptional({
    description: 'Height in pixels, a whole number from 1 to 16384.',
    type: Number,
  })
  @Allow()
  height?: unknown;

  @ApiPropertyOptional({
    description:
      'Duration in whole milliseconds for a video; null or absent for a GIF.',
    type: Number,
    nullable: true,
  })
  @Allow()
  durationMs?: unknown;

  @ApiPropertyOptional({
    description: 'How the clip fills the screen. Defaults to fill.',
    enum: [...VJ_FIT_MODES],
  })
  @Allow()
  fitMode?: unknown;

  @ApiPropertyOptional({
    description: 'A pack to append the new clip to in the same transaction.',
    type: String,
    nullable: true,
  })
  @Allow()
  packId?: unknown;
}

/** Body of `PATCH /admin/vj/clips/:id`. The service answers
 *  `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG` and
 *  `VJ_CLIP_FIT_MODE_INVALID`; an absent property stays as it is. */
export class UpdateVjClipDto {
  @ApiPropertyOptional({
    description: 'New clip title. Trimmed, 1 to 120 characters.',
    type: String,
  })
  @Allow()
  title?: unknown;

  @ApiPropertyOptional({
    description: 'New fit mode.',
    enum: [...VJ_FIT_MODES],
  })
  @Allow()
  fitMode?: unknown;
}

/** Query of `GET /admin/vj/packs/:id/media`. The service answers
 *  `VJ_CLIP_IDS_INVALID` for a repeated, blank, oversized or malformed value. */
export class VjPackMediaQuery {
  @ApiPropertyOptional({
    description:
      'Comma-separated clip ids to sign. Absent signs every clip of the pack.',
    type: String,
  })
  @Allow()
  clipIds?: unknown;
}

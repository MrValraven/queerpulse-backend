import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { VJ_FIT_MODES, VJ_LOOP_MODES, VJ_SPEEDS } from '../vj.contract';

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

/** Body of `PATCH /admin/vj/clips/:id`. The service answers, in this order,
 *  `VJ_CLIP_TITLE_REQUIRED`, `VJ_CLIP_TITLE_TOO_LONG`,
 *  `VJ_CLIP_FIT_MODE_INVALID`, `VJ_CLIP_FAVORITE_INVALID`,
 *  `VJ_CLIP_SPEED_INVALID`, `VJ_CLIP_LOOP_MODE_INVALID` and
 *  `VJ_CLIP_LOOP_INVALID`; an absent property stays as it is. */
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

  @ApiPropertyOptional({
    description:
      'Whether the clip is a favorite. A boolean, else VJ_CLIP_FAVORITE_INVALID.',
    type: Boolean,
  })
  @Allow()
  isFavorite?: unknown;

  @ApiPropertyOptional({
    description:
      'Base playback rate. One of the listed speeds, else VJ_CLIP_SPEED_INVALID.',
    enum: [...VJ_SPEEDS],
  })
  @Allow()
  defaultSpeed?: unknown;

  @ApiPropertyOptional({
    description:
      'Loop start in whole milliseconds, or null to clear it. Answers VJ_CLIP_LOOP_INVALID for a bad value, a GIF, a point outside the clip or a span under 250 ms.',
    type: Number,
    nullable: true,
  })
  @Allow()
  loopInMs?: unknown;

  @ApiPropertyOptional({
    description:
      'Loop end in whole milliseconds, or null to clear it. Answers VJ_CLIP_LOOP_INVALID for a bad value, a GIF, a point outside the clip or a span under 250 ms.',
    type: Number,
    nullable: true,
  })
  @Allow()
  loopOutMs?: unknown;

  @ApiPropertyOptional({
    description:
      'How the clip plays between its loop points. Answers VJ_CLIP_LOOP_MODE_INVALID for any other value.',
    enum: [...VJ_LOOP_MODES],
  })
  @Allow()
  loopMode?: unknown;
}

/** Body of `PUT /admin/vj/clips/:id/preview`. The service answers
 *  `VJ_CLIP_KEY_INVALID` (`field: 'previewStorageKey'`), the upload codes and
 *  `VJ_CLIP_KEY_IN_USE`. */
export class SetVjClipPreviewDto {
  @ApiProperty({
    description:
      'Storage key from the vj_preview presign. Answers VJ_CLIP_KEY_INVALID for any other key.',
    type: String,
  })
  @Allow()
  previewStorageKey?: unknown;
}

/** Body of `PATCH /admin/vj/packs/:id/event`. The service answers
 *  `VJ_EVENT_NOT_FOUND` for anything but null or the uuid of an event, and
 *  `VJ_EVENT_NOT_LINKABLE` for an event the projector may not show. */
export class SetVjPackEventDto {
  @ApiProperty({
    description:
      'The event to link, or null to unlink. Answers VJ_EVENT_NOT_FOUND or VJ_EVENT_NOT_LINKABLE.',
    type: String,
    nullable: true,
  })
  @Allow()
  eventId?: unknown;
}

/** Body of `POST /admin/vj/scenes`. The service answers, in this order,
 *  `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG`, `VJ_PACK_NOT_FOUND`,
 *  `VJ_SCENE_LOOK_INVALID`, `VJ_SCENE_CLIP_NOT_FOUND` and
 *  `VJ_SCENE_LIMIT_REACHED`. */
export class CreateVjSceneDto {
  @ApiProperty({
    description:
      'Scene name. Trimmed, 1 to 60 characters. Answers VJ_SCENE_NAME_REQUIRED or VJ_SCENE_NAME_TOO_LONG.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description:
      'The pack the scene belongs to, or null. Answers VJ_PACK_NOT_FOUND for a malformed or unknown id.',
    type: String,
    nullable: true,
  })
  @Allow()
  packId?: unknown;

  @ApiProperty({
    description:
      'The scene look: source, effects, transition, overlay and mix. Answers VJ_SCENE_LOOK_INVALID with lookField, or VJ_SCENE_CLIP_NOT_FOUND.',
    type: Object,
  })
  @Allow()
  look?: unknown;
}

/** Body of `PATCH /admin/vj/scenes/:id`. The service answers, in this order,
 *  `VJ_SCENE_NAME_REQUIRED`, `VJ_SCENE_NAME_TOO_LONG`, `VJ_PACK_NOT_FOUND`,
 *  `VJ_SCENE_LOOK_INVALID`, `VJ_SCENE_NOT_FOUND` and
 *  `VJ_SCENE_CLIP_NOT_FOUND`; an absent property stays as it is and a
 *  present `look` replaces the stored one whole. */
export class UpdateVjSceneDto {
  @ApiPropertyOptional({
    description:
      'New scene name. Trimmed, 1 to 60 characters. Answers VJ_SCENE_NAME_REQUIRED or VJ_SCENE_NAME_TOO_LONG.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description:
      'New pack, or null. Answers VJ_PACK_NOT_FOUND for a malformed or unknown id.',
    type: String,
    nullable: true,
  })
  @Allow()
  packId?: unknown;

  @ApiPropertyOptional({
    description:
      'New look, replacing the stored one whole. Answers VJ_SCENE_LOOK_INVALID with lookField, or VJ_SCENE_CLIP_NOT_FOUND.',
    type: Object,
  })
  @Allow()
  look?: unknown;
}

/** Body of `PATCH /admin/vj/scenes/reorder`. The service answers
 *  `VJ_SCENE_REORDER_MISMATCH` for a list that is no permutation of every
 *  scene id. */
export class ReorderVjScenesDto {
  @ApiProperty({
    description:
      'Every scene id exactly once, in the new order. Answers VJ_SCENE_REORDER_MISMATCH.',
    type: [String],
  })
  @Allow()
  sceneIds?: unknown;
}

/** Body of `POST /admin/vj/setlists`. The service answers, in this order,
 *  `VJ_SETLIST_NAME_REQUIRED`, `VJ_SETLIST_NAME_TOO_LONG`,
 *  `VJ_SETLIST_ITEMS_INVALID`, `VJ_SETLIST_FULL`,
 *  `VJ_SETLIST_LIMIT_REACHED`, `VJ_SETLIST_NAME_TAKEN` and
 *  `VJ_SCENE_NOT_FOUND`. */
export class CreateVjSetlistDto {
  @ApiProperty({
    description:
      'Set list name. Trimmed, 1 to 60 characters, unique ignoring case. Answers VJ_SETLIST_NAME_REQUIRED, VJ_SETLIST_NAME_TOO_LONG or VJ_SETLIST_NAME_TAKEN.',
    type: String,
  })
  @Allow()
  name?: unknown;

  @ApiPropertyOptional({
    description:
      'Scene ids in play order, repeats allowed, up to 100. Defaults to none. Answers VJ_SETLIST_ITEMS_INVALID, VJ_SETLIST_FULL or VJ_SCENE_NOT_FOUND.',
    type: [String],
  })
  @Allow()
  sceneIds?: unknown;
}

/** Body of `PATCH /admin/vj/setlists/:id`. The service answers
 *  `VJ_SETLIST_NAME_REQUIRED`, `VJ_SETLIST_NAME_TOO_LONG` and
 *  `VJ_SETLIST_NAME_TAKEN`. */
export class RenameVjSetlistDto {
  @ApiProperty({
    description:
      'New set list name. Trimmed, 1 to 60 characters, unique ignoring case. Answers VJ_SETLIST_NAME_REQUIRED, VJ_SETLIST_NAME_TOO_LONG or VJ_SETLIST_NAME_TAKEN.',
    type: String,
  })
  @Allow()
  name?: unknown;
}

/** Body of `PATCH /admin/vj/setlists/reorder`. The service answers
 *  `VJ_SETLIST_REORDER_MISMATCH` for a list that is no permutation of every
 *  set list id. */
export class ReorderVjSetlistsDto {
  @ApiProperty({
    description:
      'Every set list id exactly once, in the new order. Answers VJ_SETLIST_REORDER_MISMATCH.',
    type: [String],
  })
  @Allow()
  setlistIds?: unknown;
}

/** Body of `PUT /admin/vj/setlists/:id/items`. The service answers
 *  `VJ_SETLIST_ITEMS_INVALID`, `VJ_SETLIST_FULL` and `VJ_SCENE_NOT_FOUND`
 *  (with `sceneId`). */
export class SetVjSetlistItemsDto {
  @ApiProperty({
    description:
      'Scene ids in play order, repeats allowed, up to 100. Answers VJ_SETLIST_ITEMS_INVALID, VJ_SETLIST_FULL or VJ_SCENE_NOT_FOUND.',
    type: [String],
  })
  @Allow()
  sceneIds?: unknown;
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

/** Query of `GET /admin/vj/clips/media`. The service answers
 *  `VJ_CLIP_IDS_INVALID` for an absent, empty, oversized or malformed value. */
export class VjClipsMediaQuery {
  @ApiProperty({
    description:
      'Comma-separated clip ids to sign, 1 to 200. Answers VJ_CLIP_IDS_INVALID.',
    type: String,
  })
  @Allow()
  clipIds?: unknown;
}

import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { RoadmapColumn } from '../entities/roadmap-item.entity';

// Admin actions the Board/other views' bulk bar can apply to a selection in
// one call. Not entity-backed (no `RoadmapItem` column stores "the last bulk
// action"), so the const array lives here rather than on an entity — same
// pattern as `ModActionDto`'s `MOD_ACTION_CODES`.
export const ROADMAP_BULK_ACTIONS = [
  'move',
  'show',
  'hide',
  'archive',
  'delete',
] as const;
export type RoadmapBulkAction = (typeof ROADMAP_BULK_ACTIONS)[number];

// Admin `PATCH /admin/roadmap/items/bulk` body — one action over many items.
export class BulkItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  // Caps the batch so one request can't open an unbounded-length transaction
  // (see `RoadmapAdminService.bulkItems`, Task A4) — comfortably above any
  // real bulk-bar selection.
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  ids!: string[];

  @IsIn(ROADMAP_BULK_ACTIONS)
  action!: RoadmapBulkAction;

  // Required when `action === 'move'`; ignored otherwise. Enforced in the
  // admin service, not this DTO.
  @IsOptional()
  @IsEnum(RoadmapColumn)
  column?: RoadmapColumn;
}

import { IsBoolean } from 'class-validator';

// Admin `PATCH /admin/roadmap/items/:id/archive` body — the item's `column`
// is left untouched; only the `archived` flag flips (see
// `RoadmapAdminService.archiveItem`, Task A4). `false` restores it from the
// Archive view.
export class ArchiveItemDto {
  @IsBoolean()
  archived!: boolean;
}

import { IsOptional, IsUUID } from 'class-validator';

// Admin `PATCH /admin/roadmap/items/:id/deps` body — one dependency edge
// added and/or removed per call (matches the item drawer's "add one, remove
// one" Dependencies section UX; a bulk-replace endpoint isn't needed here).
export class UpdateDepsDto {
  // Item id this item depends on, to add.
  @IsOptional()
  @IsUUID()
  add?: string;

  // Item id this item depends on, to remove.
  @IsOptional()
  @IsUUID()
  remove?: string;
}

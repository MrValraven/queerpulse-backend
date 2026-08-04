import { PartialType } from '@nestjs/mapped-types';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CreateRoadmapItemDto } from './create-roadmap-item.dto';

// `PATCH /admin/roadmap/items/:id` — every creation field is independently
// patchable (mirrors `UpdateWorkshopDto`'s `PartialType` precedent; there is
// no create-only field to omit here), plus `slipReason`: required by the
// admin service (not this DTO — see `RoadmapAdminService.updateItem`) when
// `targetQuarter` changes on an item whose `column !== 'shipped'`. Appended
// to `slips` server-side; never sent back on read.
export class UpdateRoadmapItemDto extends PartialType(CreateRoadmapItemDto) {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  slipReason?: string;
}

import { PartialType } from '@nestjs/mapped-types';
import { CreateRoadmapItemDto } from './create-roadmap-item.dto';

// `PATCH /admin/roadmap/items/:id` — every creation field is independently
// patchable (mirrors `UpdateWorkshopDto`'s `PartialType` precedent; there is
// no create-only field to omit here).
export class UpdateRoadmapItemDto extends PartialType(CreateRoadmapItemDto) {}

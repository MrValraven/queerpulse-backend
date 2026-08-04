import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import {
  ROADMAP_DECLINE_REASONS,
  RoadmapDeclineReason,
} from '../entities/roadmap-idea.entity';

// Admin `POST /admin/roadmap/ideas/:id/decline` body — moves the idea to
// `status: 'dismissed'` with a reason + member-facing note; if `reason` is
// set the idea also surfaces on the public "Not building this, and why"
// section. Reopening later is a plain `PATCH .../ideas/:id { status:
// 'published' }` (see `update-idea.dto.ts`), not the inverse of this DTO.
export class DeclineIdeaDto {
  @IsIn(ROADMAP_DECLINE_REASONS)
  reason!: RoadmapDeclineReason;

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}

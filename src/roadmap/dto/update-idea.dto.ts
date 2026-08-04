import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RoadmapIdeaStatus } from '../entities/roadmap-idea.entity';

// Admin `PATCH /admin/roadmap/ideas/:id` — editing text/status/sortOrder/
// votes. Promoting an idea sets `status: published`; dismissing sets
// `status: dismissed`. Reopening a declined idea is also a plain
// `status: 'published'` patch — the admin service clears `declineReason`/
// `declineNote` itself rather than accepting them here (they're only ever
// set by the dedicated `POST .../decline` action, see `decline-idea.dto.ts`).
export class UpdateIdeaDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  text?: string;

  @IsOptional()
  @IsEnum(RoadmapIdeaStatus)
  status?: RoadmapIdeaStatus;

  // Groups the idea in the admin queue alongside items' `category`.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  // Admin-only annotation, distinct from the member-facing decline copy.
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  // Set when this idea is flagged as a duplicate of an existing item.
  @IsOptional()
  @IsUUID()
  duplicateOfItemId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  votes?: number;
}

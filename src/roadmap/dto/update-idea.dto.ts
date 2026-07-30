import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RoadmapIdeaStatus } from '../entities/roadmap-idea.entity';

// Admin `PATCH /admin/roadmap/ideas/:id` — editing text/status/sortOrder/
// votes. Promoting an idea sets `status: published`; dismissing sets
// `status: dismissed`.
export class UpdateIdeaDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(280)
  text?: string;

  @IsOptional()
  @IsEnum(RoadmapIdeaStatus)
  status?: RoadmapIdeaStatus;

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

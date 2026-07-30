import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { RoadmapColumn } from '../entities/roadmap-item.entity';

// Admin `POST /admin/roadmap/items` body. All three card shapes (shipped /
// building / planned) share this one DTO — like the entity, the fields
// unused for a given `column` are simply left undefined.
export class CreateRoadmapItemDto {
  @IsEnum(RoadmapColumn)
  column: RoadmapColumn;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description: string;

  // Shipped only, e.g. "May 2026".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  date?: string;

  // Building only, e.g. "In progress".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  stage?: string;

  // Building only, e.g. "~Q3 2026".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eta?: string;

  // Building only, 0-100.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  // Planned only. Starting seed count; member votes accrue on top.
  @IsOptional()
  @IsInt()
  @Min(0)
  votes?: number;

  @IsOptional()
  @IsBoolean()
  requested?: boolean;

  // Planned only — flags the "🔥 Hot" badge.
  @IsOptional()
  @IsBoolean()
  hot?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

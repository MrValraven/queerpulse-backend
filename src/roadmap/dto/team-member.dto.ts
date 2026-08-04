import { PartialType } from '@nestjs/mapped-types';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// Admin `POST /admin/roadmap/team` body — adds a roster row to the Capacity
// view. `userId` is unique per `RoadmapTeamMember` (a member has at most one
// roster row); the admin service surfaces the DB uniqueness violation, this
// DTO only validates shape.
export class CreateTeamMemberDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  role!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  weeklyCapHours?: number;

  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// `PATCH /admin/roadmap/team/:id` — every creation field independently
// patchable (`userId` included: reassigning a roster row to a different
// member is rare but not forbidden).
export class UpdateTeamMemberDto extends PartialType(CreateTeamMemberDto) {}

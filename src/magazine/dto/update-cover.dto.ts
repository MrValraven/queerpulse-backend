import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * `PATCH /magazine/admin/issues/:number/cover` body (Magazine Desk Phase 5):
 * both fields are independently optional so the cover-art field and the
 * coverlines list can be saved separately.
 */
export class UpdateCoverDto {
  @IsOptional()
  @IsString()
  coverUrl?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  coverlines?: string[];
}

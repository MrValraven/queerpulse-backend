import { IsBoolean, IsObject, IsOptional } from 'class-validator';

export class UpdateLandingFeatureDto {
  // Re-validated per the feature's existing section by `validateLandingCopy`
  // in `LandingService` when present — a PATCH cannot change `section`.
  @IsOptional()
  @IsObject()
  copy?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

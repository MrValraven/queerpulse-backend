import { IsEnum, IsObject, IsUUID } from 'class-validator';
import { LandingSection } from '../entities/landing-feature.entity';

export class CreateLandingFeatureDto {
  @IsEnum(LandingSection)
  section!: LandingSection;

  @IsUUID()
  targetId!: string;

  // Shape (quote / blurb / cause+blurb+tags) is validated per-section by
  // `validateLandingCopy` in `LandingService`, not here — the required keys
  // depend on `section`, which class-validator can't express declaratively.
  @IsObject()
  copy!: Record<string, unknown>;
}

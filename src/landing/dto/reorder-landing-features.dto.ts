import { ArrayNotEmpty, IsArray, IsEnum, IsUUID } from 'class-validator';
import { LandingSection } from '../entities/landing-feature.entity';

export class ReorderLandingFeaturesDto {
  @IsEnum(LandingSection)
  section!: LandingSection;

  // Must be exactly the current set of feature ids for `section` — validated
  // in `LandingService.reorderFeatures`, not here (requires a DB read).
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}

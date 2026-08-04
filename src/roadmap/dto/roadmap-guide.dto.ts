import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// The six-step checklist inside a resource item's `guide.steps`. Every step
// key is required whenever `steps` is sent — it's a `Record<RoadmapGuideStep,
// boolean>` on the entity/DTO side (`RoadmapGuide` in
// `../entities/roadmap-item.entity.ts`), not a sparse partial map.
export class RoadmapGuideStepsDto {
  @IsBoolean()
  research!: boolean;

  @IsBoolean()
  draft!: boolean;

  @IsBoolean()
  lived!: boolean;

  @IsBoolean()
  expert!: boolean;

  @IsBoolean()
  translate!: boolean;

  @IsBoolean()
  publish!: boolean;
}

// Which languages the guide has been translated into.
export class RoadmapGuideLanguagesDto {
  @IsBoolean()
  en!: boolean;

  @IsBoolean()
  pt!: boolean;

  @IsBoolean()
  br!: boolean;
}

// `RoadmapItem.guide` on the write path — matches the `RoadmapGuide`
// interface in `../entities/roadmap-item.entity.ts` field-for-field. Present
// only on resource/how-to items; the item DTO carries this as
// `guide?: RoadmapGuideDto | null` (`@IsOptional()` treats both `undefined`
// and `null` as "skip", so a nullable object field can still clear the
// column — same convention as `UpdateSubprofileDTO`'s nullable strings).
export class RoadmapGuideDto {
  @ValidateNested()
  @Type(() => RoadmapGuideStepsDto)
  steps!: RoadmapGuideStepsDto;

  @IsString()
  @MaxLength(200)
  reviewer!: string;

  @IsString()
  @MaxLength(200)
  credential!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reVerifyBy?: string | null;

  @ValidateNested()
  @Type(() => RoadmapGuideLanguagesDto)
  languages!: RoadmapGuideLanguagesDto;
}

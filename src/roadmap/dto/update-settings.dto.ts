import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// One hero stat tile, e.g. `{ label: "12 shipped this year", jade: true }` —
// matches the `HeroStat` interface on `RoadmapSettings`.
export class HeroStatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @IsOptional()
  @IsBoolean()
  jade?: boolean;
}

// Admin `PUT /admin/roadmap/settings` body — replaces the singleton row's
// `heroStats` array wholesale.
export class UpdateSettingsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HeroStatDto)
  heroStats: HeroStatDto[];
}

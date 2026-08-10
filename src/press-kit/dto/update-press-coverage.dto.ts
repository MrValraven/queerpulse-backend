import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

// Every field optional — a PATCH touches only what it sends. `position` is NOT
// here: order is changed exclusively through the reorder endpoint.
export class UpdatePressCoverageDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  meta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  publishedOn?: string;

  @IsOptional()
  @IsUrl()
  url?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

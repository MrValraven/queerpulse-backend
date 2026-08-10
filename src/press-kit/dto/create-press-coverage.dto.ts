import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

export class CreatePressCoverageDto {
  @IsString()
  @MaxLength(200)
  source!: string;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsString()
  @MaxLength(200)
  meta!: string;

  // Free-text publication date, e.g. "4 Mar 2026" or "Dec 2024" — press dates
  // are irregular and displayed verbatim, so this is a plain string.
  @IsString()
  @MaxLength(200)
  publishedOn!: string;

  // Nullable link to the article. `@IsOptional` skips validation for both
  // `null` and an omitted value; a present value must be a real URL.
  @IsOptional()
  @IsUrl()
  url?: string | null;

  // Defaults to `true` in the service when omitted — lets an admin stage a
  // hidden row before publishing it.
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

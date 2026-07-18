import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ProfileVisibility } from '../../users/entities/profile.entity';
import {
  MAX_NOW_LENGTH,
  MAX_OPEN_TO_ENTRIES,
  MAX_OPEN_TO_LABEL_LENGTH,
  OPEN_TO_PRESET_IDS,
} from '../open-to';

// One class covers both arms of the OpenToEntry union. `@ValidateIf` on `kind`
// keeps the irrelevant arm's field unvalidated without removing it from the
// whitelist, so the global ValidationPipe's `forbidNonWhitelisted` still
// rejects stray properties on an entry.
export class OpenToEntryDto {
  @IsIn(['preset', 'custom'])
  kind!: string;

  // An unknown id is a 400 here, never a stored value: the client drops ids it
  // does not recognise on read, so a stored unknown id would be
  // invisible-but-filterable data.
  @ValidateIf((o: OpenToEntryDto) => o.kind === 'preset')
  @IsIn(OPEN_TO_PRESET_IDS)
  id?: string;

  // Stored verbatim (whitespace trim only) by normalizeOpenTo — this is the
  // long tail the taxonomy does not cover, so it is not normalised.
  @ValidateIf((o: OpenToEntryDto) => o.kind === 'custom')
  @IsString()
  @MaxLength(MAX_OPEN_TO_LABEL_LENGTH)
  label?: string;
}

export class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(100) firstName?: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
  @IsOptional() @IsString() @MaxLength(100) pronouns?: string;
  @IsOptional() @IsString() @MaxLength(160) tagline?: string;
  @IsOptional() @IsString() @MaxLength(5000) bio?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;

  // `''` is meaningful — it CLEARS the status (the frontend hides the whole Now
  // section when empty), so this is not treated as "no change". See
  // ProfilesService.updateMe.
  @IsOptional() @IsString() @MaxLength(MAX_NOW_LENGTH) now?: string;

  @IsOptional() @IsEnum(ProfileVisibility) visibility?: ProfileVisibility;

  // A full REPLACE of the list, not a merge — consistent with
  // PUT /profiles/me/socials|work|skills.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_OPEN_TO_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => OpenToEntryDto)
  openTo?: OpenToEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  // Private Settings → Interests preferences — never shown on the public profile.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  identities?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  lookingFor?: string[];
}

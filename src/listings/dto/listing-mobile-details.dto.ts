import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  LISBON_PARISH_NAMES,
  NEARBY_MUNICIPALITIES,
} from '../listing-mobile-details';

/**
 * A list's string entries in Unicode NFC and trimmed, so a decomposed "Belém"
 * from a client passes `@IsIn` and is stored precomposed. Any other value
 * passes through for the validators below to refuse.
 */
function normalizedNameList({ value }: { value: unknown }): unknown {
  if (!Array.isArray(value)) return value;
  return (value as unknown[]).map((entry) =>
    typeof entry === 'string' ? entry.normalize('NFC').trim() : entry,
  );
}

/**
 * "Where you work", validated field by field. Every key is optional on input;
 * the service fills the defaults (`normalizeListingMobileDetails`) and applies
 * the rules that need the other fields (`resolveMobileListingFields`: "some
 * parishes" needs one, a listing that is not mobile gets the default).
 */
export class ListingMobileDetailsDto {
  @IsOptional() @IsBoolean() allOfCity?: boolean;

  @IsOptional()
  @Transform(normalizedNameList)
  @IsArray()
  @ArrayMaxSize(LISBON_PARISH_NAMES.length)
  @IsString({ each: true })
  @IsIn(LISBON_PARISH_NAMES, { each: true })
  parishes?: string[];

  @IsOptional()
  @Transform(normalizedNameList)
  @IsArray()
  @ArrayMaxSize(NEARBY_MUNICIPALITIES.length)
  @IsString({ each: true })
  @IsIn(NEARBY_MUNICIPALITIES, { each: true })
  alsoTravelsTo?: string[];

  @IsOptional() @IsBoolean() byAppointment?: boolean;
}

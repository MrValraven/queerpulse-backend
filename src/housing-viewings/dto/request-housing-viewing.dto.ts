import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { HousingViewingMode } from '../entities/housing-viewing.entity';
import { IsInstantString } from './is-instant-string.decorator';

/** POST /housing-viewings body. The requester is the session user; the listing
 * (and therefore the lister) is resolved from `listingRef` server-side. */
export class RequestHousingViewingDto {
  // Refs are the short public identifier (`HL-1234`); 64 is far above any
  // generated value and keeps an oversized string out of the lookup.
  @IsString() @MaxLength(64) listingRef!: string;

  @IsEnum(HousingViewingMode) mode!: HousingViewingMode;

  // One to three proposed start times, each a full ISO-8601 instant WITH an
  // offset. The lister accepts one or counter-proposes. The service also
  // rejects past slots and collapses duplicates.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsInstantString({ each: true })
  proposedSlots!: string[];

  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

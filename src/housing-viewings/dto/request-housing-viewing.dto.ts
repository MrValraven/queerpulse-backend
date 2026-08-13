import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { HousingViewingMode } from '../entities/housing-viewing.entity';

/** POST /housing-viewings body. The requester is the session user; the listing
 * (and therefore the lister) is resolved from `listingRef` server-side. */
export class RequestHousingViewingDto {
  @IsString() listingRef!: string;

  @IsEnum(HousingViewingMode) mode!: HousingViewingMode;

  // One to three proposed start times (ISO-8601). The lister accepts one or
  // counter-proposes.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsDateString({}, { each: true })
  proposedSlots!: string[];

  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

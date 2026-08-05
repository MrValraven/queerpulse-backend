import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body of `POST /safe-space-nominations`. Only `placeName` is required — the
 * member may not know the exact address or type, and we would rather capture a
 * bare pointer than block the submission. `listingRef` is set by the client
 * when the nomination targets a place already in the directory.
 */
export class CreateSafeSpaceNominationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  placeName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  placeType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  listingRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

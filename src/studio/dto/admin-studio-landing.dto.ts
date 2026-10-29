import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  STUDIO_LANDING_PHOTO_SLOTS,
  STUDIO_LIMITS,
  StudioLandingPhotoSlot,
} from '../studio.constants';
import { trimStringValue } from './create-studio-release.dto';

/** `POST /admin/studio/landing/previews`: the track staff ask an artist to show. */
export class CreateStudioLandingPreviewDto {
  @IsUUID()
  trackId!: string;
}

/** `POST /admin/studio/landing/previews/reorder`: every open preview once, in the new order. */
export class ReorderStudioLandingPreviewsDto {
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.landingOpenPreviewsMax)
  @IsUUID('all', { each: true })
  previewIds!: string[];
}

/** `POST /admin/studio/landing/artist-cards`: the consent tick is a boolean here and the service refuses a false one with `studio_landing_consent_required`. */
export class CreateStudioLandingArtistCardDto {
  @IsUUID()
  subprofileId!: string;

  /** Trimmed; an empty quote stores null. */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.landingQuoteMaxLength)
  quote?: string | null;

  @IsBoolean()
  hasConsent!: boolean;
}

/** `PATCH /admin/studio/landing/artist-cards/:cardId`: the quote key is required and null clears it. */
export class UpdateStudioLandingArtistCardDto {
  @ValidateIf((_body: object, value: unknown) => value !== null)
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.landingQuoteMaxLength)
  quote!: string | null;

  @IsBoolean()
  hasConsent!: boolean;
}

/** `POST /admin/studio/landing/artist-cards/reorder`: every card once, in the new order. */
export class ReorderStudioLandingArtistCardsDto {
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.landingArtistCardsMax)
  @IsUUID('all', { each: true })
  cardIds!: string[];
}

/** The `:slot` param of the photo routes: the hero or the manifesto photo. */
export class StudioLandingPhotoSlotParams {
  @IsIn(STUDIO_LANDING_PHOTO_SLOTS)
  slot!: StudioLandingPhotoSlot;
}

/** `PUT /admin/studio/landing/photos/:slot`: a fresh work-image upload key or the stored landing key, two alt texts, an optional credit and the consent tick. */
export class PutStudioLandingPhotoDto {
  /** The staff member's own work-image upload key, or the stored landing-scoped key to keep the photo. */
  @IsNotEmpty()
  @IsImageReference()
  imageKey!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.landingPhotoAltMaxLength)
  altTextEn!: string;

  @Transform(trimStringValue)
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.landingPhotoAltMaxLength)
  altTextPt!: string;

  /** Trimmed; an empty credit stores null. */
  @IsOptional()
  @Transform(trimStringValue)
  @IsString()
  @MaxLength(STUDIO_LIMITS.landingPhotoCreditMaxLength)
  credit?: string | null;

  @IsBoolean()
  hasConsent!: boolean;
}

/** `POST /admin/studio/landing/founding-artists`: the persona to list. */
export class CreateStudioFoundingArtistDto {
  @IsUUID()
  subprofileId!: string;
}

/** `POST /admin/studio/landing/founding-artists/reorder`: every founding artist once, in the new order. */
export class ReorderStudioFoundingArtistsDto {
  @IsArray()
  @ArrayMaxSize(STUDIO_LIMITS.foundingArtistsMax)
  @IsUUID('all', { each: true })
  foundingArtistIds!: string[];
}

/** `PUT /admin/studio/landing/settings`: shows or hides the founding artists shelf. */
export class UpdateStudioLandingSettingsDto {
  @IsBoolean()
  isFoundingShelfVisible!: boolean;
}

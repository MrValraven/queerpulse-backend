import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  MAX_ONLINE_MORE_LINKS,
  MAX_ONLINE_NOTE_LENGTH,
  MAX_ONLINE_URL_LENGTH,
  MAX_REGISTRATION_NUMBER_LENGTH,
  ONLINE_FULFILMENT_OPTIONS,
  ONLINE_LINK_PLATFORMS,
  ONLINE_MAIN_LINK_KINDS,
  ONLINE_PAYMENT_METHODS,
  ONLINE_SESSION_FORMATS,
  ONLINE_SHIPS_FROM_OPTIONS,
  PROFESSIONAL_REGISTRATION_BODIES,
  type OnlineFulfilment,
  type OnlineLinkPlatform,
  type OnlineMainLinkKind,
  type OnlinePaymentMethod,
  type OnlineSessionFormat,
  type OnlineShipsFrom,
  type ProfessionalRegistrationBody,
} from '../listing-online-details';
import {
  MAX_SHOP_ITEM_ID_LENGTH,
  MAX_SHOP_ITEM_NAME_LENGTH,
  MAX_SHOP_ITEM_PRICE_LENGTH,
} from '../listing-shop-items';
import { IsOnlineListingUrl } from './online-listing-url.validator';

// The nested request shapes of an online listing. Each is a fixed-shape class
// so the global `forbidNonWhitelisted` pipe refuses a stray key, and only
// known keys ever reach the jsonb columns (the `ListingHoursDto` precedent).
//
// A link's `@MaxLength` leaves room for the `https://` the server prefixes,
// so an editor echoing a stored link back passes. `@IsOnlineListingUrl`
// holds the real ceiling: 300 characters after the scheme.

export class ListingOnlineMainLinkDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ONLINE_URL_LENGTH + 'https://'.length)
  @IsOnlineListingUrl()
  url!: string;

  @IsIn(ONLINE_MAIN_LINK_KINDS) kind!: OnlineMainLinkKind;
}

export class ListingOnlineMoreLinkDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ONLINE_URL_LENGTH + 'https://'.length)
  @IsOnlineListingUrl()
  url!: string;

  @IsIn(ONLINE_LINK_PLATFORMS) platform!: OnlineLinkPlatform;
}

export class ListingProfessionalRegistrationDto {
  @IsIn([...PROFESSIONAL_REGISTRATION_BODIES, ''])
  body!: ProfessionalRegistrationBody | '';

  @IsString() @MaxLength(MAX_REGISTRATION_NUMBER_LENGTH) number!: string;
}

/**
 * `onlineDetails` on create and update. Every key is optional: the service
 * normalises the body to a complete value and then applies the online write
 * rules (`resolveOnlineListingFields`), which is where "a listing that sells
 * online needs a main link" lives. `adultTermsAcceptedAt` is accepted so a
 * client can echo the owner wire back, and the server ignores it.
 */
export class ListingOnlineDetailsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingOnlineMainLinkDto)
  mainLink?: ListingOnlineMainLinkDto | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ONLINE_MORE_LINKS)
  @ValidateNested({ each: true })
  @Type(() => ListingOnlineMoreLinkDto)
  moreLinks?: ListingOnlineMoreLinkDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ONLINE_FULFILMENT_OPTIONS.length)
  @IsIn(ONLINE_FULFILMENT_OPTIONS, { each: true })
  fulfilment?: OnlineFulfilment[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ONLINE_NOTE_LENGTH)
  pickupNote?: string;

  @IsOptional()
  @IsIn([...ONLINE_SHIPS_FROM_OPTIONS, ''])
  shipsFrom?: OnlineShipsFrom | '';

  @IsOptional() @IsBoolean() isVatIncluded?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ONLINE_PAYMENT_METHODS.length)
  @IsIn(ONLINE_PAYMENT_METHODS, { each: true })
  payments?: OnlinePaymentMethod[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ONLINE_SESSION_FORMATS.length)
  @IsIn(ONLINE_SESSION_FORMATS, { each: true })
  sessionFormats?: OnlineSessionFormat[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingProfessionalRegistrationDto)
  registration?: ListingProfessionalRegistrationDto;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ONLINE_NOTE_LENGTH)
  replyNote?: string;

  // Server-set. Accepted only so an echo of the owner wire passes the
  // whitelist; the service never reads it from a request.
  @IsOptional() @IsString() @MaxLength(40) adultTermsAcceptedAt?: string | null;
}

/**
 * A shop item's photo: the same three fields and the same rules as
 * `ListingGalleryPhotoDto` (declared here to keep this file free of an import
 * cycle with `create-listing.dto.ts`). `alt` is required on the wire, the
 * empty string accepted, exactly as on the gallery.
 */
export class ListingShopItemPhotoDto {
  @IsImageReference() image!: string;

  @IsString() @MaxLength(2000) alt!: string;

  @IsOptional() @IsString() @MaxLength(300) caption?: string;
}

/** One "In the shop" item. Replaced wholesale with its list on every PATCH. */
export class ListingShopItemDto {
  // Non-blank: the normaliser trims ids and drops an item whose id is empty.
  @IsString()
  @Matches(/\S/)
  @MaxLength(MAX_SHOP_ITEM_ID_LENGTH)
  id!: string;

  // Required and non-blank: a nameless item is the gap this list exists to close.
  @IsString()
  @Matches(/\S/)
  @MaxLength(MAX_SHOP_ITEM_NAME_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SHOP_ITEM_PRICE_LENGTH)
  price?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ONLINE_URL_LENGTH + 'https://'.length)
  @IsOnlineListingUrl()
  link?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingShopItemPhotoDto)
  photo?: ListingShopItemPhotoDto | null;
}

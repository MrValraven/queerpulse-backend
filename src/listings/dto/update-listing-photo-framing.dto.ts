import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { MAX_LISTING_GALLERY_PHOTOS } from '../listing-photo-gallery';

/**
 * How one gallery photo is positioned inside its frame: the point of the image
 * that stays centred (`focusX`, `focusY`) and how far the image is zoomed in.
 *
 * Each value only has to be a finite number here. The ranges (focus 0 to 1,
 * zoom 1 to the maximum) are clamped server side by the service, so a drag
 * that overshoots the edge by a few pixels still saves and the request goes
 * through. A string, NaN, Infinity or null has no sensible clamp, so
 * those are the shapes the pipe refuses.
 */
export class ListingPhotoFramingDto {
  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'focusX must be a finite number' },
  )
  focusX!: number;

  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'focusY must be a finite number' },
  )
  focusY!: number;

  @IsNumber(
    { allowNaN: false, allowInfinity: false },
    { message: 'zoom must be a finite number' },
  )
  zoom!: number;
}

/** One photo of the gallery, named by its image, with the framing to save. */
export class ListingPhotoFramingEntryDto {
  /**
   * The value the read side sent for this photo. The upload interceptor
   * collapses it to the bare storage key before validation, and the service
   * matches it against the gallery by that key.
   */
  @IsImageReference()
  image!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => ListingPhotoFramingDto)
  framing!: ListingPhotoFramingDto;
}

/**
 * Body of both `PATCH /listings/:ref/photo-framing` (the owner or co-manager)
 * and its admin twin: the framing of one or more gallery photos, saved in one
 * request after the person finishes repositioning.
 *
 * The routes touch `photo_gallery` alone. Alt text, captions, order and the
 * rest of the listing keep their stored values, which is why the listing
 * editor DTOs do not accept `framing` themselves: a photo's position is
 * written here and only here.
 *
 * The list holds between one and `MAX_LISTING_GALLERY_PHOTOS` entries, the
 * most a gallery can hold, so a body larger than any gallery is refused before
 * the service looks anything up.
 */
export class UpdateListingPhotoFramingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LISTING_GALLERY_PHOTOS)
  @ValidateNested({ each: true })
  @Type(() => ListingPhotoFramingEntryDto)
  photos!: ListingPhotoFramingEntryDto[];
}

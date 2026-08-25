import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/** Body for `POST /directory/:slug/reviews` — a member leaving a review. */
export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  stars!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  text!: string;

  /**
   * Optional single photo, as a storage key from `POST /uploads/presign` with
   * `kind: 'listing-photo'` (or the `<apiBaseUrl>/files/<key>` URL a read
   * returned, which the global `StorageKeyOwnershipInterceptor` normalises back
   * to the bare key before this validator sees it). `''` clears the slot,
   * matching every other image field in this codebase.
   *
   * `@IsImageReference` is what bounds the value; the interceptor is what
   * enforces that the key belongs to the caller. Neither this DTO nor anything
   * else on the server can verify the image was stripped of its metadata: the
   * upload goes direct to storage and the client owns that step.
   */
  @IsOptional()
  @IsImageReference()
  photo?: string;
}

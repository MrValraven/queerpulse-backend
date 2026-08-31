import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * Body for `PATCH /me/collections/:id` — rename / re-emoji / re-cover. Every
 * field is optional (a rename need only send `name`), but a sent field must be
 * valid: an empty `name` is rejected rather than silently blanking the title.
 *
 * Not derived via `PartialType(CreateCollectionDto)` on purpose: `MaxLength`
 * carries over but `@IsNotEmpty` would be dropped by `PartialType`, so `name`
 * is re-declared here to keep the non-empty guard.
 */
export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  // Same bound as the create body: one of our storage keys or an `https://` URL
  // on a trusted host, never a `javascript:`/`data:` URI or an arbitrary host.
  // See `CreateCollectionDto.cover` for why refusing a non-image value here
  // breaks no colour cover (there has never been one).
  @IsOptional()
  @IsImageReference()
  cover?: string;
}

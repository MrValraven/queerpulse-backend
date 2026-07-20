import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { isStorageKey } from '../../storage/storage-key';

// Longest legitimate value is an external CDN URL with query params; our own
// keys are ~90 chars. This replaces the previous per-DTO caps, which ranged
// from 500 to 2048 for no articulated reason.
const MAX_IMAGE_REFERENCE_LENGTH = 2048;

/**
 * An image field holds either one of our storage keys or an external `https://`
 * URL — see `toImageUrl`. Anything else is refused.
 *
 * These fields were previously `@IsString()` with only a length cap, so a
 * client could persist a `javascript:` or `data:` URI that other members'
 * browsers would then render. `http://` is refused too: it would be blocked as
 * mixed content anyway, and accepting it invites a downgrade.
 */
export function IsImageReference(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isImageReference',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === null) {
            return true;
          }
          if (typeof value !== 'string') {
            return false;
          }
          // An empty string means "no image", exactly like `null` above. This
          // is what the old `@IsString() @MaxLength(...)` validation allowed,
          // and every wizard/form on the frontend sends `''` for an unset
          // photo slot rather than omitting the field — `@IsOptional()` only
          // skips `undefined`/`null`, not `''`, so without this the empty
          // string a client always sends would fail validation on every save.
          // `toImageUrl('')` already normalises it to `null` at the response
          // boundary, so this is consistent end to end.
          if (value === '') {
            return true;
          }
          if (value.length > MAX_IMAGE_REFERENCE_LENGTH) {
            return false;
          }
          return isStorageKey(value) || value.startsWith('https://');
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an uploaded image key or an https:// URL`;
        },
      },
    });
  };
}

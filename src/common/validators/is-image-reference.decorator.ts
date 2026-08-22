import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { storageKeyFromImageUrl } from '../image-url';
import { isStorageKey } from '../../storage/storage-key';

// Longest legitimate value is an external CDN URL with query params; our own
// keys are ~90 chars. This replaces the previous per-DTO caps, which ranged
// from 500 to 2048 for no articulated reason.
const MAX_IMAGE_REFERENCE_LENGTH = 2048;

/**
 * The only hosts an image field may point at besides our own storage.
 *
 * `toImageUrl`'s contract names exactly two sources of an absolute URL in this
 * database: a Google account photo taken from the OAuth profile, and the
 * seeded Unsplash editorial imagery. Mux thumbnails are the third, minted by
 * `MuxService` rather than by a member. Everything else that reached these
 * columns was a member typing a URL into a form.
 *
 * That mattered because these values are rendered by OTHER members' browsers:
 * a group avatar or event cover is fetched by every participant on every inbox
 * render, so an arbitrary host let one member collect the IP address, user
 * agent and viewing times of everyone else in the group from a 1x1 tracking
 * pixel, with no action by any of them. On a platform whose members may not be
 * out, that is a safety problem, and `referrerPolicy="no-referrer"` on the
 * client does not stop the request itself.
 *
 * Entries are matched as a domain plus its subdomains (`googleusercontent.com`
 * covers `lh3.`, `lh4.`, … which Google rotates through). Adding a host here is
 * a deliberate decision: it grants that operator a view of who is looking at
 * what, so it should be somewhere we already trust with our images.
 */
const ALLOWED_IMAGE_HOSTS = [
  // Google account photos (OAuth sign-in) and Google Places photos.
  'googleusercontent.com',
  // Seeded editorial imagery (magazine covers, decks, sample profiles). The
  // domain, not just `images.`, because the same library is served from
  // `plus.unsplash.com` too.
  'unsplash.com',
  // Mux poster/storyboard frames for cinema titles.
  'image.mux.com',
];

/**
 * True when `value` is an `https://` URL on {@link ALLOWED_IMAGE_HOSTS}.
 *
 * Parsed with `URL` rather than string-matched: `https://evil.example/?x=
 * images.unsplash.com` and `https://images.unsplash.com@evil.example/pixel`
 * both contain a trusted host as a substring, and neither is served by one.
 */
function isAllowedExternalImage(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // `http://` would be blocked as mixed content anyway, and accepting it
  // invites a downgrade.
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * An image field holds one of our storage keys, or an `https://` URL on one of
 * the few hosts we already serve images from ({@link ALLOWED_IMAGE_HOSTS}).
 * Anything else is refused.
 *
 * These fields were previously `@IsString()` with only a length cap, so a
 * client could persist a `javascript:` or `data:` URI that other members'
 * browsers would then render. That hole is closed, and so is the wider one
 * that replaced it: "any `https://` URL" still let a member point every other
 * member's browser at a host of their choosing.
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
          // `storageKeyFromImageUrl` collapses our OWN resolved read URL
          // (`<apiBaseUrl>/files/<key>`) back to the bare key, which is the
          // shape several edit forms re-send on save — the same normalisation
          // the write paths apply before persisting. So both shapes of "one of
          // our uploads" are accepted here, and neither has to be listed as a
          // trusted external host.
          if (isStorageKey(storageKeyFromImageUrl(value))) {
            return true;
          }
          return isAllowedExternalImage(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be an uploaded image key or an https:// URL on a trusted image host`;
        },
      },
    });
  };
}

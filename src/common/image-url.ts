import { isStorageKey } from '../storage/storage-key';

// Every image field in the database holds one of two things:
//
//   a storage key      — everything uploaded through `/uploads/presign`
//   an absolute URL    — Google OAuth avatars (`users.service.ts`) and the
//                        seeded Unsplash magazine authors
//
// Railway Buckets are private, so a key is not directly fetchable; it becomes a
// URL to our own `GET /files/*` route, which authorizes and redirects. External
// URLs are already fetchable and pass through.
//
// Anything that is neither is dropped rather than forwarded. These columns have
// never validated their input, so a `javascript:` or `data:` URI could have
// been persisted and would otherwise be rendered in another member's browser.
//
// WHY A MODULE-LEVEL SINGLETON rather than an injectable service: the response
// mappers that call this are exported plain functions, not Nest providers, so
// they cannot receive a dependency. `CommonModule` sets the base URL once at
// bootstrap; it is a static config value that never changes at runtime.

let apiBaseUrl: string | null = null;

/** Called once during bootstrap by `CommonModule`. */
export function setImageUrlBase(nextApiBaseUrl: string): void {
  apiBaseUrl = nextApiBaseUrl.replace(/\/$/, '');
}

/** Restores the uninitialised state so specs do not leak into one another. */
export function resetImageUrlBaseForTesting(): void {
  apiBaseUrl = null;
}

export function toImageUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (isStorageKey(value)) {
    if (!apiBaseUrl) {
      // Reaching this means a mapper ran before bootstrap wired the base URL.
      // Returning a bare key would render as a broken relative image; failing
      // loudly surfaces the wiring bug at the first request instead.
      throw new Error(
        'Image URL base is not configured — setImageUrlBase() was never called',
      );
    }
    return `${apiBaseUrl}/files/${value}`;
  }
  if (value.startsWith('https://')) {
    return value;
  }
  return null;
}

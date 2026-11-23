/**
 * SEC-24: the hosts a `kind:'gif'` message may point its `url` and
 * `previewUrl` at. The bubble renders both as `<img src>` on every
 * participant's device, so an open allowlist let any counterpart load an
 * arbitrary remote image (an IP and read-time beacon, or unmoderated content
 * labelled as a GIF). The GIF picker searches KLIPY (`src/shared/api/gifs.ts`
 * in the frontend), whose media is served from `static.klipy.com`. Any
 * KLIPY-run subdomain is accepted, so a CDN host change on their side keeps
 * working; every other host is refused with {@link GIF_HOST_NOT_ALLOWED_CODE}.
 */
export const GIF_MEDIA_HOST_SUFFIX = 'klipy.com';

/** The 400 code for a GIF whose `url` or `previewUrl` leaves the allowlist. */
export const GIF_HOST_NOT_ALLOWED_CODE = 'GIF_HOST_NOT_ALLOWED';

/**
 * Whether `candidate` is an https URL on a KLIPY host, with no credentials
 * and no explicit port. Anything that fails to parse is refused.
 */
export function isAllowedGifMediaUrl(candidate: unknown): boolean {
  if (typeof candidate !== 'string') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username || parsed.password || parsed.port) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return (
    hostname === GIF_MEDIA_HOST_SUFFIX ||
    hostname.endsWith(`.${GIF_MEDIA_HOST_SUFFIX}`)
  );
}

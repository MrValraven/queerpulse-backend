// NOTE: keep these patterns in sync with the FE copy at
// queerpulse/src/features/marketing/listBusiness/googleMapsLink.ts

const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'www.google.com',
  'google.com',
  'maps.google.com',
]);

// google.<tld> country domains, optionally with a www./maps. prefix
const GOOGLE_COUNTRY = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

function parseHost(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedGoogleMapsHost(rawUrl: string): boolean {
  const host = parseHost(rawUrl);
  if (host === null) return false;
  return ALLOWED_HOSTS.has(host) || GOOGLE_COUNTRY.test(host);
}

function inRange(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function extractPlaceName(rawUrl: string): string | undefined {
  const match = rawUrl.match(/\/maps\/place\/([^/@]+)/);
  const placeSegment = match?.[1];
  if (placeSegment === undefined) return undefined;
  try {
    return (
      decodeURIComponent(placeSegment.replace(/\+/g, ' ')).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function extractCoordsFromUrl(
  rawUrl: string,
): { latitude: number; longitude: number; placeName?: string } | null {
  if (typeof rawUrl !== 'string') return null;

  // Preferred: the actual place pin encoded as !3d<lat>!4d<lng>
  const pin = rawUrl.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  // Fallbacks: @lat,lng viewport, or q=/query= coordinate pairs
  const at = rawUrl.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const query = rawUrl.match(
    /[?&](?:q|query)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  );

  const source = pin ?? query ?? at;
  if (!source) return null;

  const latitude = Number(source[1]);
  const longitude = Number(source[2]);
  if (!inRange(latitude, longitude)) return null;

  const placeName = extractPlaceName(rawUrl);
  return placeName
    ? { latitude, longitude, placeName }
    : { latitude, longitude };
}

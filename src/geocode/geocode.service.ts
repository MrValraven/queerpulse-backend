import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { assertPublicUrl } from '../link-preview/ssrf';
import {
  extractCoordsFromUrl,
  isAllowedGoogleMapsHost,
} from './google-maps-link';

const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;

// OpenStreetMap Nominatim — a keyless public forward-geocoder for the wizard's
// "Locate this address" button (item #1). The wizard only needs a single
// best-match pin; when Nominatim can't place the text this returns 422 and the
// frontend falls back to a neighbourhood-centroid pin, so the member is never
// stranded without a location.
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
}

function inCoordinateRange(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

@Injectable()
export class GeocodeService {
  /**
   * Free-text address → coordinates (item #1, `POST /geocode/address`). Reuses
   * the shared SSRF guard (`assertPublicUrl` — the same helper the link-preview
   * + web-push outbound paths use) rather than introducing a second unguarded
   * outbound-fetch surface: the provider host is fixed and trusted, but
   * validating it through the shared guard, plus `redirect: 'error'` so a
   * surprise redirect can never carry the request to an unvalidated host, keeps
   * this consistent with every other server-initiated fetch. Returns 422 when
   * the address can't be placed so the frontend falls back to a pin.
   */
  async resolveAddress(
    address: string,
  ): Promise<{ latitude: number; longitude: number; placeName?: string }> {
    const query = address.trim();
    if (!query) {
      throw new UnprocessableEntityException('Enter an address to locate.');
    }

    const url = new URL(NOMINATIM_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '0');

    let validated: URL;
    try {
      validated = await assertPublicUrl(url.toString());
    } catch {
      throw new ServiceUnavailableException(
        "Couldn't reach the address geocoder.",
      );
    }

    let response: Response;
    try {
      response = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          // Nominatim's usage policy requires an identifying UA; no
          // cookies/credentials are sent.
          'user-agent': 'QueerPulseBot/1.0 (+listing-geocode)',
          accept: 'application/json',
        },
      });
    } catch {
      throw new ServiceUnavailableException(
        "Couldn't reach the address geocoder.",
      );
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(
        "The address geocoder didn't respond — drop a pin instead.",
      );
    }

    let results: unknown;
    try {
      results = await response.json();
    } catch {
      throw new UnprocessableEntityException(
        "Couldn't read a location for that address.",
      );
    }

    const first =
      Array.isArray(results) && results.length > 0
        ? (results[0] as NominatimResult)
        : undefined;
    if (!first || first.lat === undefined || first.lon === undefined) {
      throw new UnprocessableEntityException(
        "Couldn't find that address — drop a pin on the map instead.",
      );
    }

    const latitude = Number(first.lat);
    const longitude = Number(first.lon);
    if (!inCoordinateRange(latitude, longitude)) {
      throw new UnprocessableEntityException(
        "Couldn't find that address — drop a pin on the map instead.",
      );
    }

    const placeName = first.display_name?.trim() || undefined;
    return placeName
      ? { latitude, longitude, placeName }
      : { latitude, longitude };
  }

  async resolveLink(
    url: string,
  ): Promise<{ latitude: number; longitude: number; placeName?: string }> {
    if (!isAllowedGoogleMapsHost(url)) {
      throw new BadRequestException('Only Google Maps links are supported.');
    }

    // A full URL may already carry coordinates — no network needed.
    const direct = extractCoordsFromUrl(url);
    if (direct) return direct;

    // Manual redirect loop: every hop's host is validated against the
    // allowlist BEFORE it is fetched, so a crafted redirect chain can never
    // make this server issue a request to a non-allowlisted (e.g. internal)
    // host. Using `redirect: 'follow'` here would be an SSRF hole, since
    // fetch would auto-follow to an unvalidated intermediate host.
    let currentUrl = url;
    for (
      let redirectCount = 0;
      redirectCount < MAX_REDIRECTS;
      redirectCount += 1
    ) {
      if (!isAllowedGoogleMapsHost(currentUrl)) {
        throw new BadRequestException(
          'That link did not resolve to Google Maps.',
        );
      }

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new ServiceUnavailableException(
          "Couldn't reach Google Maps to read that link.",
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new UnprocessableEntityException(
            "Couldn't read coordinates from that link.",
          );
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new UnprocessableEntityException(
            "Couldn't read coordinates from that link.",
          );
        }
        if (!isAllowedGoogleMapsHost(nextUrl)) {
          throw new BadRequestException(
            'That link did not resolve to Google Maps.',
          );
        }

        currentUrl = nextUrl;
        const redirectCoords = extractCoordsFromUrl(currentUrl);
        if (redirectCoords) return redirectCoords;
        continue;
      }

      const coords = extractCoordsFromUrl(currentUrl);
      if (!coords) {
        throw new UnprocessableEntityException(
          "Couldn't read coordinates from that link.",
        );
      }
      return coords;
    }

    throw new UnprocessableEntityException(
      "Couldn't read coordinates from that link.",
    );
  }
}

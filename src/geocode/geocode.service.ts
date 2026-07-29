import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { extractCoordsFromUrl, isAllowedGoogleMapsHost } from './google-maps-link';

const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 5;

@Injectable()
export class GeocodeService {
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
    for (let redirectCount = 0; redirectCount < MAX_REDIRECTS; redirectCount += 1) {
      if (!isAllowedGoogleMapsHost(currentUrl)) {
        throw new BadRequestException('That link did not resolve to Google Maps.');
      }

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new ServiceUnavailableException("Couldn't reach Google Maps to read that link.");
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new UnprocessableEntityException("Couldn't read coordinates from that link.");
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          throw new UnprocessableEntityException("Couldn't read coordinates from that link.");
        }
        if (!isAllowedGoogleMapsHost(nextUrl)) {
          throw new BadRequestException('That link did not resolve to Google Maps.');
        }

        currentUrl = nextUrl;
        const redirectCoords = extractCoordsFromUrl(currentUrl);
        if (redirectCoords) return redirectCoords;
        continue;
      }

      const coords = extractCoordsFromUrl(currentUrl);
      if (!coords) {
        throw new UnprocessableEntityException("Couldn't read coordinates from that link.");
      }
      return coords;
    }

    throw new UnprocessableEntityException("Couldn't read coordinates from that link.");
  }
}

import {
  BadRequestException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GeocodeService } from './geocode.service';

describe('GeocodeService.resolveLink', () => {
  const service = new GeocodeService();
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('rejects a non-Google host without fetching', async () => {
    const spy = jest.fn();
    global.fetch = spy;
    await expect(
      service.resolveLink('https://evil.com/x'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('follows a short link and extracts coords from the expanded url', async () => {
    // Manual-redirect flow: the mock returns a 302 with a Location header
    // pointing at an allowlisted google.com url that already carries coords,
    // so resolveLink extracts them from the Location target without a
    // second fetch.
    global.fetch = ((input: string) => ({
      status: 302,
      headers: {
        get: (header: string) =>
          header.toLowerCase() === 'location'
            ? 'https://www.google.com/maps/place/Bar+Name/@38.7,-9.1,17z/data=!3d38.7223!4d-9.1393'
            : null,
      },
      url: String(input),
    })) as unknown as typeof fetch;
    await expect(
      service.resolveLink('https://maps.app.goo.gl/abc'),
    ).resolves.toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
      placeName: 'Bar Name',
    });
  });

  it('throws Unprocessable when the expanded url has no coords', async () => {
    // First hop redirects to an allowlisted google.com url with no coords in
    // it; the second (final, non-redirect) fetch to that same url still has
    // no coords, so resolveLink gives up with Unprocessable.
    let fetchCallCount = 0;
    global.fetch = (() => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        return {
          status: 302,
          headers: {
            get: (header: string) =>
              header.toLowerCase() === 'location'
                ? 'https://www.google.com/maps/place/Bar+Name/'
                : null,
          },
          url: 'https://maps.app.goo.gl/abc',
        };
      }
      return {
        status: 200,
        headers: { get: () => null },
        url: 'https://www.google.com/maps/place/Bar+Name/',
      };
    }) as unknown as typeof fetch;
    await expect(
      service.resolveLink('https://maps.app.goo.gl/abc'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('throws ServiceUnavailable when fetch rejects', async () => {
    global.fetch = () => {
      throw new Error('network');
    };
    await expect(
      service.resolveLink('https://maps.app.goo.gl/abc'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws Unprocessable when the redirect Location is unparseable', async () => {
    // 'http://[' is a malformed absolute-URL attempt (unterminated IPv6
    // literal) that `new URL(location, currentUrl)` genuinely throws on, even
    // when resolved against a valid base — verified directly against the
    // WHATWG URL implementation. (A merely "weird-looking" string like
    // '::::not a url::::' is NOT a good fixture here: the URL parser is
    // lenient with relative references and percent-encodes it into a valid
    // path instead of throwing, so it wouldn't exercise this catch block.)
    global.fetch = ((input: string) => ({
      status: 302,
      headers: {
        get: (header: string) =>
          header.toLowerCase() === 'location' ? 'http://[' : null,
      },
      url: String(input),
    })) as unknown as typeof fetch;
    await expect(
      service.resolveLink('https://maps.app.goo.gl/abc'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

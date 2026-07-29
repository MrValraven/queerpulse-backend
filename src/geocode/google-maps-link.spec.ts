import {
  extractCoordsFromUrl,
  isAllowedGoogleMapsHost,
} from './google-maps-link';

describe('extractCoordsFromUrl', () => {
  it('prefers the !3d!4d place pin over the @ viewport', () => {
    const url =
      'https://www.google.com/maps/place/Bar+Name/@38.71,-9.10,17z/data=!3d38.7223!4d-9.1393';
    expect(extractCoordsFromUrl(url)).toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
      placeName: 'Bar Name',
    });
  });

  it('falls back to the @lat,lng viewport when no !3d!4d', () => {
    expect(
      extractCoordsFromUrl('https://www.google.com/maps/@38.7223,-9.1393,17z'),
    ).toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
    });
  });

  it('reads ?q=lat,lng and query=lat,lng', () => {
    expect(
      extractCoordsFromUrl('https://maps.google.com/?q=38.7223,-9.1393'),
    ).toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
    });
    expect(
      extractCoordsFromUrl(
        'https://www.google.com/maps/search/?api=1&query=38.7223,-9.1393',
      ),
    ).toEqual({ latitude: 38.7223, longitude: -9.1393 });
  });

  it('returns null for a short link with no coords', () => {
    expect(extractCoordsFromUrl('https://maps.app.goo.gl/abc123')).toBeNull();
  });

  it('returns null for out-of-range coordinates', () => {
    expect(
      extractCoordsFromUrl('https://www.google.com/maps/@200,-9.1,17z'),
    ).toBeNull();
  });

  it('returns null for junk', () => {
    expect(extractCoordsFromUrl('not a url')).toBeNull();
  });
});

describe('isAllowedGoogleMapsHost', () => {
  it.each([
    'https://maps.app.goo.gl/x',
    'https://goo.gl/maps/x',
    'https://www.google.com/maps/x',
    'https://google.com/maps/x',
    'https://maps.google.com/?q=1,2',
    'https://www.google.pt/maps/x',
  ])('allows %s', (url) => expect(isAllowedGoogleMapsHost(url)).toBe(true));

  it.each([
    'https://evil.com/maps',
    'https://google.com.evil.com/x',
    'not a url',
  ])('rejects %s', (url) => expect(isAllowedGoogleMapsHost(url)).toBe(false));
});

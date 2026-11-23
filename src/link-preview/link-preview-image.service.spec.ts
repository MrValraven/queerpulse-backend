import {
  LinkPreviewImageService,
  MAX_IN_FLIGHT_IMAGE_FETCHES,
} from './link-preview-image.service';
import { safeFetchImage } from './ssrf';

jest.mock('./ssrf', () => {
  const actual = jest.requireActual<typeof import('./ssrf')>('./ssrf');
  return { ...actual, safeFetchImage: jest.fn() };
});

const mockedSafeFetchImage = jest.mocked(safeFetchImage);
const IMAGE_URL = 'https://elsewhere.example/og/card.png';
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

beforeEach(() => {
  mockedSafeFetchImage.mockReset();
});

describe('LinkPreviewImageService (SEC-23)', () => {
  it('relays an image whose bytes match its declared type', async () => {
    mockedSafeFetchImage.mockResolvedValue({
      body: PNG_BYTES,
      contentType: 'image/png',
    });
    const service = new LinkPreviewImageService();

    const image = await service.load(IMAGE_URL);

    expect(image?.contentType).toBe('image/png');
    expect(image?.body.equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(mockedSafeFetchImage).toHaveBeenCalledWith(IMAGE_URL);
  });

  it('refuses bytes that do not match the declared image type', async () => {
    mockedSafeFetchImage.mockResolvedValue({
      body: new TextEncoder().encode('<script>alert(1)</script>'),
      contentType: 'image/png',
    });
    const service = new LinkPreviewImageService();

    await expect(service.load(IMAGE_URL)).resolves.toBeNull();
  });

  it('refuses a type outside the relayable list', async () => {
    mockedSafeFetchImage.mockResolvedValue({
      body: new TextEncoder().encode('<svg/>'),
      contentType: 'image/svg+xml',
    });
    const service = new LinkPreviewImageService();

    await expect(service.load(IMAGE_URL)).resolves.toBeNull();
  });

  it('fetches an image once for every reader inside the cache window', async () => {
    mockedSafeFetchImage.mockResolvedValue({
      body: PNG_BYTES,
      contentType: 'image/png',
    });
    const service = new LinkPreviewImageService();

    await Promise.all([service.load(IMAGE_URL), service.load(IMAGE_URL)]);
    await service.load(IMAGE_URL);

    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(1);
  });

  it('caches a miss so a dud image is fetched once', async () => {
    mockedSafeFetchImage.mockResolvedValue(null);
    const service = new LinkPreviewImageService();

    await expect(service.load(IMAGE_URL)).resolves.toBeNull();
    await expect(service.load(IMAGE_URL)).resolves.toBeNull();

    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(1);
  });

  it('answers null past the in-flight cap and caches nothing for it', async () => {
    let releaseFetches: () => void = () => undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    mockedSafeFetchImage.mockImplementation(async () => {
      await releaseGate;
      return { body: PNG_BYTES, contentType: 'image/png' };
    });
    const service = new LinkPreviewImageService();
    const running = Array.from(
      { length: MAX_IN_FLIGHT_IMAGE_FETCHES },
      (_, index) => service.load(`https://elsewhere.example/${index}.png`),
    );

    await expect(service.load(IMAGE_URL)).resolves.toBeNull();
    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(
      MAX_IN_FLIGHT_IMAGE_FETCHES,
    );

    releaseFetches();
    await Promise.all(running);
    const image = await service.load(IMAGE_URL);

    expect(image?.contentType).toBe('image/png');
    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(
      MAX_IN_FLIGHT_IMAGE_FETCHES + 1,
    );
  });

  it('still shares a running fetch for the same URL at the cap', async () => {
    let releaseFetches: () => void = () => undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    mockedSafeFetchImage.mockImplementation(async () => {
      await releaseGate;
      return { body: PNG_BYTES, contentType: 'image/png' };
    });
    const service = new LinkPreviewImageService();
    const running = Array.from(
      { length: MAX_IN_FLIGHT_IMAGE_FETCHES },
      (_, index) => service.load(`https://elsewhere.example/${index}.png`),
    );

    const shared = service.load('https://elsewhere.example/0.png');
    releaseFetches();

    await expect(shared).resolves.not.toBeNull();
    await Promise.all(running);
    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(
      MAX_IN_FLIGHT_IMAGE_FETCHES,
    );
  });

  it('still serves a cached image while other fetches hold the cap', async () => {
    mockedSafeFetchImage.mockResolvedValueOnce({
      body: PNG_BYTES,
      contentType: 'image/png',
    });
    const service = new LinkPreviewImageService();
    await service.load(IMAGE_URL);

    let releaseFetches: () => void = () => undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    mockedSafeFetchImage.mockImplementation(async () => {
      await releaseGate;
      return { body: PNG_BYTES, contentType: 'image/png' };
    });
    const running = Array.from(
      { length: MAX_IN_FLIGHT_IMAGE_FETCHES },
      (_, index) => service.load(`https://elsewhere.example/${index}.png`),
    );

    const cached = await service.load(IMAGE_URL);

    expect(cached?.contentType).toBe('image/png');
    expect(mockedSafeFetchImage).toHaveBeenCalledTimes(
      MAX_IN_FLIGHT_IMAGE_FETCHES + 1,
    );
    releaseFetches();
    await Promise.all(running);
  });
});

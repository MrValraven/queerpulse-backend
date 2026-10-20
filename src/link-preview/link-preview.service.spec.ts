import { LinkPreviewService } from './link-preview.service';
import { emptyPreview } from './link-preview.response';
import { safeFetchHtml } from './ssrf';

jest.mock('./ssrf', () => ({ safeFetchHtml: jest.fn() }));

const mockedSafeFetchHtml = jest.mocked(safeFetchHtml);
const OWN_ORIGIN = 'https://queerpulse.test';
const STUDIO_ID = '0f8a3c2e-5b1d-4e6f-9a7b-1c2d3e4f5a6b';
const originalFrontendUrl = process.env.FRONTEND_URL;

beforeEach(() => {
  process.env.FRONTEND_URL = OWN_ORIGIN;
  mockedSafeFetchHtml.mockReset();
  mockedSafeFetchHtml.mockResolvedValue({
    html: '<html><head><meta property="og:title" content="Elsewhere"></head></html>',
    finalUrl: 'https://elsewhere.example/page',
  });
});

afterAll(() => {
  if (originalFrontendUrl === undefined) {
    delete process.env.FRONTEND_URL;
  } else {
    process.env.FRONTEND_URL = originalFrontendUrl;
  }
});

describe('LinkPreviewService Studio refusal (Studio rich cards)', () => {
  it.each([
    `${OWN_ORIGIN}/studio/track?id=${STUDIO_ID}`,
    `${OWN_ORIGIN}/studio/preview/${'b'.repeat(43)}`,
    `${OWN_ORIGIN}/studio/artist?id=${STUDIO_ID}`,
    `${OWN_ORIGIN}/studio`,
    `${OWN_ORIGIN}/Studio/album?id=${STUDIO_ID}`,
    `${OWN_ORIGIN}/%73tudio/collection?id=${STUDIO_ID}`,
    `${OWN_ORIGIN}//studio/track?id=${STUDIO_ID}`,
    `${OWN_ORIGIN}\\studio\\track?id=${STUDIO_ID}`,
  ])('answers an empty card for %s without fetching it', async (url) => {
    const service = new LinkPreviewService();

    await expect(service.preview(url)).resolves.toEqual(emptyPreview(url));
    expect(mockedSafeFetchHtml).not.toHaveBeenCalled();
  });

  it('still unfurls a Studio path on another host', async () => {
    const service = new LinkPreviewService();

    await service.preview(
      `https://elsewhere.example/studio/track?id=${STUDIO_ID}`,
    );

    expect(mockedSafeFetchHtml).toHaveBeenCalledTimes(1);
  });

  it('still unfurls a page on this deployment outside Studio', async () => {
    const service = new LinkPreviewService();

    await service.preview(`${OWN_ORIGIN}/events`);

    expect(mockedSafeFetchHtml).toHaveBeenCalledWith(`${OWN_ORIGIN}/events`);
  });

  it('keeps request order in a batch and fetches only the links outside Studio', async () => {
    const service = new LinkPreviewService();
    const studioUrl = `${OWN_ORIGIN}/studio/track?id=${STUDIO_ID}`;
    const otherUrl = 'https://elsewhere.example/page';

    const previews = await service.previewMany([studioUrl, otherUrl]);

    expect(previews[0]).toEqual(emptyPreview(studioUrl));
    expect(previews[1]?.title).toBe('Elsewhere');
    expect(mockedSafeFetchHtml).toHaveBeenCalledTimes(1);
    expect(mockedSafeFetchHtml).toHaveBeenCalledWith(otherUrl);
  });
});

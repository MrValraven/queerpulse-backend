import { parseLandingVisitPage } from './landing-visit-source';

describe('parseLandingVisitPage', () => {
  it('reads an absent page as home and accepts studio', () => {
    expect([
      parseLandingVisitPage(undefined),
      parseLandingVisitPage('home'),
      parseLandingVisitPage('studio'),
    ]).toEqual(['home', 'home', 'studio']);
  });

  it('refuses any other page with invalid_page', () => {
    expect(() => parseLandingVisitPage('admin')).toThrow(
      expect.objectContaining({
        response: {
          message: 'page must be one of home, studio.',
          reason: 'invalid_page',
        },
      }),
    );
  });

  it('refuses an empty page and a page in another case', () => {
    expect(() => parseLandingVisitPage('')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ reason: 'invalid_page' }),
      }),
    );
    expect(() => parseLandingVisitPage('Studio')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ reason: 'invalid_page' }),
      }),
    );
  });
});

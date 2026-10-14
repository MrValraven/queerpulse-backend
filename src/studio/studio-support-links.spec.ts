import {
  isStudioSupportPlatform,
  toStudioSupportLinks,
} from './studio-support-links';

describe('Studio support links', () => {
  it('knows Bandcamp, Ko-fi and Patreon', () => {
    expect(isStudioSupportPlatform('bandcamp')).toBe(true);
    expect(isStudioSupportPlatform('kofi')).toBe(true);
    expect(isStudioSupportPlatform('patreon')).toBe(true);
    expect(isStudioSupportPlatform('instagram')).toBe(false);
  });

  it('keeps the support platforms in the persona link order', () => {
    expect(
      toStudioSupportLinks([
        { platform: 'patreon', urlOrHandle: 'nightshift', position: 3 },
        { platform: 'instagram', urlOrHandle: '@nightshift', position: 0 },
        {
          platform: 'bandcamp',
          urlOrHandle: 'https://nightshift.bandcamp.com',
          position: 1,
        },
        { platform: 'kofi', urlOrHandle: 'nightshift', position: 2 },
      ]),
    ).toEqual([
      { platform: 'bandcamp', urlOrHandle: 'https://nightshift.bandcamp.com' },
      { platform: 'kofi', urlOrHandle: 'nightshift' },
      { platform: 'patreon', urlOrHandle: 'nightshift' },
    ]);
  });

  it('answers an empty list for a persona with no support links', () => {
    expect(
      toStudioSupportLinks([
        { platform: 'website', urlOrHandle: 'https://x.test', position: 0 },
      ]),
    ).toEqual([]);
  });
});

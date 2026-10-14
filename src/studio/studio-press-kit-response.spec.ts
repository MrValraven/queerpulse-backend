import { StudioPressKit } from './entities/studio-press-kit.entity';
import {
  StudioPressPersona,
  readStoredQuotes,
  toStudioPressKitResponse,
} from './studio-press-kit-response';

const persona: StudioPressPersona = {
  id: 'persona-1',
  handle: 'night-shift',
  displayName: 'Night Shift',
  kind: 'dj' as StudioPressPersona['kind'],
  avatarUrl: null,
  bio: 'Sets from the river.',
};

const socialLinks = [
  { platform: 'patreon', urlOrHandle: 'nightshift', position: 2 },
  { platform: 'instagram', urlOrHandle: '@nightshift', position: 0 },
  { platform: 'bandcamp', urlOrHandle: 'nightshift', position: 1 },
];

const storedKit = {
  subprofileId: 'persona-1',
  pitch: 'Lisbon club music',
  pressBio: 'A press bio.',
  featuredTrackIds: ['track-9', 'track-1'],
  quotes: [{ quote: 'Hypnotic', source: 'Rádio Quântica' }],
  contact: 'mailto:booking@nightshift.test',
  updatedAt: new Date('2026-10-12T09:00:00.000Z'),
} as StudioPressKit;

describe('Studio press kit response', () => {
  it('builds a press kit from the persona alone when no row exists', () => {
    const response = toStudioPressKitResponse({
      persona,
      pressKit: null,
      featuredTracks: [],
      isFeaturedFallback: true,
      releases: [],
      socialLinks,
      isOwner: false,
    });
    expect(response.pitch).toBeNull();
    expect(response.bio).toBe('Sets from the river.');
    expect(response.quotes).toEqual([]);
    expect(response.contact).toBeNull();
    expect(response.personaHandle).toBe('night-shift');
    expect(response.artist.city).toBeNull();
    expect(response.owner).toBeNull();
  });

  it('shows the press bio in place of the persona bio and every link in persona order', () => {
    const response = toStudioPressKitResponse({
      persona,
      pressKit: storedKit,
      featuredTracks: [],
      isFeaturedFallback: false,
      releases: [],
      socialLinks,
      isOwner: false,
    });
    expect(response.bio).toBe('A press bio.');
    expect(response.socialLinks).toEqual([
      { platform: 'instagram', urlOrHandle: '@nightshift' },
      { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      { platform: 'patreon', urlOrHandle: 'nightshift' },
    ]);
    expect(response.supportLinks).toEqual([
      { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      { platform: 'patreon', urlOrHandle: 'nightshift' },
    ]);
  });

  it('gives the owner the stored fields, picks no longer playable included', () => {
    const response = toStudioPressKitResponse({
      persona,
      pressKit: storedKit,
      featuredTracks: [],
      isFeaturedFallback: false,
      releases: [],
      socialLinks: [],
      isOwner: true,
    });
    expect(response.owner).toEqual({
      pitch: 'Lisbon club music',
      pressBio: 'A press bio.',
      featuredTrackIds: ['track-9', 'track-1'],
      quotes: [{ quote: 'Hypnotic', source: 'Rádio Quântica' }],
      contact: 'mailto:booking@nightshift.test',
      updatedAt: '2026-10-12T09:00:00.000Z',
    });
  });

  it('reads stored quotes defensively', () => {
    expect(readStoredQuotes(null)).toEqual([]);
    expect(
      readStoredQuotes([
        { quote: 'Yes', source: 'A' },
        { quote: 3, source: 'B' },
        'loose',
        { quote: 'Two', source: 'C' },
        { quote: 'Three', source: 'D' },
        { quote: 'Four', source: 'E' },
      ]),
    ).toEqual([
      { quote: 'Yes', source: 'A' },
      { quote: 'Two', source: 'C' },
      { quote: 'Three', source: 'D' },
    ]);
  });
});

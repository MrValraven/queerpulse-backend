import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { StudioPressKit } from './entities/studio-press-kit.entity';
import {
  StudioArtistRef,
  StudioReleaseCard,
  StudioTrackSummary,
  toStudioArtistRef,
} from './studio-response';
import {
  StudioSupportLink,
  SupportLinkSource,
  toStudioSupportLinks,
} from './studio-support-links';
import { STUDIO_PRESS } from './studio.constants';

// Studio v3 press kit wire shapes (contract `StudioPressKit`).

export interface StudioPressQuote {
  quote: string;
  source: string;
}

export type StudioPressFeaturedTrack = StudioTrackSummary & {
  release: StudioReleaseCard;
};

export interface StudioPressKitOwnerFields {
  pitch: string | null;
  pressBio: string | null;
  featuredTrackIds: string[];
  quotes: StudioPressQuote[];
  contact: string | null;
  updatedAt: string | null;
}

export interface StudioPressKitResponse {
  artist: StudioArtistRef & { bio: string | null; city: string | null };
  personaHandle: string;
  pitch: string | null;
  bio: string | null;
  featuredTracks: StudioPressFeaturedTrack[];
  isFeaturedFallback: boolean;
  releases: StudioReleaseCard[];
  quotes: StudioPressQuote[];
  contact: string | null;
  socialLinks: { platform: string; urlOrHandle: string }[];
  supportLinks: StudioSupportLink[];
  isOwner: boolean;
  owner: StudioPressKitOwnerFields | null;
}

/** The persona columns a press kit reads; no owner id. */
export type StudioPressPersona = Pick<
  Subprofile,
  'id' | 'handle' | 'displayName' | 'kind' | 'avatarUrl' | 'bio'
>;

export interface StudioPressKitParts {
  persona: StudioPressPersona;
  pressKit: StudioPressKit | null;
  featuredTracks: StudioPressFeaturedTrack[];
  isFeaturedFallback: boolean;
  releases: StudioReleaseCard[];
  socialLinks: SupportLinkSource[];
  isOwner: boolean;
}

/** `studio_press_kits.quotes` as stored: kept only when well formed, at
 *  most three. */
export function readStoredQuotes(value: unknown): StudioPressQuote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((entry: unknown) => {
      if (entry && typeof entry === 'object') {
        const { quote, source } = entry as Record<string, unknown>;
        if (typeof quote === 'string' && typeof source === 'string') {
          return [{ quote, source }];
        }
      }
      return [];
    })
    .slice(0, STUDIO_PRESS.quotesMax);
}

/**
 * A press kit for one viewer. With no stored row it is built from the
 * persona alone; the press bio replaces the persona bio when set. The owner
 * view adds the raw stored fields for the editor. `city` is null: personas
 * have no city field.
 */
export function toStudioPressKitResponse(
  parts: StudioPressKitParts,
): StudioPressKitResponse {
  const { persona, pressKit } = parts;
  const quotes = readStoredQuotes(pressKit?.quotes);
  const pitch = pressKit?.pitch ?? null;
  const contact = pressKit?.contact ?? null;
  const orderedLinks = [...parts.socialLinks].sort(
    (leftLink, rightLink) => leftLink.position - rightLink.position,
  );
  return {
    artist: { ...toStudioArtistRef(persona), bio: persona.bio, city: null },
    personaHandle: persona.handle ?? '',
    pitch,
    bio: pressKit?.pressBio ?? persona.bio,
    featuredTracks: parts.featuredTracks,
    isFeaturedFallback: parts.isFeaturedFallback,
    releases: parts.releases,
    quotes,
    contact,
    socialLinks: orderedLinks.map(({ platform, urlOrHandle }) => ({
      platform,
      urlOrHandle,
    })),
    supportLinks: toStudioSupportLinks(parts.socialLinks),
    isOwner: parts.isOwner,
    owner: parts.isOwner
      ? {
          pitch,
          pressBio: pressKit?.pressBio ?? null,
          featuredTrackIds: pressKit?.featuredTrackIds ?? [],
          quotes,
          contact,
          updatedAt: pressKit ? pressKit.updatedAt.toISOString() : null,
        }
      : null,
  };
}

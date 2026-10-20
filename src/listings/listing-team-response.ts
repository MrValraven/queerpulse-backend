import type { FindOptionsSelect } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { cropFor } from '../media-crops/crop-response';
import type { CropRect } from '../media-crops/crop-rect';
import type {
  Subprofile,
  SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import {
  ListingTeamInitiator,
  ListingTeamMemberStatus,
  type ListingTeamMember,
} from './entities/listing-team-member.entity';
import type { Listing } from './entities/listing.entity';
import {
  initialsForName,
  tintForSlug,
  toCoverPhoto,
  type DirectoryTint,
  type ListingGalleryPhotoView,
} from './listing-response';

/** Declined, cancelled, removed and left never reach the wire. */
export type ListingTeamStatus = 'pending' | 'accepted';
export type ListingTeamInitiatedBy = 'listing' | 'persona';

/** A persona as this feature shows it. The avatar travels like the public persona view. */
export interface ListingTeamPersona {
  id: string;
  handle: string;
  displayName: string;
  kind: SubprofileKind;
  avatarUrl: string | null;
  /** Key omitted when the owner never reframed the avatar. */
  avatarCrop?: CropRect;
}

/** A listing as this feature shows it. Image fields reuse the directory card's. */
export interface ListingTeamListing {
  id: string;
  slug: string;
  name: string;
  cat: string;
  coverPhoto: ListingGalleryPhotoView | null;
  tint: DirectoryTint;
  av: string;
}

/** The business side's view of one row. */
export interface ListingTeamManagerRow {
  id: string;
  status: ListingTeamStatus;
  initiatedBy: ListingTeamInitiatedBy;
  roleLabel: string | null;
  /** Accepted rows only; null while pending. */
  position: number | null;
  persona: ListingTeamPersona | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface ListingTeamManagerList {
  awaitingYouCount: number;
  requestsReceived: ListingTeamManagerRow[];
  invitesSent: ListingTeamManagerRow[];
  accepted: ListingTeamManagerRow[];
}

/** The persona side's view of one row. */
export interface ListingTeamPersonaRow {
  id: string;
  status: ListingTeamStatus;
  initiatedBy: ListingTeamInitiatedBy;
  roleLabel: string | null;
  listing: ListingTeamListing;
  isListingLive: boolean;
  createdAt: string;
  answeredAt: string | null;
}

export interface ListingTeamPersonaList {
  awaitingYouCount: number;
  invitesReceived: ListingTeamPersonaRow[];
  requestsSent: ListingTeamPersonaRow[];
  accepted: ListingTeamPersonaRow[];
}

export interface ListingTeamPersonaCandidate {
  persona: ListingTeamPersona;
  teamStatus: ListingTeamStatus | null;
}

export interface ListingTeamListingCandidate {
  listing: ListingTeamListing;
  teamStatus: ListingTeamStatus | null;
}

/** Public read of one accepted member. */
export interface ListingTeamMemberPublic {
  persona: ListingTeamPersona;
  roleLabel: string | null;
}

/** Public read of one listing a persona works at. */
export interface ListingWorksAt {
  slug: string;
  name: string;
  cat: string;
  coverPhoto: ListingGalleryPhotoView | null;
  tint: DirectoryTint;
  av: string;
  roleLabel: string | null;
}

/** The persona columns a caller must select to build a `ListingTeamPersona`. */
export type ListingTeamPersonaColumns = Pick<
  Subprofile,
  'id' | 'handle' | 'displayName' | 'kind' | 'avatarUrl'
>;

/** Null when the persona has no handle: such a persona is ineligible. */
export function toListingTeamPersona(
  persona: ListingTeamPersonaColumns,
  crops: Map<string, CropRect>,
): ListingTeamPersona | null {
  if (!persona.handle) return null;
  const shaped: ListingTeamPersona = {
    id: persona.id,
    handle: persona.handle,
    displayName: persona.displayName,
    kind: persona.kind,
    avatarUrl: toImageUrl(persona.avatarUrl),
  };
  const avatarCrop = cropFor(persona.avatarUrl, crops);
  if (avatarCrop !== undefined) shaped.avatarCrop = avatarCrop;
  return shaped;
}

/** The only listing columns `toListingTeamListing` reads. */
export const LISTING_TEAM_LISTING_COLUMNS: FindOptionsSelect<Listing> = {
  id: true,
  slug: true,
  name: true,
  cats: true,
  coverPhoto: true,
  photoGallery: true,
};

export function toListingTeamListing(
  listing: Listing,
  crops: Map<string, CropRect>,
): ListingTeamListing {
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    cat: listing.cats[0] ?? '',
    coverPhoto: toCoverPhoto(listing, crops),
    tint: tintForSlug(listing.slug),
    av: initialsForName(listing.name),
  };
}

/** Pending and accepted pass through; every ended status is null. */
export function teamStatusOf(
  status: ListingTeamMemberStatus | null,
): ListingTeamStatus | null {
  if (status === ListingTeamMemberStatus.Pending) return 'pending';
  if (status === ListingTeamMemberStatus.Accepted) return 'accepted';
  return null;
}

function liveStatusOf(member: ListingTeamMember): ListingTeamStatus {
  return member.status === ListingTeamMemberStatus.Accepted
    ? 'accepted'
    : 'pending';
}

function initiatedByOf(
  initiatedBy: ListingTeamInitiator,
): ListingTeamInitiatedBy {
  return initiatedBy === ListingTeamInitiator.Persona ? 'persona' : 'listing';
}

export function toListingTeamManagerRow(
  member: ListingTeamMember,
  persona: ListingTeamPersona | null,
): ListingTeamManagerRow {
  const status = liveStatusOf(member);
  return {
    id: member.id,
    status,
    initiatedBy: initiatedByOf(member.initiatedBy),
    roleLabel: member.roleLabel,
    position: status === 'accepted' ? member.position : null,
    persona,
    createdAt: member.createdAt.toISOString(),
    answeredAt: member.answeredAt ? member.answeredAt.toISOString() : null,
  };
}

export function toListingTeamPersonaRow(
  member: ListingTeamMember,
  listing: ListingTeamListing,
  isListingLive: boolean,
): ListingTeamPersonaRow {
  return {
    id: member.id,
    status: liveStatusOf(member),
    initiatedBy: initiatedByOf(member.initiatedBy),
    roleLabel: member.roleLabel,
    listing,
    isListingLive,
    createdAt: member.createdAt.toISOString(),
    answeredAt: member.answeredAt ? member.answeredAt.toISOString() : null,
  };
}

export function toListingWorksAt(
  listing: ListingTeamListing,
  roleLabel: string | null,
): ListingWorksAt {
  return {
    slug: listing.slug,
    name: listing.name,
    cat: listing.cat,
    coverPhoto: listing.coverPhoto,
    tint: listing.tint,
    av: listing.av,
    roleLabel,
  };
}

/** Storage keys a caller loads crops for, one `MediaCropService.getMany` per read. */
export function personaAvatarKeys(
  personas: ListingTeamPersonaColumns[],
): string[] {
  const keys: string[] = [];
  for (const persona of personas) {
    if (persona.avatarUrl) keys.push(persona.avatarUrl);
  }
  return keys;
}

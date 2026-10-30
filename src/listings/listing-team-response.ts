import type { FindOptionsSelect } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { cropFor } from '../media-crops/crop-response';
import type { CropRect } from '../media-crops/crop-rect';
import {
  SubprofileLinkVisibility,
  type Subprofile,
  type SubprofileKind,
} from '../subprofiles/entities/subprofile.entity';
import {
  ListingTeamInitiator,
  ListingTeamMemberStatus,
  type ListingTeamMember,
} from './entities/listing-team-member.entity';
import type { Profile } from '../users/entities/profile.entity';
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
  /** The owner member's display name for a LINKED persona, else null. Lets the
   *  FE title a persona still named after its craft as "Owner Name | Poet"
   *  (`personaTitleName`). Never set for an unlinked persona. */
  ownerName: string | null;
}

/**
 * A member as this feature shows them. Carries no user id and no pronouns,
 * and the avatar goes through the member's "Show your photo" gate, so a member
 * who hid their face has `avatarUrl: null`.
 */
export interface ListingTeamMemberProfile {
  /** `profiles.slug`. */
  slug: string;
  /** "First Last", trimmed. */
  name: string;
  avatarUrl: string | null;
  /** Key omitted when the member never reframed the avatar, or the photo is hidden. */
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

/** Every field of a manager row except its subject. */
export interface ListingTeamManagerRowBase {
  id: string;
  status: ListingTeamStatus;
  initiatedBy: ListingTeamInitiatedBy;
  roleLabel: string | null;
  /** Accepted rows only; null while pending. */
  position: number | null;
  createdAt: string;
  answeredAt: string | null;
}

/**
 * The business side's view of one row. A row has exactly one subject: a
 * persona row never carries `member` and a member row never carries `persona`.
 * `member: null` means the member is ineligible, blocked either way with the
 * caller, or deactivated; the row stays so the manager can cancel or remove it.
 */
export type ListingTeamManagerRow = ListingTeamManagerRowBase &
  (
    | {
        kind: 'persona';
        persona: ListingTeamPersona | null;
        member?: never;
      }
    | {
        kind: 'member';
        member: ListingTeamMemberProfile | null;
        persona?: never;
      }
  );

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

/** The member side's view of one row. Same shape as the persona side's. */
export type ListingTeamMemberLinkRow = ListingTeamPersonaRow;

export interface ListingTeamMemberLinkList {
  awaitingYouCount: number;
  /** Newest first, at most `LISTING_TEAM_SEARCH.invitesReceivedMax`. */
  invitesReceived: ListingTeamMemberLinkRow[];
  /** `answeredAt` ASC, then id ASC. */
  accepted: ListingTeamMemberLinkRow[];
}

/** Public read of one accepted team entry, persona or member. */
export type ListingTeamMemberPublic =
  | {
      kind: 'persona';
      persona: ListingTeamPersona;
      roleLabel: string | null;
    }
  | {
      kind: 'member';
      member: ListingTeamMemberProfile;
      roleLabel: string | null;
    };

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
  'id' | 'handle' | 'displayName' | 'kind' | 'avatarUrl' | 'linkVisibility'
>;

/**
 * The owner's display name from their profile row, composed exactly like
 * `SubprofileOwnerRef.name` and the persona directory's `ownerNameByUserId`.
 * Both parts blank (or no profile row) give null, so the persona keeps its
 * bare name and the FE never builds a title like " | Poet".
 */
export function ownerNameOf(
  firstName: string | null,
  lastName: string | null,
): string | null {
  return `${firstName ?? ''} ${lastName ?? ''}`.trim() || null;
}

/**
 * Null when the persona has no handle: such a persona is ineligible.
 * `ownerName` reaches the wire only for a linked persona, mirroring
 * `toCardDTO`: an unlinked persona gets null even when a caller passed a name.
 */
export function toListingTeamPersona(
  persona: ListingTeamPersonaColumns,
  crops: Map<string, CropRect>,
  ownerName: string | null,
): ListingTeamPersona | null {
  if (!persona.handle) return null;
  const shaped: ListingTeamPersona = {
    id: persona.id,
    handle: persona.handle,
    displayName: persona.displayName,
    kind: persona.kind,
    avatarUrl: toImageUrl(persona.avatarUrl),
    ownerName:
      persona.linkVisibility === SubprofileLinkVisibility.Linked
        ? ownerName
        : null,
  };
  const avatarCrop = cropFor(persona.avatarUrl, crops);
  if (avatarCrop !== undefined) shaped.avatarCrop = avatarCrop;
  return shaped;
}

/** The profile columns a caller must select to build a `ListingTeamMemberProfile`. */
export type ListingTeamMemberColumns = Pick<
  Profile,
  'slug' | 'firstName' | 'lastName' | 'avatarUrl' | 'photoVisible'
>;

/**
 * The avatar goes through `toVisibleAvatarUrl`, so a member who turned
 * "Show your photo" off has no avatar and no crop on the wire.
 */
export function toListingTeamMemberProfile(
  profile: ListingTeamMemberColumns,
  crops: Map<string, CropRect>,
): ListingTeamMemberProfile {
  const avatarUrl = toVisibleAvatarUrl(profile);
  const shaped: ListingTeamMemberProfile = {
    slug: profile.slug,
    name: ownerNameOf(profile.firstName, profile.lastName) ?? '',
    avatarUrl,
  };
  if (avatarUrl !== null) {
    const avatarCrop = cropFor(profile.avatarUrl, crops);
    if (avatarCrop !== undefined) shaped.avatarCrop = avatarCrop;
  }
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

function managerRowBaseOf(
  member: ListingTeamMember,
): ListingTeamManagerRowBase {
  const status = liveStatusOf(member);
  return {
    id: member.id,
    status,
    initiatedBy: initiatedByOf(member.initiatedBy),
    roleLabel: member.roleLabel,
    position: status === 'accepted' ? member.position : null,
    createdAt: member.createdAt.toISOString(),
    answeredAt: member.answeredAt ? member.answeredAt.toISOString() : null,
  };
}

/** A persona row for the business side. */
export function toListingTeamManagerRow(
  member: ListingTeamMember,
  persona: ListingTeamPersona | null,
): ListingTeamManagerRow {
  return { ...managerRowBaseOf(member), kind: 'persona', persona };
}

/** A member row for the business side. `memberProfile` null when the member is
 *  ineligible, blocked either way with the caller, or deactivated. */
export function toListingTeamMemberManagerRow(
  member: ListingTeamMember,
  memberProfile: ListingTeamMemberProfile | null,
): ListingTeamManagerRow {
  return { ...managerRowBaseOf(member), kind: 'member', member: memberProfile };
}

/** One persona entry of the public team. */
export function toListingTeamPersonaPublic(
  persona: ListingTeamPersona,
  roleLabel: string | null,
): ListingTeamMemberPublic {
  return { kind: 'persona', persona, roleLabel };
}

/** One member entry of the public team. */
export function toListingTeamMemberPublic(
  memberProfile: ListingTeamMemberProfile,
  roleLabel: string | null,
): ListingTeamMemberPublic {
  return { kind: 'member', member: memberProfile, roleLabel };
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

/** Storage keys a caller loads crops for. A member who hid their photo
 *  contributes none, since the avatar never reaches the wire. */
export function memberAvatarKeys(
  profiles: Pick<ListingTeamMemberColumns, 'avatarUrl' | 'photoVisible'>[],
): string[] {
  const keys: string[] = [];
  for (const profile of profiles) {
    if (profile.avatarUrl && profile.photoVisible) keys.push(profile.avatarUrl);
  }
  return keys;
}

import { MemberRef } from '../common/member-ref';
import { toImageUrl } from '../common/image-url';
import {
  StudioPlaylistPerson,
  toStudioPlaylistPerson,
} from './studio-playlist-response';
import { StudioArtistRef } from './studio-response';
import { StudioSupportLink } from './studio-support-links';
import { StudioCount } from './studio-stats';

/**
 * Supporter identities. One mapper, `toStudioSupporterIdentity`, builds every
 * identity on the wire (the listener's supporting list, the identity picker and
 * the owner's top supporters), so the picker preview is what the artist sees.
 * The account goes through `toStudioPlaylistPerson`, which honours the photo
 * setting and carries no user id.
 */

/** The owner's ranking shows this many supporters. */
export const STUDIO_TOP_SUPPORTERS_SHOWN = 10;

/** Supporters are ranked by listens inside this window. */
export const STUDIO_SUPPORTER_WINDOW_INTERVAL = '28 days';

export interface StudioSupporterPersona {
  id: string;
  /** Empty when the persona has no handle, which the frontend reads as unlinked. */
  handle: string;
  name: string;
  kind: string;
  avatarUrl: string | null;
  isLinkable: boolean;
}

export type StudioSupporterIdentity =
  | { kind: 'account'; member: StudioPlaylistPerson }
  | { kind: 'persona'; persona: StudioSupporterPersona };

export interface StudioSupporterOption {
  shownAsSubprofileId: string | null;
  identity: StudioSupporterIdentity;
}

export interface StudioSupporterState {
  isSupporting: boolean;
  shownAsSubprofileId: string | null;
  shownAs: StudioSupporterIdentity | null;
  since: string | null;
  options: StudioSupporterOption[];
}

export interface StudioSupportingItem {
  artist: StudioArtistRef;
  since: string;
  shownAs: StudioSupporterIdentity;
  supportLinks: StudioSupportLink[];
  isFollowing: boolean;
}

export interface StudioSupportingResponse {
  items: StudioSupportingItem[];
}

export interface StudioTopSupporters {
  items: { identity: StudioSupporterIdentity }[];
  optedInCount: StudioCount;
}

/** The persona columns a supporter query selects. */
export interface SupporterPersonaRow {
  id: string;
  handle: string | null;
  display_name: string;
  kind: string;
  avatar_url: string | null;
  is_linkable: boolean;
}

export function toStudioSupporterPersona(
  row: SupporterPersonaRow,
): StudioSupporterPersona {
  return {
    id: row.id,
    handle: row.handle ?? '',
    name: row.display_name,
    kind: row.kind,
    avatarUrl: toImageUrl(row.avatar_url),
    isLinkable: row.is_linkable,
  };
}

/** `null` shownAsSubprofileId shows the account. A chosen persona missing from
 *  the map yields `null`, so the caller leaves the row out. */
export function toStudioSupporterIdentity(
  shownAsSubprofileId: string | null,
  member: MemberRef | undefined,
  personasById: ReadonlyMap<string, SupporterPersonaRow>,
): StudioSupporterIdentity | null {
  if (shownAsSubprofileId === null) {
    return { kind: 'account', member: toStudioPlaylistPerson(member) };
  }
  const personaRow = personasById.get(shownAsSubprofileId);
  if (!personaRow) return null;
  return { kind: 'persona', persona: toStudioSupporterPersona(personaRow) };
}

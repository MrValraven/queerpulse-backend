import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { toImageUrl } from '../common/image-url';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import type { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { UserRole } from '../users/entities/user.entity';
import type { LeadEntry } from './entities/lead-entry.entity';
import type { Lead } from './entities/lead.entity';
import { isLeadFollowUpDue } from './lead-input';
import {
  LEAD_LIST_LINKS_SHOWN,
  type LeadEntryKind,
  type LeadPersonaPublicState,
  type LeadStage,
  type LeadType,
} from './leads.constants';

/** Persona-only projection. Selects id, handle, display_name, kind,
 *  avatar_url (plus status, visibility, removed_at for the state). No owner
 *  field is selected, so none can reach a response. */
export interface LeadPersonaDTO {
  id: string;
  handle: string | null;
  displayName: string;
  kind: string;
  /** `toImageUrl(avatarUrl)`, else `null`. */
  avatarUrl: string | null;
  /** The stored crop for that avatar key. */
  avatarCrop: CropRect | null;
}

/** The persona a lead is linked to, with whether it is publicly listed. */
export interface LeadLinkedPersonaDTO extends LeadPersonaDTO {
  publicState: LeadPersonaPublicState;
}

/** One row of the leads list. */
export interface LeadListItemDTO {
  id: string;
  name: string;
  type: LeadType;
  stage: LeadStage;
  location: string | null;
  /** The first 3 links, in stored order. */
  links: string[];
  /** Every stored link. */
  linkCount: number;
  followUpOn: string | null;
  /** Open stage and `followUpOn` on or before the Lisbon day. */
  isFollowUpDue: boolean;
  linkedPersona: LeadLinkedPersonaDTO | null;
  /** Entries of kind `note`. */
  noteCount: number;
  /** The newest entry's `created_at` (the `created` entry always exists). */
  lastEntryAt: string;
  updatedAt: string;
}

/** One page of the leads list. */
export interface LeadListPageDTO {
  /** 0 to 50 rows. */
  items: LeadListItemDTO[];
  /** `null` on the last page. */
  nextCursor: string | null;
  /** Every stage present, 0 when none. */
  stageCounts: Record<LeadStage, number>;
  /** The sum of `stageCounts`. */
  totalCount: number;
}

/** The staff member who wrote an entry. */
export interface LeadEntryAuthorDTO {
  /** The user id. */
  id: string;
  /** `${firstName} ${lastName}`, trimmed, from the profile. */
  displayName: string;
  avatarUrl: string | null;
  avatarCrop: CropRect | null;
}

/** One entry of a lead's history. */
export interface LeadEntryDTO {
  id: string;
  kind: LeadEntryKind;
  /** Set on `note` only. */
  body: string | null;
  /** Set on `stage_changed` only. */
  fromStage: LeadStage | null;
  /** Set on `stage_changed`, and on `created` (the starting stage). */
  toStage: LeadStage | null;
  /** The persona of a `persona_linked` or `persona_unlinked` entry while its
   *  reference is set; `null` reads "a persona that is no longer
   *  available". */
  persona: LeadPersonaDTO | null;
  /** `null` when the account is gone. */
  author: LeadEntryAuthorDTO | null;
  createdAt: string;
  editedAt: string | null;
  /** Kind `note`, and the caller wrote it or the caller is an Admin. */
  canEdit: boolean;
}

/** A whole lead with its history, newest entry first. */
export interface LeadDTO {
  id: string;
  name: string;
  type: LeadType;
  stage: LeadStage;
  location: string | null;
  email: string | null;
  phone: string | null;
  /** Every stored link. */
  links: string[];
  followUpOn: string | null;
  isFollowUpDue: boolean;
  linkedPersona: LeadLinkedPersonaDTO | null;
  createdAt: string;
  updatedAt: string;
  /** Every entry, `created_at DESC, id DESC`. */
  entries: LeadEntryDTO[];
}

/** One row of the persona picker search. */
export interface LeadPersonaSearchResultDTO {
  persona: LeadPersonaDTO;
  /** The lead this persona is linked to, if any. */
  linkedLead: { id: string; name: string } | null;
}

/** The only persona columns the leads routes read: the five the projection
 *  shows plus the three its public state needs. No owner column is in the
 *  list, so none can reach a response. */
export const LEAD_PERSONA_FIELDS = [
  'id',
  'handle',
  'displayName',
  'kind',
  'avatarUrl',
  'status',
  'visibility',
  'removedAt',
] as const;

/** A persona row holding exactly the columns above. */
export type LeadPersonaRow = Pick<
  Subprofile,
  (typeof LEAD_PERSONA_FIELDS)[number]
>;

/** The persona columns the projection reads. */
export type LeadPersonaSummaryRow = Pick<
  Subprofile,
  'id' | 'handle' | 'displayName' | 'kind' | 'avatarUrl'
>;

/** A persona row with its public state, as `loadPersonaRecords` answers it. */
export interface LeadPersonaRecord {
  row: LeadPersonaSummaryRow;
  publicState: LeadPersonaPublicState;
}

/** The caller fields the leads routes read: who they are and their tier. */
export type LeadCaller = Pick<CurrentUserData, 'userId' | 'role'>;

/** The profile columns an entry author's name and avatar come from. */
export interface LeadAuthorProfileRow {
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

/** An image URL and the crop stored for its key. The crop is read only when
 *  the key resolves to a URL, so a dropped value carries no crop. */
function avatarOf(
  storedAvatar: string | null | undefined,
  crops: Map<string, CropRect>,
): { avatarUrl: string | null; avatarCrop: CropRect | null } {
  const avatarUrl = toImageUrl(storedAvatar);
  return {
    avatarUrl,
    avatarCrop: avatarUrl ? (cropFor(storedAvatar, crops) ?? null) : null,
  };
}

/** Maps a persona row to the persona-only projection. The object is built
 *  field by field and the row is never spread, so an owner column the row
 *  happens to hold stays out. */
export function toLeadPersona(
  row: LeadPersonaSummaryRow,
  crops: Map<string, CropRect>,
): LeadPersonaDTO {
  const avatar = avatarOf(row.avatarUrl, crops);
  return {
    id: row.id,
    handle: row.handle ?? null,
    displayName: row.displayName,
    kind: row.kind,
    avatarUrl: avatar.avatarUrl,
    avatarCrop: avatar.avatarCrop,
  };
}

/** Maps a linked persona record to the projection plus its public state. */
export function toLeadLinkedPersona(
  record: LeadPersonaRecord,
  crops: Map<string, CropRect>,
): LeadLinkedPersonaDTO {
  const persona = toLeadPersona(record.row, crops);
  return {
    id: persona.id,
    handle: persona.handle,
    displayName: persona.displayName,
    kind: persona.kind,
    avatarUrl: persona.avatarUrl,
    avatarCrop: persona.avatarCrop,
    publicState: record.publicState,
  };
}

/** Maps an entry author. A missing profile gives an empty name and no
 *  avatar. */
export function toLeadEntryAuthor(
  authorId: string,
  profile: LeadAuthorProfileRow | null,
  crops: Map<string, CropRect>,
): LeadEntryAuthorDTO {
  const avatar = avatarOf(profile?.avatarUrl, crops);
  const displayName = profile
    ? `${profile.firstName} ${profile.lastName}`.trim()
    : '';
  return {
    id: authorId,
    displayName,
    avatarUrl: avatar.avatarUrl,
    avatarCrop: avatar.avatarCrop,
  };
}

/** Whether the caller may edit or delete an entry: only notes change, and
 *  only their author or an Admin changes them. A note whose author account is
 *  gone is editable by an Admin only. */
export function canEditLeadEntry(
  entry: Pick<LeadEntry, 'kind' | 'authorId'>,
  caller: LeadCaller,
): boolean {
  if (entry.kind !== 'note') return false;
  // `CurrentUserData.role` is typed as text; it holds a `UserRole` value.
  if ((caller.role as UserRole) === UserRole.Admin) return true;
  return entry.authorId !== null && entry.authorId === caller.userId;
}

/** Maps one entry. The caller resolves the author, the persona and the edit
 *  right in batches and passes them in. */
export function toLeadEntry(
  entry: LeadEntry,
  author: LeadEntryAuthorDTO | null,
  persona: LeadPersonaDTO | null,
  canEdit: boolean,
): LeadEntryDTO {
  return {
    id: entry.id,
    kind: entry.kind,
    body: entry.body,
    fromStage: entry.fromStage,
    toStage: entry.toStage,
    persona,
    author,
    createdAt: entry.createdAt.toISOString(),
    editedAt: entry.editedAt ? entry.editedAt.toISOString() : null,
    canEdit,
  };
}

/** Maps a lead to its list row. `today` is the Lisbon day the page reads. */
export function toLeadListItem(
  lead: Lead,
  stats: { noteCount: number; lastEntryAt: Date },
  linkedPersona: LeadLinkedPersonaDTO | null,
  today: string,
): LeadListItemDTO {
  return {
    id: lead.id,
    name: lead.name,
    type: lead.type,
    stage: lead.stage,
    location: lead.location,
    links: lead.links.slice(0, LEAD_LIST_LINKS_SHOWN),
    linkCount: lead.links.length,
    followUpOn: lead.followUpOn,
    isFollowUpDue: isLeadFollowUpDue(lead.stage, lead.followUpOn, today),
    linkedPersona,
    noteCount: stats.noteCount,
    lastEntryAt: stats.lastEntryAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

/** Maps a whole lead. `entries` are already mapped and ordered newest
 *  first; `today` is the Lisbon day of the read. */
export function toLead(
  lead: Lead,
  linkedPersona: LeadLinkedPersonaDTO | null,
  entries: LeadEntryDTO[],
  today: string,
): LeadDTO {
  return {
    id: lead.id,
    name: lead.name,
    type: lead.type,
    stage: lead.stage,
    location: lead.location,
    email: lead.email,
    phone: lead.phone,
    links: lead.links.slice(),
    followUpOn: lead.followUpOn,
    isFollowUpDue: isLeadFollowUpDue(lead.stage, lead.followUpOn, today),
    linkedPersona,
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
    entries,
  };
}

import { toImageUrl } from '../common/image-url';
import { PersonaColumns, personaColumnsFromRow } from './studio-discovery-sql';
import {
  STUDIO_CREDIT_ROLES,
  StudioCreditRole,
  StudioPersonaCreditStatus,
  isStudioArtistPersonaKind,
  isStudioCreditRole,
} from './studio.constants';

// Wire shapes of the Studio discovery contract for persona credits. Every
// shape names personas only: no member id, name or slug ever describes who
// runs a persona or who acted on a credit.

/** Any persona kind. */
export interface StudioPersonaRef {
  id: string;
  handle: string;
  name: string;
  /** Any subprofile kind value. */
  kind: string;
  avatarUrl: string | null;
  /** A persona of a Studio artist kind that passes the listenable rule; the frontend
   *  links it to its Studio artist page and every other persona to
   *  `/p/<handle>`. */
  isListenable: boolean;
}

/** Ordered by `STUDIO_CREDIT_ROLES`, then `created_at`. */
export interface StudioPersonaCreditPublic {
  persona: StudioPersonaRef;
  role: StudioCreditRole;
}

/** One row per persona, ordered by the first track that credits it. */
export interface StudioReleaseCreditSummary {
  persona: StudioPersonaRef;
  /** Distinct, in `STUDIO_CREDIT_ROLES` order. */
  roles: StudioCreditRole[];
}

/** The track editor's view of its own persona credits. */
export interface StudioPersonaCreditOwnerRow {
  id: string;
  persona: StudioPersonaRef;
  role: StudioCreditRole;
  status: StudioPersonaCreditStatus;
  /** False once the persona stops being public; the row stays removable. */
  isPersonaPublic: boolean;
  createdAt: string;
}

/** The preview card for an exact handle. */
export type StudioCreditCandidate = StudioPersonaRef;

export interface StudioCreditInboxRow {
  id: string;
  role: StudioCreditRole;
  status: 'pending' | 'accepted';
  /** The release's persona. */
  requestingPersona: StudioPersonaRef;
  /** The viewer's own persona. */
  creditedPersona: StudioPersonaRef;
  track: { id: string; title: string };
  release: { id: string; title: string; coverUrl: string | null };
  createdAt: string;
  respondedAt: string | null;
}

export interface StudioCreditInbox {
  /** Pending, newest first, at most 100. */
  requests: StudioCreditInboxRow[];
  /** Accepted, newest answer first, at most 100. */
  accepted: StudioCreditInboxRow[];
}

export interface StudioCreditPendingCount {
  count: number;
}

export function toStudioPersonaRef(
  columns: PersonaColumns,
  isPublic: boolean,
): StudioPersonaRef {
  return {
    id: columns.id,
    handle: columns.handle ?? '',
    name: columns.displayName,
    kind: columns.kind,
    avatarUrl: toImageUrl(columns.avatarUrl),
    isListenable: isPublic && isStudioArtistPersonaKind(columns.kind),
  };
}

export function creditRoleRank(role: StudioCreditRole): number {
  return STUDIO_CREDIT_ROLES.indexOf(role);
}

/** Distinct roles in vocabulary order; a stored role outside it is dropped. */
export function orderedCreditRoles(
  roles: readonly string[],
): StudioCreditRole[] {
  const presentRoles = new Set(roles);
  return STUDIO_CREDIT_ROLES.filter((role) => presentRoles.has(role));
}

/** A row of `OWNER_CREDIT_ROWS_SQL`. `is_persona_linkable` adds the block
 *  filter to `is_persona_public` and drives only the chip link. */
export interface OwnerCreditRow extends Record<string, unknown> {
  id: string;
  role: string;
  status: StudioPersonaCreditStatus;
  created_at: Date;
  is_persona_public: boolean;
  is_persona_linkable: boolean;
}

/** One owner row, or none for a role outside the vocabulary. */
export function toStudioPersonaCreditOwnerRow(
  row: OwnerCreditRow,
): StudioPersonaCreditOwnerRow[] {
  if (!isStudioCreditRole(row.role)) {
    return [];
  }
  return [
    {
      id: row.id,
      persona: toStudioPersonaRef(
        personaColumnsFromRow(row, 'persona'),
        row.is_persona_linkable,
      ),
      role: row.role,
      status: row.status,
      isPersonaPublic: row.is_persona_public,
      createdAt: row.created_at.toISOString(),
    },
  ];
}

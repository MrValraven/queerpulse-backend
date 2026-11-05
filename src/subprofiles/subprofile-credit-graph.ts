// Pure rules for the persona credit graph: who a persona has been credited
// with, as one viewer is allowed to see it. No DB access and no image-URL
// resolution here (both live in `SubprofileCreditGraphService` and
// `subprofile-credits-response.ts`), so every eligibility rule is unit-tested
// directly in `subprofile-credit-graph.spec.ts`.
//
// Vocabulary:
// - SUBJECT: the persona whose card is being built (X).
// - ROSTER R(P): persona P's creator plus every `subprofile_members` user.
//   Read only by the member-credit rule of a LINKED subject (see the
//   differential note above `isPersonaPairCredit`).
// - OUTBOUND credit: one of X's own items lists a handle h. h may name a
//   member (Profile handle) or another persona (Subprofile handle).
// - INBOUND credit: an item of another persona C lists X's handle. Only an
//   unlinked X with a handle can be credited this way, since a linked persona
//   is never creditable by handle.

import { normalizeHandle } from '../common/handles';
import {
  SubprofileKind,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';

/** How many faces a directory card shows beside its credit count. */
export const CARD_CREDIT_FACE_LIMIT = 3;

/**
 * A persona as the credit graph sees it. `avatarUrl` is the RAW stored column
 * value (a storage key or an external URL), resolved to a URL only by the
 * response mappers. `isUnderTakedown` and `isOwnerBlocked` are precomputed by
 * the service from one batched moderation lookup and one batched block lookup.
 */
export interface CreditPersonaIdentity {
  id: string;
  handle: string | null;
  displayName: string;
  avatarUrl: string | null;
  accent: string | null;
  kind: SubprofileKind;
  status: SubprofileStatus;
  visibility: SubprofileVisibility;
  linkVisibility: SubprofileLinkVisibility;
  removedAt: Date | null;
  userId: string;
  isUnderTakedown: boolean;
  isOwnerBlocked: boolean;
}

/**
 * A credited member. `avatarUrl` is the RAW stored value already passed
 * through the member's own `photoVisible` gate (null when the photo is
 * hidden), so the response mapper only has to resolve it.
 */
export interface CreditMemberIdentity {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isBlocked: boolean;
}

/** Everything `resolveCounterparts` loaded, keyed for the pure rules below. */
export interface CounterpartDirectory {
  personaById: ReadonlyMap<string, CreditPersonaIdentity>;
  /** Normalized persona handle to persona id. */
  personaIdByHandle: ReadonlyMap<string, string>;
  /** Normalized member handle to the member it names. */
  memberByHandle: ReadonlyMap<string, CreditMemberIdentity>;
  /** Persona id to its `subprofile_members` user ids (creator not included).
   *  Holds only the personas passed as `rosterPersonaIds`: only the member
   *  rule of a linked subject reads a roster. */
  rosterMembersById: ReadonlyMap<string, readonly string[]>;
}

/** The persona a card is built for. A `CreditPersonaIdentity` also fits. */
export interface CreditSubject {
  id: string;
  userId: string;
  handle: string | null;
  linkVisibility: SubprofileLinkVisibility;
}

/** One item that carries credits: whose it is, whom it credits, and when. */
export interface CreditItemRef {
  subprofileId: string;
  collaborators: readonly string[];
  createdAt: Date;
}

/** One distinct counterpart of a subject, with the newest item they share. */
export interface CreditCounterpart {
  /** `persona:<id>` or `member:<userId>`, the dedup identity. */
  identityKey: string;
  kind: 'persona' | 'member';
  name: string;
  /** RAW stored value, see `CreditPersonaIdentity.avatarUrl`. */
  avatarUrl: string | null;
  accent: string | null;
  latestSharedAt: Date;
}

export interface CardCreditsSummary {
  count: number;
  /** At most `CARD_CREDIT_FACE_LIMIT`, newest shared item first. */
  faces: CreditCounterpart[];
}

/** R(P): the creator plus every roster member of persona `personaId`. */
export function rosterOf(
  personaId: string,
  creatorUserId: string,
  rosterMembersById: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  return new Set([creatorUserId, ...(rosterMembersById.get(personaId) ?? [])]);
}

/**
 * The base gate every persona counterpart passes in both directions:
 * published, open, not removed, not under a moderator takedown, has a handle,
 * and its owner is not blocked either way with the viewer.
 */
export function isCreditablePersona(persona: CreditPersonaIdentity): boolean {
  return (
    persona.status === SubprofileStatus.Published &&
    persona.visibility === SubprofileVisibility.Open &&
    !persona.removedAt &&
    !persona.isUnderTakedown &&
    Boolean(persona.handle) &&
    !persona.isOwnerBlocked
  );
}

// Why no roster-overlap check on persona credits: a public persona page
// resolves its credits through `resolveHandles`, which never compares rosters.
// If a card dropped a credit the persona page still shows, a viewer comparing
// the two would learn that both personas share an owner, and that ties a
// pseudonymous persona to the people who run it. So any credit with an
// UNLINKED party (every creditable persona, and every inbound subject) counts
// exactly as the persona page shows it. Roster checks stay only on member
// credits of a LINKED subject, where no pseudonym is involved.

/**
 * Persona credit between two personas, in either direction: the credited
 * persona (outbound) or the crediting author (inbound) is `counterpart`. It
 * passes the base gate and is never the subject itself. No roster comparison,
 * see the note above. Also the "Made together" pair rule.
 */
export function isPersonaPairCredit(
  subject: Pick<CreditSubject, 'id'>,
  counterpart: CreditPersonaIdentity,
): boolean {
  return isCreditablePersona(counterpart) && counterpart.id !== subject.id;
}

/**
 * Outbound persona credit: X's item credits persona P. P must be UNLINKED (a
 * linked persona is never creditable by handle) and pass the pair rule.
 */
export function isOutboundPersonaCredit(
  subject: CreditSubject,
  persona: CreditPersonaIdentity,
): boolean {
  return (
    persona.linkVisibility === SubprofileLinkVisibility.Unlinked &&
    isPersonaPairCredit(subject, persona)
  );
}

/**
 * Outbound member credit: X's item credits member M. Counts only on a LINKED
 * X (an unlinked persona showing which members it works with would hint at
 * who runs it), when M is not on X's own roster and not blocked either way
 * with the viewer.
 */
export function isOutboundMemberCredit(
  subject: CreditSubject,
  subjectRoster: ReadonlySet<string>,
  member: CreditMemberIdentity,
): boolean {
  return (
    subject.linkVisibility === SubprofileLinkVisibility.Linked &&
    !subjectRoster.has(member.userId) &&
    !member.isBlocked
  );
}

/**
 * Inbound credit: persona C's item lists X's handle. Only an unlinked X with
 * a handle receives inbound credits, and C passes the pair rule. C itself may
 * be linked or unlinked.
 */
export function isInboundPersonaCredit(
  subject: CreditSubject,
  author: CreditPersonaIdentity,
): boolean {
  return (
    subject.linkVisibility === SubprofileLinkVisibility.Unlinked &&
    Boolean(subject.handle) &&
    isPersonaPairCredit(subject, author)
  );
}

/**
 * The first credit on one item that resolves to a persona under the outbound
 * rule relative to the item's author, or null. Member credits never qualify.
 * Used by the "Made together" read to pick an item's partner.
 *
 * The caller checks `isCreditablePersona(author)` itself: this only judges
 * the partner. The persona rules read no rosters, so `directory` needs only
 * the item's credit handles resolved (pass them as `handles` to
 * `resolveCounterparts`, and the author ids as `personaIds`).
 */
export function firstOutboundPersonaCredit(
  author: CreditSubject,
  collaborators: readonly string[],
  directory: CounterpartDirectory,
): CreditPersonaIdentity | null {
  for (const rawHandle of collaborators) {
    const personaId = directory.personaIdByHandle.get(
      normalizeHandle(rawHandle),
    );
    const persona = personaId ? directory.personaById.get(personaId) : null;
    if (persona && isOutboundPersonaCredit(author, persona)) {
      return persona;
    }
  }
  return null;
}

function personaCounterpart(
  persona: CreditPersonaIdentity,
  sharedAt: Date,
): CreditCounterpart {
  return {
    identityKey: `persona:${persona.id}`,
    kind: 'persona',
    name: persona.displayName,
    avatarUrl: persona.avatarUrl,
    accent: persona.accent,
    latestSharedAt: sharedAt,
  };
}

function memberCounterpart(
  member: CreditMemberIdentity,
  sharedAt: Date,
): CreditCounterpart {
  return {
    identityKey: `member:${member.userId}`,
    kind: 'member',
    name: member.name,
    avatarUrl: member.avatarUrl,
    accent: null,
    latestSharedAt: sharedAt,
  };
}

/** Adds a counterpart, keeping the newest shared item per identity. */
function keepNewest(
  counterpartsByKey: Map<string, CreditCounterpart>,
  counterpart: CreditCounterpart,
): void {
  const existing = counterpartsByKey.get(counterpart.identityKey);
  if (
    !existing ||
    existing.latestSharedAt.getTime() < counterpart.latestSharedAt.getTime()
  ) {
    counterpartsByKey.set(counterpart.identityKey, counterpart);
  }
}

/**
 * Every distinct eligible counterpart of `subject`, deduplicated by identity
 * across inbound and outbound credits. `items` may hold any mix of the
 * subject's own items (outbound) and other personas' items (inbound); an item
 * of another persona that does not list the subject's handle is ignored.
 */
export function collectCardCounterparts(
  subject: CreditSubject,
  items: readonly CreditItemRef[],
  directory: CounterpartDirectory,
): Map<string, CreditCounterpart> {
  const counterpartsByKey = new Map<string, CreditCounterpart>();
  const subjectRoster = rosterOf(
    subject.id,
    subject.userId,
    directory.rosterMembersById,
  );
  const subjectHandle = subject.handle ? normalizeHandle(subject.handle) : null;

  for (const item of items) {
    const creditedHandles = item.collaborators.map((handle) =>
      normalizeHandle(handle),
    );
    if (item.subprofileId === subject.id) {
      for (const handle of creditedHandles) {
        const member = directory.memberByHandle.get(handle);
        if (member) {
          if (isOutboundMemberCredit(subject, subjectRoster, member)) {
            keepNewest(
              counterpartsByKey,
              memberCounterpart(member, item.createdAt),
            );
          }
          continue;
        }
        const personaId = directory.personaIdByHandle.get(handle);
        const persona = personaId ? directory.personaById.get(personaId) : null;
        if (persona && isOutboundPersonaCredit(subject, persona)) {
          keepNewest(
            counterpartsByKey,
            personaCounterpart(persona, item.createdAt),
          );
        }
      }
      continue;
    }

    if (!subjectHandle || !creditedHandles.includes(subjectHandle)) continue;
    const author = directory.personaById.get(item.subprofileId);
    if (author && isInboundPersonaCredit(subject, author)) {
      keepNewest(counterpartsByKey, personaCounterpart(author, item.createdAt));
    }
  }
  return counterpartsByKey;
}

/**
 * Face order: newest shared item first, then name, then identity so the order
 * is total and stable across requests.
 */
export function orderCreditFaces(
  counterparts: Iterable<CreditCounterpart>,
): CreditCounterpart[] {
  return [...counterparts].sort(
    (first, second) =>
      second.latestSharedAt.getTime() - first.latestSharedAt.getTime() ||
      first.name.localeCompare(second.name) ||
      first.identityKey.localeCompare(second.identityKey),
  );
}

/** Count plus the first `CARD_CREDIT_FACE_LIMIT` faces for one card. */
export function summarizeCardCredits(
  subject: CreditSubject,
  items: readonly CreditItemRef[],
  directory: CounterpartDirectory,
): CardCreditsSummary {
  const counterparts = collectCardCounterparts(subject, items, directory);
  return {
    count: counterparts.size,
    faces: orderCreditFaces(counterparts.values()).slice(
      0,
      CARD_CREDIT_FACE_LIMIT,
    ),
  };
}

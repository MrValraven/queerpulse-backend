import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import type { IdentitiesService } from '../identities/identities.service';

/**
 * Business mailboxes, design section 9: the business, persona or company a
 * reported message was sent as, shown to Trust and Safety beside the human
 * sender whatever either attribution switch says. Those switches govern what
 * customers see; a moderator always reads both.
 *
 * `kind` and `displayName` read null when the identity row is gone (the
 * listing, persona or company was deleted). `messages.sender_identity_id`
 * keeps its value after that, so the moderator still learns the message went
 * out as an identity that no longer exists.
 */
export interface SentAsIdentityDTO {
  identityId: string;
  kind: Exclude<IdentityKind, IdentityKind.Profile> | null;
  displayName: string | null;
  handle: string | null;
}

/** One message's sender, as the moderator views read it. */
export interface SentAsCandidate {
  senderId: string | null;
  senderIdentityId: string | null;
}

/** The drawer's `people` role for the identity a message was sent as. */
export const SENT_AS_PERSON_ROLE = 'sent as';

/**
 * The identity each candidate was sent as, keyed by `senderIdentityId`, in at
 * most two batched reads whatever the number of candidates. A personal message
 * (a profile identity) gets no entry. An identity whose row is gone gets an
 * entry with null `kind` only while the message still names its human sender:
 * a profile identity outlives its account's messages only through erasure,
 * which also nulls `sender_id`, so a live sender with an unresolved identity
 * was sending as a business, persona or company that has since been deleted.
 */
export async function loadSentAsIdentities(
  identities: Pick<IdentitiesService, 'getByIds' | 'describeIdentities'>,
  candidates: ReadonlyArray<SentAsCandidate>,
): Promise<Map<string, SentAsIdentityDTO>> {
  const identityIds = [
    ...new Set(
      candidates
        .map((candidate) => candidate.senderIdentityId)
        .filter((identityId): identityId is string => Boolean(identityId)),
    ),
  ];
  const sentAsByIdentityId = new Map<string, SentAsIdentityDTO>();
  if (!identityIds.length) {
    return sentAsByIdentityId;
  }
  const resolvedIdentities = await identities.getByIds(identityIds);
  const mailboxIdentities = resolvedIdentities.filter(
    (
      identity,
    ): identity is Identity & {
      kind: Exclude<IdentityKind, IdentityKind.Profile>;
    } => identity.kind !== IdentityKind.Profile,
  );
  const descriptions = mailboxIdentities.length
    ? await identities.describeIdentities(
        mailboxIdentities.map((identity) => identity.id),
      )
    : new Map<string, { displayName: string; handle: string | null }>();
  for (const identity of mailboxIdentities) {
    const description = descriptions.get(identity.id);
    sentAsByIdentityId.set(identity.id, {
      identityId: identity.id,
      kind: identity.kind,
      displayName: description?.displayName ?? null,
      handle: description?.handle ?? null,
    });
  }
  const resolvedIdentityIds = new Set(
    resolvedIdentities.map((identity) => identity.id),
  );
  for (const candidate of candidates) {
    const identityId = candidate.senderIdentityId;
    if (
      identityId &&
      candidate.senderId &&
      !resolvedIdentityIds.has(identityId)
    ) {
      sentAsByIdentityId.set(identityId, {
        identityId,
        kind: null,
        displayName: null,
        handle: null,
      });
    }
  }
  return sentAsByIdentityId;
}

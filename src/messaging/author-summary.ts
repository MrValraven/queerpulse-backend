import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import type {
  IdentityAttributionService,
  StaffNameResolver,
} from '../identities/identity-attribution.service';
import type {
  IdentitiesService,
  IdentityDescription,
} from '../identities/identities.service';
import type { Profile } from '../users/entities/profile.entity';
import {
  AuthorSummary,
  FORMER_IDENTITY_AUTHOR,
  senderAuthorSummary,
} from './message-response';

/**
 * The inputs `buildAuthorSummary` needs to render an IDENTITY (mailbox) as a
 * message author: the identity's own display fields, already resolved by the
 * caller (a listing/company/subprofile's name, avatar and handle each come
 * from a different entity, so resolving them stays the caller's own job),
 * plus the staff first name this reader is owed, or `null` when
 * they are owed none. Pass `staffFirstName` straight from
 * `IdentityAttributionService.resolveStaffFirstName` (one message) or from a
 * `StaffNameResolver.resolve` (a whole thread), both of which already apply the
 * two-switch attribution gate, so this function does no gating of its own
 * beyond refusing to publish a blank name.
 */
export interface BuildAuthorSummaryInput {
  identity: Pick<Identity, 'id' | 'kind'>;
  identityDisplayName: string;
  identityHandle: string;
  identityAvatarUrl: string | null;
  staffFirstName: string | null;
}

/**
 * The one spelling of "who wrote this message" for an author who is a
 * business/persona/company mailbox, mirroring `requireAuthorSummary`'s role
 * for a profile author. The identity is always the visible sender:
 * `displayName`/`handle`/`avatarUrl` are the identity's own, so a colleague's
 * personal profile can never leak into a customer-facing bubble by way of
 * this function. `staffFirstName` rides alongside, present only when
 * attribution allows it; a blank or whitespace-only value is treated as
 * absent, failing closed to showing the business alone.
 */
export function buildAuthorSummary(
  input: BuildAuthorSummaryInput,
): AuthorSummary {
  const {
    identity,
    identityDisplayName,
    identityHandle,
    identityAvatarUrl,
    staffFirstName,
  } = input;
  const trimmedStaffFirstName = staffFirstName?.trim();
  return {
    handle: identityHandle,
    displayName: identityDisplayName,
    // Businesses/personas/companies carry no pronouns of their own; the
    // reader is talking to the mailbox itself.
    pronouns: null,
    avatarUrl: identityAvatarUrl,
    identityId: identity.id,
    identityKind: identity.kind,
    ...(trimmedStaffFirstName ? { staffFirstName: trimmedStaffFirstName } : {}),
  };
}

/**
 * Task 13c: everything needed to render a message's sender for one reader,
 * loaded once for a whole page. Built only by {@link loadSenderIdentityContext}
 * and read only by {@link renderMessageSender}, so the thread, the inbox
 * preview, search and the starred list all name a sender the same way.
 */
export interface SenderIdentityContext {
  identityKindById: ReadonlyMap<string, IdentityKind>;
  identityDescriptionById: ReadonlyMap<string, IdentityDescription>;
  staffNameResolver: StaffNameResolver;
}

/**
 * Task 13c: loads a {@link SenderIdentityContext} for `identityIds`, read by
 * `readerUserId`, in three batched calls whatever the page size: every
 * identity's kind, every identity's own display fields, and one
 * `StaffNameResolver` deciding the staff first name this reader is owed.
 */
export async function loadSenderIdentityContext(
  dependencies: {
    identities: Pick<IdentitiesService, 'getByIds' | 'describeIdentities'>;
    identityAttribution: Pick<
      IdentityAttributionService,
      'buildStaffNameResolver'
    >;
  },
  identityIds: ReadonlyArray<string>,
  readerUserId: string,
): Promise<SenderIdentityContext> {
  const uniqueIdentityIds = [...new Set(identityIds)];
  const [identities, identityDescriptionById, staffNameResolver] =
    await Promise.all([
      dependencies.identities.getByIds(uniqueIdentityIds),
      dependencies.identities.describeIdentities(uniqueIdentityIds),
      dependencies.identityAttribution.buildStaffNameResolver(
        uniqueIdentityIds,
        readerUserId,
      ),
    ]);
  return {
    identityKindById: new Map(
      identities.map((identity) => [identity.id, identity.kind]),
    ),
    identityDescriptionById,
    staffNameResolver,
  };
}

/**
 * Task 13c: the one spelling of "who sent this message" for a reader, moved
 * here from `MessagingCoreService.toMessageResponses` (fix rounds 1 and 2 of
 * Task 11) so every read path shares it.
 *
 * A business/persona/company sender renders as the identity itself, with
 * the staff first name alongside only when attribution allows it for this
 * reader. The ordinary profile-author path is used only for a genuinely
 * personal message: an erased sender (`senderId === null`), a row carrying
 * no `senderIdentityId`, or one whose `senderIdentityId` resolved to a
 * `Profile`. A `senderIdentityId` that is present and did not resolve renders
 * `FORMER_IDENTITY_AUTHOR`, because `senderIdentityId` carries no foreign key
 * precisely so a deleted business keeps naming the identity it was sent as.
 * The human who typed for it stays unnamed.
 */
export function renderMessageSender(
  message: {
    senderId: string | null;
    senderIdentityId?: string | null;
  },
  profileByUser: ReadonlyMap<string, Profile>,
  context: SenderIdentityContext,
): AuthorSummary {
  const { senderId, senderIdentityId } = message;
  if (!senderId || !senderIdentityId) {
    return senderAuthorSummary(senderId, profileByUser);
  }
  const identityKind = context.identityKindById.get(senderIdentityId);
  const identityDescription =
    context.identityDescriptionById.get(senderIdentityId);
  if (
    identityKind &&
    identityKind !== IdentityKind.Profile &&
    identityDescription
  ) {
    return buildAuthorSummary({
      identity: { id: senderIdentityId, kind: identityKind },
      identityDisplayName: identityDescription.displayName,
      identityHandle: identityDescription.handle ?? '',
      identityAvatarUrl: identityDescription.avatarUrl,
      staffFirstName: context.staffNameResolver.resolve(
        senderIdentityId,
        senderId,
        profileByUser.get(senderId)?.firstName ?? '',
      ),
    });
  }
  if (identityKind === IdentityKind.Profile) {
    return senderAuthorSummary(senderId, profileByUser);
  }
  return FORMER_IDENTITY_AUTHOR;
}

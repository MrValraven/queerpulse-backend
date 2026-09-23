import { IdentityKind } from '../identities/entities/identity.entity';
import type { IdentityDescription } from '../identities/identities.service';
import { MessageKind } from './entities/message.entity';
import { FORMER_IDENTITY_AUTHOR, MessageResponse } from './message-response';

/**
 * Task 23: the per-viewer fields `MessagingCoreService.toMessageResponses`
 * adds after it has built each `MessageResponse`. They are declared here so
 * `message-response.ts` stays unchanged, the same pattern Task 13h used for
 * unavailable quotes.
 */

/**
 * The `moved_to_business_mailbox` note's system event, carrying the business
 * the thread moved into, resolved on every read so a later rename shows
 * everywhere. `isFormerMailbox` is true when that identity no longer
 * resolves, and `mailboxName` then reads the former-business label.
 */
export type MovedNoteSystemEvent = NonNullable<
  MessageResponse['systemEvent']
> & {
  mailboxName: string;
  isFormerMailbox: boolean;
};

/**
 * A `MessageResponse` rendered for one viewer. `isSentByViewer` is present
 * only on a business reply in a direct thread, read by staff of the
 * business that sent it: true when this viewer typed it, false when a
 * colleague did. Every other row, and every row of a group or official
 * thread, leaves the key out. Assignable to `MessageResponse`, so callers keep
 * their types.
 */
export type ViewerMessageResponse = MessageResponse & {
  isSentByViewer?: boolean;
  systemEvent: MovedNoteSystemEvent | MessageResponse['systemEvent'];
};

/** The system event type of the note migration 1821260000000 writes. */
export const MOVED_TO_BUSINESS_MAILBOX_EVENT = 'moved_to_business_mailbox';

/** The row fields the helpers below read. */
export interface ViewerMessageRow {
  senderId: string | null;
  senderIdentityId?: string | null;
  kind: MessageKind;
  systemEvent: { type: string; value?: string } | null;
}

/** What the helpers below need to know about the page and its viewer. */
export interface ViewerMessageContext {
  viewerId: string;
  /** The identity of the viewer's own seat in this conversation, when the
   *  viewer holds one. */
  viewerSeatIdentityId: string | undefined;
  identityKindById: ReadonlyMap<string, IdentityKind>;
  identityDescriptionById: ReadonlyMap<string, IdentityDescription>;
  /** True for a group or an official thread. Only a direct thread is a
   *  business mailbox, so these threads carry no `isSentByViewer` key
   *  whatever identities their seats hold. */
  isGroupOrOfficialConversation: boolean;
}

/**
 * The business identity ids the moved notes on this page name in `value`,
 * so the page's one identity batch describes them too and a note costs no
 * query of its own.
 */
export function movedNoteMailboxIdentityIds(
  rows: ReadonlyArray<ViewerMessageRow>,
): string[] {
  return rows.flatMap((row) =>
    row.kind === MessageKind.System &&
    row.systemEvent?.type === MOVED_TO_BUSINESS_MAILBOX_EVENT &&
    row.systemEvent.value
      ? [row.systemEvent.value]
      : [],
  );
}

/**
 * Whether this viewer typed a business reply, for staff of the business
 * that sent it. The key is present only in a direct thread, when the row
 * was sent as a non-profile identity AND the viewer's own seat carries that
 * same identity. A group or official thread, a personal message, a
 * customer reading a business reply, a system row and a row whose sender
 * identity did not resolve all return an empty object, so a customer learns
 * nothing about which human answered.
 */
export function isSentByViewerField(
  row: ViewerMessageRow,
  context: ViewerMessageContext,
): { isSentByViewer?: boolean } {
  const senderIdentityId = row.senderIdentityId;
  if (
    context.isGroupOrOfficialConversation ||
    row.kind === MessageKind.System ||
    !senderIdentityId ||
    context.viewerSeatIdentityId !== senderIdentityId
  ) {
    return {};
  }
  const senderIdentityKind = context.identityKindById.get(senderIdentityId);
  if (!senderIdentityKind || senderIdentityKind === IdentityKind.Profile) {
    return {};
  }
  return { isSentByViewer: row.senderId === context.viewerId };
}

/**
 * The moved note's system event for this viewer: the business it names
 * (`mailboxName`, `isFormerMailbox`), and, for a viewer who is not staff of
 * that business, an actor that is the business itself. `buildSystemEvent`
 * fills the actor from the owner's personal profile, and the note's copy
 * names no actor, so for a customer those fields are the only place the
 * payload would name a human behind the business. Staff of the business
 * (their seat carries the identity in `value`) keep the owner. Any other
 * system event is returned as it came. The thread view
 * (`toViewerMessageResponse`) and the inbox preview
 * (`MessagingCoreService.buildLastMessagePreview`) both render the note
 * through here.
 */
export function withMovedNoteMailbox(
  systemEvent: MessageResponse['systemEvent'],
  context: Pick<
    ViewerMessageContext,
    'viewerSeatIdentityId' | 'identityDescriptionById'
  >,
): ViewerMessageResponse['systemEvent'] {
  if (
    !systemEvent ||
    systemEvent.type !== MOVED_TO_BUSINESS_MAILBOX_EVENT ||
    !systemEvent.value
  ) {
    return systemEvent;
  }
  const mailboxIdentityId = systemEvent.value;
  const description = context.identityDescriptionById.get(mailboxIdentityId);
  const mailboxName =
    description?.displayName ?? FORMER_IDENTITY_AUTHOR.displayName;
  const isFormerMailbox = description === undefined;
  const isViewerStaffOfMailbox =
    context.viewerSeatIdentityId === mailboxIdentityId;
  if (isViewerStaffOfMailbox) {
    return { ...systemEvent, mailboxName, isFormerMailbox };
  }
  return {
    ...systemEvent,
    actorName: mailboxName,
    actorHandle: null,
    ...('actorIsMe' in systemEvent ? { actorIsMe: false } : {}),
    mailboxName,
    isFormerMailbox,
  };
}

/** Adds the Task 23 fields to one response built for `context.viewerId`. */
export function toViewerMessageResponse(
  response: MessageResponse,
  row: ViewerMessageRow,
  context: ViewerMessageContext,
): ViewerMessageResponse {
  return {
    ...response,
    ...isSentByViewerField(row, context),
    systemEvent: withMovedNoteMailbox(response.systemEvent, context),
  };
}

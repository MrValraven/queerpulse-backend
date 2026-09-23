/**
 * Task 25: a member gained or lost staff standing on a business, persona or
 * company mailbox. Emitted by `IdentityMailboxSyncService` for exactly the
 * users whose seats a call started or ended (or, on a mailbox with no threads
 * yet, the one user an add or removal named), after the write that changed
 * the seats has committed. An idempotent call that changed nothing emits
 * nothing.
 *
 * `MailboxStaffRelayListener` turns it into the `mailbox:staffing` socket
 * frame for the affected member alone.
 */
export const IDENTITY_STAFFING_CHANGED = 'identity.staffing.changed';

/** See {@link IDENTITY_STAFFING_CHANGED}. */
export interface IdentityStaffingChangedEvent {
  /** The mailbox identity whose staff changed. */
  identityId: string;
  /** The member who gained or lost standing. */
  userId: string;
  /** True when the member is now staff of the mailbox. */
  isStaff: boolean;
}

/**
 * The `mailbox:staffing` socket frame. It goes to the affected member's own
 * `user:<userId>` room only: colleagues, conversation rooms and customers
 * receive nothing, since the frame describes a change to who staffs the
 * mailbox (Task 13c audit rules). The client refreshes its identity switcher
 * on it.
 */
export const MAILBOX_STAFFING_FRAME = 'mailbox:staffing';

/** Payload of {@link MAILBOX_STAFFING_FRAME}. */
export interface MailboxStaffingFrame {
  identityId: string;
  isStaff: boolean;
}

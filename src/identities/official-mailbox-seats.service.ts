import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IdentitiesService } from './identities.service';
import {
  IdentityMailboxSyncService,
  MailboxSeatChanges,
} from './identity-mailbox-sync.service';

/**
 * The QueerPulse Team mailbox's seats in one member's official thread.
 *
 * An official thread starts with one seat, the member's own: the house
 * account posts into it without one (`OfficialConversationsService`). It
 * joins the QueerPulse Team mailbox the first time the member replies, when
 * every current staff member (`OFFICIAL_MAILBOX_STAFF_ROLES`) is seated under
 * the `official` identity, and each later reply reconciles those seats again:
 * a new moderator is seated, one whose role was removed has their seat ended
 * and any claim they held released. The hourly mailbox sweep runs the same
 * reconciliation across every thread of the mailbox.
 *
 * Seating on the reply, not when the thread is created, keeps the mailbox to
 * the threads that need an answer: every member has an official thread, and
 * seating every staff member in each one would cost a row per member per
 * staff member to carry threads nobody wrote in.
 *
 * Staff are seated with the thread's whole history, which is the platform's
 * own posts and the member's replies to them (`shouldSeatWithFullHistory`),
 * so whoever answers reads what the member is replying to.
 */
@Injectable()
export class OfficialMailboxSeatsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly identities: IdentitiesService,
    private readonly mailboxSync: IdentityMailboxSyncService,
  ) {}

  /** The QueerPulse Team identity's id, cached after the first read. */
  officialIdentityId(): Promise<string> {
    return this.identities.resolveOfficialIdentityId();
  }

  /**
   * Seats the QueerPulse Team's current staff in `conversationId` before the
   * member's reply is stored, so the reply's live frame and unread count
   * reach them. Runs in its own transaction under the staff-source lock, and
   * emits the seat changes after it commits.
   */
  async seatStaffForMemberReply(
    conversationId: string,
  ): Promise<MailboxSeatChanges> {
    const officialIdentityId =
      await this.identities.resolveOfficialIdentityId();
    return this.mailboxSync.resyncConversation(
      officialIdentityId,
      conversationId,
      undefined,
      { shouldLockStaffSource: true, shouldSeatWithFullHistory: true },
    );
  }

  /**
   * Reconciles every seat of the QueerPulse Team mailbox against its staff
   * right away, for a role change (`AdminMembersService.updateRole`): a new
   * moderator is seated in every thread of the mailbox, and a former one's
   * seats end, with any claim they held released. The hourly sweep would
   * reach the same state within the hour; this closes that window. One
   * transaction under the staff-source lock, the sweep's own shape, and the
   * changes go out only after it commits.
   */
  async resyncStaff(): Promise<MailboxSeatChanges> {
    const officialIdentityId =
      await this.identities.resolveOfficialIdentityId();
    const changes = await this.dataSource.transaction((manager) =>
      this.mailboxSync.resyncMailbox(officialIdentityId, manager, {
        shouldDeferEmission: true,
        shouldLockStaffSource: true,
        shouldSeatWithFullHistory: true,
      }),
    );
    this.mailboxSync.emitSeatChanges(changes);
    return changes;
  }
}

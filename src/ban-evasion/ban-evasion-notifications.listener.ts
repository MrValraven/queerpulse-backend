import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  BAN_EVASION_ESCALATION_RAISED,
  BAN_EVASION_ESCALATION_RESOLVED,
  BanEvasionEscalationRaisedEvent,
  BanEvasionEscalationResolvedEvent,
} from './ban-evasion.events';

/**
 * Closes the notification loop on an escalation: staff are told one was raised,
 * and the moderator who raised it is told it was closed (PRD-31).
 *
 * Before this, both halves of the round trip were silent. The escalation landed
 * on `GET /admin/ban-evasion/escalations` and pinged nobody, so it was found
 * only if a staff member happened to open the queue; and when staff closed it,
 * the moderator who asked could see `status` flip to `resolved` by reopening
 * their own list and was never pushed anything. A community moderator has
 * somebody standing at their door while that round trip happens.
 *
 * A LISTENER, not a call inlined into the two services, for the reason
 * `ban-evasion.listener.ts` already states for `ACCOUNT_REMOVED`: the write has
 * committed, and reacting to it must never be able to fail or roll back the
 * thing that produced it. Both handlers swallow their own failures, and both
 * emit sites use `emitBestEffort`, so a listener that throws synchronously
 * cannot reach the request either.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY BOUNDARY, which is the whole reason this feature is shaped the
 * way it is
 * ---------------------------------------------------------------------------
 * The community moderator recognises, platform staff investigates. A moderator
 * triaging a join request is told ONE BIT: does this applicant correlate with
 * somebody THIS community banned (`CommunityBanEvasionFlagDTO`). No tier, no
 * score, no matched signal, and nothing at all about another community's bans or
 * a platform ban.
 *
 * So the two notifications point in opposite directions and carry opposite
 * things:
 *
 *  - TO STAFF, nothing about the applicant. Not their id, name, slug,
 *    assessment, tier or score, and not the escalating moderator's free-text
 *    note either. Staff read every one of those on `/admin/ban-evasion`, one
 *    click away and behind that console's own authentication. A bell payload is
 *    the wrong place to keep a ban history, and this row only needs to get
 *    somebody to the queue.
 *  - TO THE RAISER, nothing about the outcome. Only that the case is closed. No
 *    `resolutionNote`, no resolving staff member, no resolution timestamp, no
 *    part of the assessment. That is the cross-community judgement the one-bit
 *    badge exists to withhold from exactly this person, and a notification is
 *    the easiest place on the platform to hand it over by accident. Every key
 *    that payload carries is something the recipient already holds from
 *    `GET /communities/:slug/join-requests/escalations`, which is the test any
 *    future addition has to pass.
 *
 * NEITHER NOTIFICATION CARRIES AN ACTOR ID. For the staff fan-out that is the
 * `ReportFiled` rule: duty mail must not be droppable by a block or mute between
 * two staff accounts, and the bell should read as the platform speaking rather
 * than naming which moderator escalated. For the resolution it is the same rule
 * seen from the other side: naming the staff member who closed the case would
 * say who looked, which is part of what is being withheld.
 */
@Injectable()
export class BanEvasionNotificationsListener {
  private readonly logger = new Logger(BanEvasionNotificationsListener.name);

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Tell platform staff a question is waiting.
   *
   * Fires once per escalation, because `escalate` only emits on an actual
   * insert: a repeat press of the button and the loser of the insert race both
   * return the existing row and emit nothing. Staff hear about a case once.
   */
  @OnEvent(BAN_EVASION_ESCALATION_RAISED)
  async onEscalationRaised(
    event: BanEvasionEscalationRaisedEvent,
  ): Promise<void> {
    try {
      await this.notifyStaffOfEscalation(event);
    } catch (error) {
      // Best effort by the event's contract: the escalation has committed and
      // is already on `/admin/ban-evasion`, so a failure here costs a ping and
      // must never surface to the moderator who raised it.
      this.logger.warn(
        `ban-evasion escalation notification failed for escalation ${event.escalationId}: ${String(error)}`,
      );
    }
  }

  /**
   * Tell the moderator who asked that somebody looked and the case is closed.
   * Them only: this is the answer to a question they raised by hand, and it is
   * not news for a roster.
   */
  @OnEvent(BAN_EVASION_ESCALATION_RESOLVED)
  async onEscalationResolved(
    event: BanEvasionEscalationResolvedEvent,
  ): Promise<void> {
    try {
      await this.notifyRaiserOfResolution(event);
    } catch (error) {
      this.logger.warn(
        `ban-evasion resolution notification failed for escalation ${event.escalationId}: ${String(error)}`,
      );
    }
  }

  /**
   * The platform's own responders: every ACTIVE account on the `moderator` or
   * `admin` tier, which is exactly the pair `BanEvasionController` is guarded by
   * (`@Roles(Moderator, Admin)` under a plain `RolesGuard`), so nobody is told
   * about a queue they cannot open. A member can never receive this.
   *
   * Additive staff GRANTS are deliberately not included, matching
   * `ModerationQueueAlertService`: no grant opens `/admin/ban-evasion`, so a
   * grant holder could do nothing with the alert.
   *
   * `createForRecipients` is called with NO actor argument, exactly as
   * `ReportNotificationsListener` and `ModerationQueueAlertService` call it.
   */
  private async notifyStaffOfEscalation(
    event: BanEvasionEscalationRaisedEvent,
  ): Promise<void> {
    const community = await this.communities.findOne({
      where: { id: event.communityId },
      select: { id: true, slug: true, name: true },
    });
    if (!community) return; // the community went away under the escalation

    const staff = await this.users.find({
      where: {
        role: In([UserRole.Moderator, UserRole.Admin]),
        status: UserStatus.Active,
      },
      select: { id: true },
    });
    // The moderator who raised it is left out even when they also hold a
    // platform role: nobody needs paging about their own filing, the same
    // exclusion `ReportNotificationsListener` makes for a reporter.
    const recipientIds = staff
      .map((staffUser) => staffUser.id)
      .filter((userId) => userId !== event.raisedByUserId);
    if (!recipientIds.length) return;

    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.BanEvasionEscalationRaised,
      {
        source: 'moderation',
        escalationId: event.escalationId,
        communitySlug: community.slug,
        communityName: community.name,
      },
    );
  }

  /**
   * The one recipient. Read the payload below against the class doc comment
   * before adding anything to it: every key here is already on the
   * `CommunityBanEvasionEscalationDTO` this moderator reads on their own
   * surface, and nothing about the assessment, the resolution note, the staff
   * member who closed it or when they closed it belongs in a row that reaches
   * this person.
   */
  private async notifyRaiserOfResolution(
    event: BanEvasionEscalationResolvedEvent,
  ): Promise<void> {
    // Null once the moderator's account has been erased, which leaves nobody to
    // tell. The case stays readable as history on the staff console.
    if (!event.raisedByUserId) return;

    const community = await this.communities.findOne({
      where: { id: event.communityId },
      select: { id: true, slug: true, name: true },
    });
    if (!community) return;

    await this.notifications.create(
      event.raisedByUserId,
      NotificationType.BanEvasionEscalationResolved,
      {
        source: 'community',
        escalationId: event.escalationId,
        joinRequestId: event.joinRequestId,
        communitySlug: community.slug,
        communityName: community.name,
      },
    );
  }
}

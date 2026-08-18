import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  CONNECTION_REQUESTED,
  ConnectionAcceptedEvent,
  ConnectionRequestedEvent,
} from '../connections/connection.events';
import {
  EVENT_COHOST_INVITED,
  EVENT_INVITED,
  EVENT_RSVPED,
  EVENT_WAITLIST_PROMOTED,
  EventCohostInvitedEvent,
  EventInvitedEvent,
  EventRsvpedEvent,
  EventWaitlistPromotedEvent,
} from '../events/event.events';
import {
  INVITE_ACCEPTED,
  InviteAcceptedEvent,
} from '../membership/membership.events';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  SUBPROFILE_DELETED,
  SUBPROFILE_ENDORSED,
  SUBPROFILE_FOLLOWED,
  SUBPROFILE_INVITE_ACCEPTED,
  SUBPROFILE_INVITED,
  SUBPROFILE_MEMBER_REMOVED,
  SubprofileDeletedEvent,
  SubprofileEndorsedEvent,
  SubprofileFollowedEvent,
  SubprofileInviteAcceptedEvent,
  SubprofileInvitedEvent,
  SubprofileMemberRemovedEvent,
} from '../subprofiles/subprofile.events';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import { VOUCH_CREATED, VouchCreatedEvent } from '../vouch/vouch.events';
import { NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsListener {
  constructor(
    private readonly notifications: NotificationsService,
    // Read-only — only used to resolve a persona's CURRENT co-owner roster on
    // `subprofile.invite.accepted` (to fan the join notification out to
    // everyone but the joiner). No write path here; the roster write itself
    // lives entirely in `SubprofileInvitesService`.
    @InjectRepository(SubprofileMember)
    private readonly subprofileMembers: Repository<SubprofileMember>,
  ) {}

  // Every `create`/`createForRecipients` call below passes the acting member as
  // the trailing `actorId` argument so `NotificationsService` can suppress the
  // notification when that actor is blocked/muted by the recipient (see that
  // method's doc comment for why this is enforced at write time). The two
  // system-generated types — `PromotedToMember` and `WaitlistPromoted` — pass
  // no actor on purpose: they are the platform telling you about your own
  // status, with no member behind them to filter on.
  @OnEvent(CONNECTION_REQUESTED)
  async onConnectionRequested(e: ConnectionRequestedEvent): Promise<void> {
    await this.notifications.create(
      e.addresseeId,
      NotificationType.ConnectionRequest,
      { connectionId: e.connectionId, fromUserId: e.requesterId },
      e.requesterId,
    );
    if (e.introducedBy) {
      await this.notifications.create(
        e.introducedBy,
        NotificationType.IntroductionMade,
        {
          connectionId: e.connectionId,
          requesterId: e.requesterId,
          addresseeId: e.addresseeId,
        },
        e.requesterId,
      );
    }
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async onConnectionAccepted(e: ConnectionAcceptedEvent): Promise<void> {
    await this.notifications.create(
      e.requesterId,
      NotificationType.ConnectionAccepted,
      { connectionId: e.connectionId, byUserId: e.addresseeId },
      e.addresseeId,
    );
  }

  @OnEvent(VOUCH_CREATED)
  async onVouchCreated(e: VouchCreatedEvent): Promise<void> {
    await this.notifications.create(
      e.voucheeId,
      NotificationType.VouchReceived,
      { voucherId: e.voucherId },
      e.voucherId,
    );
  }

  @OnEvent(USER_PROMOTED)
  async onUserPromoted(e: UserPromotedEvent): Promise<void> {
    await this.notifications.create(
      e.userId,
      NotificationType.PromotedToMember,
      {},
    );
  }

  // New direct messages deliberately do NOT create a bell notification: the
  // Messages inbox (with its own unread count) is the sole surface for them.
  // Adding a `NewMessage` row per message duplicated that inbox and flooded the
  // bell on any active thread. The `NewMessage` enum value + its frontend
  // rendering stay for the demo-mode mock list; nothing writes it in live mode.

  @OnEvent(EVENT_INVITED)
  async onEventInvited(e: EventInvitedEvent): Promise<void> {
    await this.notifications.create(
      e.inviteeId,
      NotificationType.EventInvite,
      { eventId: e.eventId, inviteId: e.inviteId, inviterId: e.inviterId },
      e.inviterId,
    );
  }

  // Deep-links via `payload.source === 'cohost_invite'`: its own discriminator
  // so `sourceHrefFromPayload` (frontend) can route this to
  // `/gatherings/:slug/co-host-invite/:inviteId`, distinct from the plain
  // gathering page that `event`/`event_rsvp` notifications resolve to.
  @OnEvent(EVENT_COHOST_INVITED)
  async onEventCohostInvited(e: EventCohostInvitedEvent): Promise<void> {
    await this.notifications.create(
      e.inviteeId,
      NotificationType.EventCohostInvite,
      {
        source: 'cohost_invite',
        eventSlug: e.eventSlug,
        inviteId: e.inviteId,
      },
      e.inviterId,
    );
  }

  @OnEvent(EVENT_WAITLIST_PROMOTED)
  async onWaitlistPromoted(e: EventWaitlistPromotedEvent): Promise<void> {
    await this.notifications.create(
      e.userId,
      NotificationType.WaitlistPromoted,
      { eventId: e.eventId, eventSlug: e.eventSlug },
    );
  }

  @OnEvent(EVENT_RSVPED)
  async onEventRsvped(e: EventRsvpedEvent): Promise<void> {
    await this.notifications.create(
      e.hostId,
      NotificationType.EventRsvp,
      {
        actorId: e.rsvperId,
        source: 'event',
        eventId: e.eventId,
        eventSlug: e.eventSlug,
      },
      e.rsvperId,
    );
  }

  @OnEvent(INVITE_ACCEPTED)
  async onInviteAccepted(e: InviteAcceptedEvent): Promise<void> {
    await this.notifications.create(
      e.inviterId,
      NotificationType.InviteAccepted,
      { actorId: e.newMemberId },
      e.newMemberId,
    );
  }

  @OnEvent(SUBPROFILE_ENDORSED)
  async onSubprofileEndorsed(e: SubprofileEndorsedEvent): Promise<void> {
    await this.notifications.create(
      e.ownerId,
      NotificationType.PersonaEndorsed,
      { subprofileId: e.subprofileId },
      e.endorserId,
    );
  }

  @OnEvent(SUBPROFILE_FOLLOWED)
  async onSubprofileFollowed(e: SubprofileFollowedEvent): Promise<void> {
    await this.notifications.create(
      e.ownerId,
      NotificationType.PersonaFollowed,
      { subprofileId: e.subprofileId },
      e.followerId,
    );
  }

  @OnEvent(SUBPROFILE_INVITED)
  async onSubprofileInvited(e: SubprofileInvitedEvent): Promise<void> {
    await this.notifications.create(
      e.invitedUserId,
      NotificationType.SubprofileInvite,
      {
        subprofileId: e.subprofileId,
        displayName: e.displayName,
        invitedByUserId: e.invitedByUserId,
      },
      e.invitedByUserId,
    );
  }

  // Fans out to every CURRENT co-owner of the persona except the member who
  // just joined — one batched roster query, one batched insert
  // (`createForRecipients`), regardless of how many co-owners there are.
  @OnEvent(SUBPROFILE_INVITE_ACCEPTED)
  async onSubprofileInviteAccepted(
    e: SubprofileInviteAcceptedEvent,
  ): Promise<void> {
    const members = await this.subprofileMembers.find({
      where: { subprofileId: e.subprofileId },
      select: { userId: true },
    });
    const recipientIds = members
      .map((member) => member.userId)
      .filter((userId) => userId !== e.joinedUserId);
    if (!recipientIds.length) {
      return;
    }
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.SubprofileCoOwnerJoined,
      { subprofileId: e.subprofileId, joinedUserId: e.joinedUserId },
      e.joinedUserId,
    );
  }

  // A persona's creator deleted it — tell every co-owner (the creator is
  // already excluded from `coOwnerIds` at the emit site). The persona row is
  // gone, so the payload carries its name for display; block/mute still applies
  // via the deleting creator as the actor.
  @OnEvent(SUBPROFILE_DELETED)
  async onSubprofileDeleted(e: SubprofileDeletedEvent): Promise<void> {
    if (!e.coOwnerIds.length) {
      return;
    }
    await this.notifications.createForRecipients(
      e.coOwnerIds,
      NotificationType.SubprofileDeleted,
      { subprofileName: e.displayName },
      e.deletedByUserId,
    );
  }

  // A persona's creator removed a co-owner — tell that one member. Mirrors
  // `onSubprofileDeleted`: the persona still exists but is no longer theirs, so
  // the payload carries its name for display and the removing creator is the
  // actor (`removedByUserId`) so block/mute filtering applies.
  @OnEvent(SUBPROFILE_MEMBER_REMOVED)
  async onSubprofileMemberRemoved(
    e: SubprofileMemberRemovedEvent,
  ): Promise<void> {
    await this.notifications.createForRecipients(
      [e.removedUserId],
      NotificationType.SubprofileMemberRemoved,
      { subprofileName: e.displayName },
      e.removedByUserId,
    );
  }
}

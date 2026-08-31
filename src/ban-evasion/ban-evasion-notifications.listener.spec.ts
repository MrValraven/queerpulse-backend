import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { Community } from '../communities/entities/community.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { BanEvasionNotificationsListener } from './ban-evasion-notifications.listener';
import {
  BanEvasionEscalationRaisedEvent,
  BanEvasionEscalationResolvedEvent,
} from './ban-evasion.events';

const COMMUNITY_ID = 'community-1';
const JOIN_REQUEST_ID = 'join-request-1';
const ESCALATION_ID = 'escalation-1';
const MODERATOR_ID = 'moderator-1';
const APPLICANT_ID = 'applicant-1';
const STAFF_ID = 'staff-1';
const SECOND_STAFF_ID = 'staff-2';

function raisedEvent(
  overrides: Partial<BanEvasionEscalationRaisedEvent> = {},
): BanEvasionEscalationRaisedEvent {
  return {
    escalationId: ESCALATION_ID,
    communityId: COMMUNITY_ID,
    joinRequestId: JOIN_REQUEST_ID,
    raisedByUserId: MODERATOR_ID,
    ...overrides,
  };
}

function resolvedEvent(
  overrides: Partial<BanEvasionEscalationResolvedEvent> = {},
): BanEvasionEscalationResolvedEvent {
  return {
    escalationId: ESCALATION_ID,
    communityId: COMMUNITY_ID,
    joinRequestId: JOIN_REQUEST_ID,
    raisedByUserId: MODERATOR_ID,
    ...overrides,
  };
}

describe('BanEvasionNotificationsListener', () => {
  let listener: BanEvasionNotificationsListener;
  let users: { find: jest.Mock };
  let communities: { findOne: jest.Mock };
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };

  beforeEach(async () => {
    users = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: STAFF_ID }, { id: SECOND_STAFF_ID }]),
    };
    communities = {
      findOne: jest.fn().mockResolvedValue({
        id: COMMUNITY_ID,
        slug: 'lisbon-choir',
        name: 'Lisbon Choir',
      }),
    };
    notifications = {
      create: jest.fn().mockResolvedValue(null),
      createForRecipients: jest.fn().mockResolvedValue([]),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BanEvasionNotificationsListener,
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    listener = moduleRef.get(BanEvasionNotificationsListener);
  });

  describe('onEscalationRaised', () => {
    it('fans out to every active platform moderator and admin', async () => {
      await listener.onEscalationRaised(raisedEvent());

      expect(users.find).toHaveBeenCalledWith({
        where: {
          role: In([UserRole.Moderator, UserRole.Admin]),
          status: UserStatus.Active,
        },
        select: { id: true },
      });
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        [STAFF_ID, SECOND_STAFF_ID],
        NotificationType.BanEvasionEscalationRaised,
        {
          source: 'moderation',
          escalationId: ESCALATION_ID,
          communitySlug: 'lisbon-choir',
          communityName: 'Lisbon Choir',
        },
      );
    });

    it('passes no actor, so a block between staff cannot swallow duty mail', async () => {
      await listener.onEscalationRaised(raisedEvent());

      // Three arguments exactly: recipients, type, payload. A fourth would be
      // the acting member, and `NotificationsService` would then run every
      // recipient's own block/mute list over an operational alert.
      expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
    });

    it('leaves out the moderator who raised it, staff role or not', async () => {
      users.find.mockResolvedValue([{ id: STAFF_ID }, { id: MODERATOR_ID }]);

      await listener.onEscalationRaised(raisedEvent());

      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        [STAFF_ID],
        NotificationType.BanEvasionEscalationRaised,
        expect.anything(),
      );
    });

    it('writes nothing when no active staff account holds either role', async () => {
      users.find.mockResolvedValue([]);

      await listener.onEscalationRaised(raisedEvent());

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    /**
     * The staff bell gets somebody to the queue. Everything about the applicant
     * is read on `/admin/ban-evasion`, behind that console's own
     * authentication, and a ban history has no business sitting in a
     * notification payload.
     */
    it('names nothing about the applicant', async () => {
      await listener.onEscalationRaised(raisedEvent());

      const [, , payload] = notifications.createForRecipients.mock.calls[0] as [
        string[],
        NotificationType,
        unknown,
      ];
      const serialized = JSON.stringify(payload);
      for (const forbidden of [
        APPLICANT_ID,
        MODERATOR_ID,
        'assessment',
        'tier',
        'score',
        'signals',
        'note',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });

    it('swallows a notification failure rather than letting it escape', async () => {
      notifications.createForRecipients.mockRejectedValue(
        new Error('the bell is on fire'),
      );

      await expect(
        listener.onEscalationRaised(raisedEvent()),
      ).resolves.toBeUndefined();
    });

    it('writes nothing when the community went away under the escalation', async () => {
      communities.findOne.mockResolvedValue(null);

      await listener.onEscalationRaised(raisedEvent());

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });
  });

  describe('onEscalationResolved', () => {
    it('tells the moderator who raised it, and nobody else', async () => {
      await listener.onEscalationResolved(resolvedEvent());

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(
        MODERATOR_ID,
        NotificationType.BanEvasionEscalationResolved,
        {
          source: 'community',
          escalationId: ESCALATION_ID,
          joinRequestId: JOIN_REQUEST_ID,
          communitySlug: 'lisbon-choir',
          communityName: 'Lisbon Choir',
        },
      );
      // No fourth argument: naming the staff member who closed the case would
      // say who looked, and would let a block between those two swallow the
      // answer.
      expect(notifications.create.mock.calls[0]).toHaveLength(3);
    });

    /**
     * The constraint the whole PRD-31 design rests on, asserted at the one
     * place it is easiest to break. This recipient is the community moderator
     * who sees ONE BIT about an applicant. They learn that somebody looked and
     * the case is closed, and nothing about what staff concluded.
     */
    it('carries no part of what staff found', async () => {
      await listener.onEscalationResolved(resolvedEvent());

      const [, , payload] = notifications.create.mock.calls[0] as [
        string,
        NotificationType,
        unknown,
      ];
      const serialized = JSON.stringify(payload);
      for (const forbidden of [
        'resolutionNote',
        'resolvedBy',
        'resolvedAt',
        'assessment',
        'tier',
        'score',
        'signals',
        APPLICANT_ID,
        STAFF_ID,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      // And every key it DOES carry is already on the
      // `CommunityBanEvasionEscalationDTO` this moderator reads on their own
      // surface, plus the community they are staff of.
      expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual([
        'communityName',
        'communitySlug',
        'escalationId',
        'joinRequestId',
        'source',
      ]);
    });

    it('writes nothing once the raiser account has been erased', async () => {
      await listener.onEscalationResolved(
        resolvedEvent({ raisedByUserId: null }),
      );

      expect(notifications.create).not.toHaveBeenCalled();
      // Not even a community lookup: there is nobody to tell.
      expect(communities.findOne).not.toHaveBeenCalled();
    });

    it('swallows a notification failure rather than letting it escape', async () => {
      notifications.create.mockRejectedValue(new Error('the bell is on fire'));

      await expect(
        listener.onEscalationResolved(resolvedEvent()),
      ).resolves.toBeUndefined();
    });
  });
});

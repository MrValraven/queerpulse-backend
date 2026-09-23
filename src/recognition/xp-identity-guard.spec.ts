import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RecognitionListener } from './recognition.listener';
import { RecognitionAwardingService } from './recognition-awarding.service';
import { BADGE_REQUIREMENTS, XP_RULES } from './recognition.scoring';
import { PublicEligibilityService } from '../public-eligibility/public-eligibility.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import * as messagingEvents from '../messaging/messaging.events';
import { Message } from '../messaging/entities/message.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { ConversationPinnedMessage } from '../messaging/entities/conversation-pinned-message.entity';
import { GroupInvite } from '../messaging/entities/group-invite.entity';
import { MessageHide } from '../messaging/entities/message-hide.entity';
import { MessageReaction } from '../messaging/entities/message-reaction.entity';
import { MessageStar } from '../messaging/entities/message-star.entity';
import { VOUCH_CREATED } from '../vouch/vouch.events';
import { CONNECTION_ACCEPTED } from '../connections/connection.events';
import { EVENT_RSVPED } from '../events/event.events';
import { COMMUNITY_POST_CREATED } from '../communities/community.events';
import { FORUM_THREAD_CREATED } from '../forum/forum.events';
import { VOLUNTEER_SESSION_COMPLETED } from '../volunteering/volunteering.events';

/**
 * Business mailboxes, task 17: nothing a member does while acting as a
 * listing, a persona (subprofile) or a company earns them recognition XP or
 * badge progress. XP buys extra monthly invitations
 * (`INVITE_QUOTA_BONUS_BY_LEVEL`), so a shared mailbox paying per reply would
 * turn customer service into an invitation farm.
 *
 * Recognition today pays on SIGNALS that `RecognitionAwardingService
 * .gatherSignals` reads from vouches, connections, gatherings, forum and
 * community posts, volunteering, the magazine, listing Q&A and resource
 * suggestions. It reads no messaging table and subscribes to no messaging
 * event, so a message sent as any identity earns nothing today. On a
 * business thread `messages.sender_id` is the human, which means a future
 * rule counting messages, replies, reactions, pins or stars by `sender_id`
 * would pay that human for every business send.
 *
 * This file pins the present state so that such a rule has to come through
 * here: adding a messaging dependency, a messaging event subscription, a new
 * signal, XP rule or badge requirement fails a test below, and the fix is to
 * decide how it treats non-profile senders (filter to `sender_identity_id`
 * of kind `profile`, or exclude mailbox threads) and record that decision in
 * the reviewed tables here.
 *
 * One blind spot: a change that reads messaging data through a repository
 * already injected here, via raw query access, and folds the result into an
 * existing signal key in place adds no new dependency, event subscription or
 * key, so these tests stay green while it widens what earns XP.
 */

const MESSAGING_ENTITIES = [
  Message,
  Conversation,
  ConversationParticipant,
  ConversationPinnedMessage,
  GroupInvite,
  MessageHide,
  MessageReaction,
  MessageStar,
];

const MESSAGING_REPOSITORY_TOKENS = new Set<unknown>(
  MESSAGING_ENTITIES.map((entity) => getRepositoryToken(entity)),
);

const MESSAGING_EVENT_NAMES = new Set<string>(
  (Object.values(messagingEvents) as unknown[]).filter(
    (value): value is string => typeof value === 'string',
  ),
);

/** Every event `RecognitionListener` recomputes on, each one reviewed as
 *  carrying no messaging act. */
const REVIEWED_LISTENER_EVENTS = [
  VOUCH_CREATED,
  CONNECTION_ACCEPTED,
  EVENT_RSVPED,
  COMMUNITY_POST_CREATED,
  FORUM_THREAD_CREATED,
  VOLUNTEER_SESSION_COMPLETED,
];

/** Every signal `gatherSignals` returns, with the table it comes from. None
 *  reads `messages`, `conversations` or any other messaging table. */
const REVIEWED_SIGNAL_SOURCES: Record<string, string> = {
  profileComplete: 'profiles (avatar and bio)',
  communitiesJoined: 'community_members',
  audiencedCommunities: 'community_members',
  personasPublished: 'subprofiles',
  vouchCount: 'vouches',
  connectionCount: 'connections',
  eventsAttended: 'event_rsvps',
  gatheringsAttended: 'event_rsvps joined to events',
  communityPosts: 'forum and community posts and replies',
  engagedCommunityPosts: 'forum and community posts and replies',
  endorsementCount: 'subprofile endorsements',
  eventsHosted: 'events and event_cohosts',
  eventsHeld: 'events, event_cohosts and event_rsvps',
  piecesPublished: 'magazine pieces, articles and decks',
  volunteerSessions: 'volunteer_signups',
  directoryAnswers: 'listing_public_questions',
  resourcesApproved: 'resource_suggestions',
  tenureDays: 'profiles.joined_at',
  verified: 'profiles.verified',
  gettingStartedStepsDone: 'derived from the rows above',
  gettingStartedComplete: 'derived from the rows above',
  listingsSaved: 'saved_items',
  articlesSaved: 'saved_items',
  workProfileComplete: 'member_preferences',
};

const REVIEWED_XP_RULE_KEYS = [
  'profile',
  'communities',
  'personas',
  'vouches',
  'connections',
  'events',
  'posts',
  'endorsements',
  'tenure',
  'verified',
  'gettingStarted',
  'volunteering',
  'hosting',
  'magazine',
  'answers',
  'resources',
];

const REVIEWED_BADGE_KEYS = [
  'first-gathering',
  'three-company',
  'regular-attendee',
  'connector',
  'networker',
  'vouch',
  'thread-starter',
  'contributor',
  'two-homes',
  'decade',
  'sustainer',
  'event-host',
  'serial-host',
  'first-steps',
  'local-scout',
  'well-read',
  'work-ready',
];

const HUMAN_USER_ID = '00000000-0000-4000-8000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000c1';
const MESSAGE_ID = '00000000-0000-4000-8000-0000000000a1';

type ParameterInjection = { index: number; param: unknown };

function injectedRepositoryTokens(serviceClass: object): unknown[] {
  const injections =
    (Reflect.getMetadata('self:paramtypes', serviceClass) as
      ParameterInjection[] | undefined) ?? [];
  return injections.map((injection) => injection.param);
}

function injectedClassNames(serviceClass: object): string[] {
  const parameterTypes =
    (Reflect.getMetadata('design:paramtypes', serviceClass) as
      { name?: string }[] | undefined) ?? [];
  return parameterTypes.map((parameterType) => parameterType?.name ?? '');
}

function subscribedEventNames(listenerClass: { prototype: object }): string[] {
  const prototype = listenerClass.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((methodName) => {
    const method = prototype[methodName];
    if (typeof method !== 'function') return [];
    const listeners =
      (Reflect.getMetadata(EVENT_LISTENER_METADATA, method) as
        { event: string | string[] }[] | undefined) ?? [];
    return listeners.flatMap((listener) =>
      Array.isArray(listener.event) ? listener.event : [listener.event],
    );
  });
}

function messageEventPayloads(senderIdentityKind: IdentityKind) {
  const sender = {
    senderId: HUMAN_USER_ID,
    senderIdentityId: `identity-${senderIdentityKind}`,
  };
  return [
    {
      eventName: messagingEvents.MESSAGE_CREATED,
      payload: {
        conversationId: CONVERSATION_ID,
        message: { id: MESSAGE_ID, conversationId: CONVERSATION_ID, ...sender },
        response: { id: MESSAGE_ID, ...sender },
      },
    },
    {
      eventName: messagingEvents.MESSAGE_REACTION,
      payload: {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        userId: HUMAN_USER_ID,
        reactions: [],
      },
    },
    {
      eventName: messagingEvents.MESSAGE_PINNED,
      payload: {
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        pinned: true,
      },
    },
    {
      eventName: messagingEvents.CONVERSATION_CREATED,
      payload: {
        conversationId: CONVERSATION_ID,
        memberUserIds: [HUMAN_USER_ID],
      },
    },
  ];
}

describe('recognition XP and business identities', () => {
  describe('the event path', () => {
    let eventEmitter: EventEmitter2;
    let recomputeByUserId: jest.Mock;

    beforeEach(async () => {
      recomputeByUserId = jest.fn().mockResolvedValue(undefined);
      const moduleRef = await Test.createTestingModule({
        imports: [EventEmitterModule.forRoot()],
        providers: [
          RecognitionListener,
          {
            provide: RecognitionAwardingService,
            useValue: { recomputeByUserId },
          },
        ],
      }).compile();
      await moduleRef.init();
      eventEmitter = moduleRef.get(EventEmitter2);
    });

    it('recomputes on a reviewed recognition event, proving the listener is wired', async () => {
      await eventEmitter.emitAsync(VOUCH_CREATED, {
        voucherId: HUMAN_USER_ID,
        voucheeId: '00000000-0000-4000-8000-000000000002',
      });

      expect(recomputeByUserId).toHaveBeenCalledWith(HUMAN_USER_ID);
    });

    it.each(Object.values(IdentityKind))(
      'awards nothing for a message sent, reacted to or pinned as a %s identity',
      async (senderIdentityKind) => {
        for (const { eventName, payload } of messageEventPayloads(
          senderIdentityKind,
        )) {
          await eventEmitter.emitAsync(eventName, payload);
        }

        expect(recomputeByUserId).not.toHaveBeenCalled();
      },
    );
  });

  it('subscribes to the reviewed events only, and to no messaging event', () => {
    const subscribed = subscribedEventNames(RecognitionListener);

    expect(
      subscribed.filter((eventName) => MESSAGING_EVENT_NAMES.has(eventName)),
    ).toEqual([]);
    expect([...subscribed].sort()).toEqual(
      [...REVIEWED_LISTENER_EVENTS].sort(),
    );
  });

  it.each([
    ['RecognitionAwardingService', RecognitionAwardingService],
    ['PublicEligibilityService', PublicEligibilityService],
  ])('%s injects no messaging repository or service', (_name, service) => {
    const messagingTokens = injectedRepositoryTokens(service).filter((token) =>
      MESSAGING_REPOSITORY_TOKENS.has(token),
    );
    const messagingClasses = injectedClassNames(service).filter((className) =>
      /Messag|Conversation|Mailbox|Chat/.test(className),
    );

    expect(messagingTokens).toEqual([]);
    expect(messagingClasses).toEqual([]);
  });

  it('gathers exactly the reviewed signals, none of them from messaging', async () => {
    const emptyRepository = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const eligibility = {
      getSignals: jest.fn().mockResolvedValue({
        publishedSubprofiles: 0,
        vouchesGivenCount: 0,
        connectionCount: 0,
        communityPosts: 0,
        eventsAttended: 0,
        endorsementCount: 0,
        hostedOpenEvents: [],
        publishedPieces: [],
        tenureDays: 0,
        verified: false,
        standingOk: true,
      }),
      countHeldGatherings: jest.fn().mockResolvedValue(0),
      countAudiencedCommunities: jest.fn().mockResolvedValue(0),
      countEngagedCommunityPosts: jest.fn().mockResolvedValue(0),
      countAttendedGatherings: jest.fn().mockResolvedValue(0),
    };
    const service = new RecognitionAwardingService(
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      emptyRepository as never,
      eligibility as never,
      {} as never,
    );

    const signals = await service.gatherSignalsForUser(HUMAN_USER_ID);

    expect(Object.keys(signals).sort()).toEqual(
      Object.keys(REVIEWED_SIGNAL_SOURCES).sort(),
    );
  });

  it('pays XP on the reviewed rules only', () => {
    expect(XP_RULES.map((rule) => rule.key).sort()).toEqual(
      [...REVIEWED_XP_RULE_KEYS].sort(),
    );
  });

  it('grants badges on the reviewed requirements only', () => {
    expect(Object.keys(BADGE_REQUIREMENTS).sort()).toEqual(
      [...REVIEWED_BADGE_KEYS].sort(),
    );
  });
});

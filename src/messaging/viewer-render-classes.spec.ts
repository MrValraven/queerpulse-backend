import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, FindOperator, Repository } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModeration } from '../content-moderation/entities/content-moderation.entity';
import { IdentityStaffPreference } from '../identities/entities/identity-staff-preference.entity';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import { Sticker } from '../stickers/entities/sticker.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import {
  ConversationParticipant,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessageHide } from './entities/message-hide.entity';
import {
  MessageReaction,
  MessageReactionKey,
} from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind } from './entities/message.entity';
import {
  isCoveredByMailboxStaffFloor,
  mailboxStaffHistoryFloorCoversPredicate,
} from './mailbox-seats';
import { MessagingCoreService } from './messaging-core.service';
import { VIEWER_RENDER_CLASS_KEY_COMPONENTS } from './viewer-render-classes';
import type { ViewerMessageResponse } from './viewer-message-fields';

/**
 * Final review I2: `renderMessageForViewerClasses` renders a live message
 * once per class of viewers. This spec is its differential proof. For every
 * message and viewer of the fixture below, the class render must be
 * deep-equal to `toMessageResponses` called for that viewer alone, the
 * per-viewer path the gateway used before. A second group of tests leaves
 * each class key component out in turn and requires a mismatch, so the
 * fixture holds, for every component, two viewers who differ in that input
 * alone.
 *
 * The repositories are in-memory stand-ins that filter by the `where` they
 * are given. The floor queries answer through the rule's in-memory twin,
 * `isCoveredByMailboxStaffFloor`. `IdentityAttributionService` is the real
 * service over a stand-in identity lookup and preference table.
 */

const DIRECT_CONVERSATION_ID = 'conversation-mailbox';
const GROUP_CONVERSATION_ID = 'conversation-group';
const UNRESOLVED_CONVERSATION_ID = 'conversation-unresolved';

const LISTING_IDENTITY_ID = 'identity-listing';
const CUSTOMER_IDENTITY_ID = 'identity-customer';
const SHARED_GROUP_IDENTITY_ID = 'identity-shared-group';
const GROUP_SENDER_IDENTITY_ID = 'identity-group-sender';
const SHARED_PROFILE_IDENTITY_ID = 'identity-shared-profile';
const UNRESOLVED_IDENTITY_ID = 'identity-unresolved';

// The business thread's people.
const CUSTOMER_ID = 'user-customer';
const OWNER_ID = 'user-owner';
const FLOORED_CO_MANAGER_ID = 'user-floored-co-manager';
const PLAIN_CO_MANAGER_ID = 'user-plain-co-manager';
const EARLY_FLOOR_CO_MANAGER_ID = 'user-early-floor-co-manager';
const HIDING_CO_MANAGER_ID = 'user-hiding-co-manager';
const SENDER_ID = 'user-sender';
const MODERATOR_CO_MANAGER_ID = 'user-moderator-co-manager';
const OFF_ROSTER_SEAT_ID = 'user-off-roster-seat';
const REACTING_CO_MANAGER_ID = 'user-reacting-co-manager';
const STARRING_CO_MANAGER_ID = 'user-starring-co-manager';
// The group thread's people.
const GROUP_OWNER_ID = 'user-group-owner';
const GROUP_MEMBER_ID = 'user-group-member';
const GROUP_SENDER_ID = 'user-group-sender';
// The thread whose other seats do not resolve.
const FIRST_SHARED_VIEWER_ID = 'user-first-shared';
const SECOND_SHARED_VIEWER_ID = 'user-second-shared';
const UNRESOLVED_SEAT_ID = 'user-unresolved-seat';
const SECOND_UNRESOLVED_SEAT_ID = 'user-second-unresolved-seat';

const MAILBOX_VIEWER_IDS = [
  CUSTOMER_ID,
  OWNER_ID,
  FLOORED_CO_MANAGER_ID,
  PLAIN_CO_MANAGER_ID,
  EARLY_FLOOR_CO_MANAGER_ID,
  HIDING_CO_MANAGER_ID,
  SENDER_ID,
  MODERATOR_CO_MANAGER_ID,
  OFF_ROSTER_SEAT_ID,
  REACTING_CO_MANAGER_ID,
  STARRING_CO_MANAGER_ID,
];
const LISTING_ROSTER = MAILBOX_VIEWER_IDS.filter(
  (userId) => userId !== CUSTOMER_ID && userId !== OFF_ROSTER_SEAT_ID,
);

const EARLY_FLOOR = new Date('2026-09-10T10:00:00.000Z');
const PRE_FLOOR = new Date('2026-09-10T11:00:00.000Z');
const HISTORY_FLOOR = new Date('2026-09-10T12:00:00.000Z');
const POST_FLOOR = new Date('2026-09-10T13:00:00.000Z');

// A business attachment is served by its message reference, which needs a
// uuid message id.
const BUSINESS_IMAGE_MESSAGE_ID = 'cccccccc-0000-4000-8000-000000000001';

const SENDER_PHOTO_KEY =
  'message-images/aaaaaaaa-0000-4000-8000-000000000009/bbbbbbbb-0000-4000-8000-000000000009.jpg';
const CUSTOMER_PHOTO_KEY =
  'message-images/aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001.jpg';

function seat(
  conversationId: string,
  userId: string,
  identityId: string,
  overrides: Partial<ConversationParticipant> = {},
): ConversationParticipant {
  return {
    id: `seat-${conversationId}-${userId}`,
    conversationId,
    userId,
    identityId,
    role: ConversationRole.Member,
    leftAt: null,
    clearedAt: null,
    lastReadAt: null,
    lastReadInstant: null,
    deliveredAt: null,
    ...overrides,
  } as unknown as ConversationParticipant;
}

function messageRow(overrides: Partial<Message>): Message {
  return {
    conversationId: DIRECT_CONVERSATION_ID,
    senderId: SENDER_ID,
    senderIdentityId: LISTING_IDENTITY_ID,
    body: '',
    replyToId: null,
    createdAt: POST_FLOOR,
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    forwarded: false,
    kind: MessageKind.User,
    systemEvent: null,
    attachment: null,
    attachmentPurgeAfter: null,
    ...overrides,
  } as unknown as Message;
}

function profile(userId: string, firstName: string): Profile {
  return {
    userId,
    firstName,
    lastName: 'Fixture',
    slug: `${firstName.toLowerCase()}-fixture`,
    pronouns: null,
    avatarUrl: null,
    photoVisible: true,
  } as unknown as Profile;
}

/** Whether `row` satisfies a TypeORM `where` built from equalities and
 *  `In(...)`, the only shapes these paths use. */
function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([field, expected]) => {
    const actual = (row as Record<string, unknown>)[field];
    if (expected instanceof FindOperator) {
      if (expected.type !== 'in') {
        throw new Error(`Unsupported operator ${expected.type} on ${field}`);
      }
      return (expected.value as unknown[]).includes(actual);
    }
    return actual === expected;
  });
}

function repository<Row extends object>(rows: () => Row[]) {
  const whereOf = (options?: { where?: Record<string, unknown> }) =>
    options?.where ?? {};
  return {
    find: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        rows().filter((row) => matchesWhere(row, whereOf(options))),
      ),
    ),
    findOne: jest.fn((options?: { where?: Record<string, unknown> }) =>
      Promise.resolve(
        rows().find((row) => matchesWhere(row, whereOf(options))) ?? null,
      ),
    ),
  };
}

/**
 * A realm-independent spelling of a render, for deep comparison. Jest runs
 * each spec in its own VM context, so a `structuredClone` copy carries that
 * context's prototypes and Node's own deep-equality helpers reject it
 * whatever its contents. This keeps every key, marks `undefined` so an absent
 * key and an undefined one stay apart, and sorts object keys.
 */
function canonical(value: unknown): unknown {
  if (value === undefined) {
    return '<undefined>';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Map) {
    return [
      '<map>',
      ...[...(value as Map<unknown, unknown>).entries()].map(
        ([mapKey, mapValue]) => [mapKey, canonical(mapValue)],
      ),
    ];
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  return Object.keys(value)
    .sort()
    .map((objectKey) => [
      objectKey,
      canonical((value as Record<string, unknown>)[objectKey]),
    ]);
}

function isSameRender(first: unknown, second: unknown): boolean {
  return JSON.stringify(canonical(first)) === JSON.stringify(canonical(second));
}

const FLOOR_CLAUSE = mailboxStaffHistoryFloorCoversPredicate(
  'parent.created_at',
  'seat',
);

interface World {
  core: MessagingCoreService;
  messages: Map<string, Message>;
}

interface WorldOptions {
  isAttributionOn: boolean;
  /** More staff seated on the listing mailbox, on its roster. */
  extraStaffIds?: string[];
  /** The off-roster seat joins the listing's roster after the first
   *  roster read, as a co-manager accepted mid-render would. */
  isRosterChangedAfterFirstRead?: boolean;
}

function buildWorld({
  isAttributionOn,
  extraStaffIds = [],
  isRosterChangedAfterFirstRead = false,
}: WorldOptions): World {
  const listingRoster = [...LISTING_ROSTER, ...extraStaffIds];
  let listingRosterReadCount = 0;
  const identities: Identity[] = [
    {
      id: LISTING_IDENTITY_ID,
      kind: IdentityKind.Listing,
      shouldShowStaffNames: isAttributionOn,
    },
    {
      id: CUSTOMER_IDENTITY_ID,
      kind: IdentityKind.Profile,
      userId: CUSTOMER_ID,
    },
    { id: SHARED_GROUP_IDENTITY_ID, kind: IdentityKind.Profile },
    {
      id: GROUP_SENDER_IDENTITY_ID,
      kind: IdentityKind.Profile,
      userId: GROUP_SENDER_ID,
    },
    { id: SHARED_PROFILE_IDENTITY_ID, kind: IdentityKind.Profile },
  ] as unknown as Identity[];
  const identityKindById = new Map(
    identities.map((identity) => [identity.id, identity.kind]),
  );

  const conversations = [
    {
      id: DIRECT_CONVERSATION_ID,
      kind: ConversationKind.Direct,
      isOfficial: false,
    },
    {
      id: GROUP_CONVERSATION_ID,
      kind: ConversationKind.Group,
      isOfficial: false,
    },
    {
      id: UNRESOLVED_CONVERSATION_ID,
      kind: ConversationKind.Direct,
      isOfficial: false,
    },
  ] as unknown as Conversation[];

  const seats = [
    seat(DIRECT_CONVERSATION_ID, CUSTOMER_ID, CUSTOMER_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, OWNER_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, FLOORED_CO_MANAGER_ID, LISTING_IDENTITY_ID, {
      clearedAt: HISTORY_FLOOR,
    }),
    seat(DIRECT_CONVERSATION_ID, PLAIN_CO_MANAGER_ID, LISTING_IDENTITY_ID),
    seat(
      DIRECT_CONVERSATION_ID,
      EARLY_FLOOR_CO_MANAGER_ID,
      LISTING_IDENTITY_ID,
      {
        clearedAt: EARLY_FLOOR,
      },
    ),
    seat(DIRECT_CONVERSATION_ID, HIDING_CO_MANAGER_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, SENDER_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, MODERATOR_CO_MANAGER_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, OFF_ROSTER_SEAT_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, REACTING_CO_MANAGER_ID, LISTING_IDENTITY_ID),
    seat(DIRECT_CONVERSATION_ID, STARRING_CO_MANAGER_ID, LISTING_IDENTITY_ID),
    ...extraStaffIds.map((userId) =>
      seat(DIRECT_CONVERSATION_ID, userId, LISTING_IDENTITY_ID),
    ),
    seat(GROUP_CONVERSATION_ID, GROUP_OWNER_ID, SHARED_GROUP_IDENTITY_ID, {
      role: ConversationRole.Owner,
    }),
    seat(GROUP_CONVERSATION_ID, GROUP_MEMBER_ID, SHARED_GROUP_IDENTITY_ID),
    seat(GROUP_CONVERSATION_ID, GROUP_SENDER_ID, GROUP_SENDER_IDENTITY_ID),
    seat(
      UNRESOLVED_CONVERSATION_ID,
      FIRST_SHARED_VIEWER_ID,
      SHARED_PROFILE_IDENTITY_ID,
    ),
    seat(
      UNRESOLVED_CONVERSATION_ID,
      SECOND_SHARED_VIEWER_ID,
      SHARED_PROFILE_IDENTITY_ID,
    ),
    seat(
      UNRESOLVED_CONVERSATION_ID,
      UNRESOLVED_SEAT_ID,
      UNRESOLVED_IDENTITY_ID,
    ),
    seat(
      UNRESOLVED_CONVERSATION_ID,
      SECOND_UNRESOLVED_SEAT_ID,
      UNRESOLVED_IDENTITY_ID,
    ),
  ];

  const customerPhotoParent = messageRow({
    id: 'parent-customer-photo',
    senderId: CUSTOMER_ID,
    senderIdentityId: CUSTOMER_IDENTITY_ID,
    kind: MessageKind.Image,
    createdAt: PRE_FLOOR,
    attachment: {
      url: CUSTOMER_PHOTO_KEY,
      previewUrl: CUSTOMER_PHOTO_KEY,
      width: 10,
      height: 10,
      provider: 'upload',
    },
  });
  const businessParent = messageRow({
    id: 'parent-business-text',
    senderId: OWNER_ID,
    body: 'An earlier business answer',
    createdAt: PRE_FLOOR,
  });
  const messageList: Message[] = [
    customerPhotoParent,
    businessParent,
    messageRow({ id: 'business-text', body: 'We open at nine' }),
    messageRow({
      id: BUSINESS_IMAGE_MESSAGE_ID,
      kind: MessageKind.Image,
      attachment: {
        url: SENDER_PHOTO_KEY,
        previewUrl: SENDER_PHOTO_KEY,
        width: 20,
        height: 20,
        provider: 'upload',
      },
    }),
    messageRow({
      id: 'reply-to-customer-photo',
      body: 'About this photo',
      replyToId: customerPhotoParent.id,
    }),
    messageRow({
      id: 'reply-to-business-parent',
      body: 'Following up',
      replyToId: businessParent.id,
    }),
    messageRow({
      id: 'edited-reacted-starred',
      body: 'Edited answer',
      editedAt: POST_FLOOR,
    }),
    messageRow({
      id: 'customer-text',
      senderId: CUSTOMER_ID,
      senderIdentityId: CUSTOMER_IDENTITY_ID,
      body: 'Is it accessible?',
    }),
    messageRow({
      id: 'system-member-added',
      // The author's account is erased, so the actor is nobody's own
      // message and the actor input stands apart from the author one.
      senderId: null,
      senderIdentityId: null,
      kind: MessageKind.System,
      systemEvent: {
        type: 'member_added',
        actorId: OWNER_ID,
        targetId: HIDING_CO_MANAGER_ID,
      },
    }),
    messageRow({
      id: 'moved-note',
      senderId: OWNER_ID,
      senderIdentityId: null,
      kind: MessageKind.System,
      systemEvent: {
        type: 'moved_to_business_mailbox',
        actorId: OWNER_ID,
        value: LISTING_IDENTITY_ID,
      },
    }),
    messageRow({
      id: 'group-text',
      conversationId: GROUP_CONVERSATION_ID,
      senderId: GROUP_SENDER_ID,
      senderIdentityId: GROUP_SENDER_IDENTITY_ID,
      body: 'Hello group',
    }),
    messageRow({
      id: 'unresolved-reacted',
      conversationId: UNRESOLVED_CONVERSATION_ID,
      senderId: UNRESOLVED_SEAT_ID,
      senderIdentityId: UNRESOLVED_IDENTITY_ID,
      body: 'From a seat that does not resolve',
    }),
  ];
  const messages = new Map(messageList.map((row) => [row.id, row]));

  const reactions = [
    {
      id: 'reaction-1',
      messageId: 'edited-reacted-starred',
      userId: REACTING_CO_MANAGER_ID,
      key: MessageReactionKey.Love,
    },
    {
      id: 'reaction-2',
      messageId: 'edited-reacted-starred',
      userId: CUSTOMER_ID,
      key: MessageReactionKey.Like,
    },
    {
      id: 'reaction-3',
      messageId: 'edited-reacted-starred',
      userId: OWNER_ID,
      key: MessageReactionKey.Love,
    },
    {
      id: 'reaction-4',
      messageId: 'unresolved-reacted',
      userId: UNRESOLVED_SEAT_ID,
      key: MessageReactionKey.Love,
    },
    {
      id: 'reaction-5',
      messageId: 'unresolved-reacted',
      userId: SECOND_UNRESOLVED_SEAT_ID,
      key: MessageReactionKey.Love,
    },
  ] as unknown as MessageReaction[];
  const stars = [
    {
      id: 'star-1',
      messageId: 'edited-reacted-starred',
      userId: STARRING_CO_MANAGER_ID,
    },
  ] as unknown as MessageStar[];
  const hides = [customerPhotoParent.id, businessParent.id].map(
    (messageId) => ({
      id: `hide-${messageId}`,
      messageId,
      userId: HIDING_CO_MANAGER_ID,
    }),
  ) as unknown as MessageHide[];
  // A moderator hid the business parent: platform staff still see it.
  const moderationRows = [
    {
      subjectType: 'message',
      subjectId: businessParent.id,
      hiddenAt: PRE_FLOOR,
      removedAt: null,
    },
  ] as unknown as ContentModeration[];
  const users = [
    ...MAILBOX_VIEWER_IDS,
    ...extraStaffIds,
    GROUP_OWNER_ID,
    GROUP_MEMBER_ID,
    GROUP_SENDER_ID,
    FIRST_SHARED_VIEWER_ID,
    SECOND_SHARED_VIEWER_ID,
    UNRESOLVED_SEAT_ID,
    SECOND_UNRESOLVED_SEAT_ID,
  ].map((userId) => ({
    id: userId,
    role:
      userId === MODERATOR_CO_MANAGER_ID ? UserRole.Moderator : UserRole.Member,
  }));
  const profiles = users.map((user, index) =>
    profile(user.id, `Person${index}`),
  );
  const preferences = [
    {
      id: 'preference-sender',
      identityId: LISTING_IDENTITY_ID,
      userId: SENDER_ID,
      shouldAllowNaming: true,
    },
  ] as unknown as IdentityStaffPreference[];

  const conversationRepository = repository(() => conversations);
  const messageRepository = {
    ...repository(() => [...messages.values()]),
    createQueryBuilder: jest.fn(() => {
      const parameters: Record<string, unknown> = {};
      const clauses: string[] = [];
      const query = {
        withDeleted: () => query,
        select: () => query,
        addSelect: () => query,
        innerJoin: (
          _entity: unknown,
          _alias: string,
          condition: string,
          joinParameters?: Record<string, unknown>,
        ) => {
          clauses.push(condition);
          Object.assign(parameters, joinParameters);
          return query;
        },
        where: (clause: string, whereParameters?: Record<string, unknown>) => {
          clauses.push(clause);
          Object.assign(parameters, whereParameters);
          return query;
        },
        andWhere: (clause: string) => {
          clauses.push(clause);
          return query;
        },
        getRawMany: () => {
          const seatIds = new Set<string>();
          for (const clause of clauses) {
            if (clause === 'seat.id = :viewerSeatId') {
              seatIds.add(parameters.viewerSeatId as string);
            } else if (clause === 'seat.id IN (:...viewerSeatIds)') {
              for (const seatId of parameters.viewerSeatIds as string[]) {
                seatIds.add(seatId);
              }
            } else if (
              clause !== 'parent.id IN (:...parentIds)' &&
              clause !== FLOOR_CLAUSE
            ) {
              throw new Error(`Unrecognised parent clause: ${clause}`);
            }
          }
          if (!clauses.includes(FLOOR_CLAUSE)) {
            throw new Error('The floor clause is missing');
          }
          const rows = seats
            .filter((candidate) => seatIds.has(candidate.id))
            .flatMap((candidate) => {
              const conversation = conversations.find(
                (row) => row.id === candidate.conversationId,
              )!;
              return (parameters.parentIds as string[])
                .map((parentId) => messages.get(parentId))
                .filter((parent): parent is Message => Boolean(parent))
                .filter((parent) =>
                  isCoveredByMailboxStaffFloor(parent.createdAt, {
                    clearedAt: candidate.clearedAt,
                    identityKind: identityKindById.get(candidate.identityId),
                    isGroupConversation:
                      conversation.kind === ConversationKind.Group,
                    isOfficialConversation: conversation.isOfficial,
                  }),
                )
                .map((parent) => ({
                  parentId: parent.id,
                  seatId: candidate.id,
                }));
            });
          return Promise.resolve(rows);
        },
      };
      return query;
    }),
  };
  const userRepository = repository(() => users);

  const identitiesService = {
    getById: jest.fn((identityId: string) =>
      Promise.resolve(
        identities.find((identity) => identity.id === identityId) ?? null,
      ),
    ),
    getByIds: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        identities.filter((identity) => identityIds.includes(identity.id)),
      ),
    ),
    describeIdentities: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        new Map(
          identityIds.includes(LISTING_IDENTITY_ID)
            ? [
                [
                  LISTING_IDENTITY_ID,
                  {
                    displayName: 'Cafe Lisboa',
                    handle: 'cafe-lisboa',
                    avatarUrl: null,
                  },
                ],
              ]
            : [],
        ),
      ),
    ),
    staffUserIds: jest.fn((identityId: string) => {
      const identity = identities.find(
        (candidate) => candidate.id === identityId,
      );
      if (!identity) {
        return Promise.resolve([]);
      }
      if (identity.kind === IdentityKind.Profile) {
        return Promise.resolve(identity.userId ? [identity.userId] : []);
      }
      const isFirstRosterRead = listingRosterReadCount === 0;
      listingRosterReadCount += 1;
      return Promise.resolve(
        isRosterChangedAfterFirstRead && !isFirstRosterRead
          ? [...listingRoster, OFF_ROSTER_SEAT_ID]
          : [...listingRoster],
      );
    }),
  };
  const identityAttribution = new IdentityAttributionService(
    repository(
      () => preferences,
    ) as unknown as Repository<IdentityStaffPreference>,
    identitiesService as unknown as IdentitiesService,
  );

  const core = new MessagingCoreService(
    conversationRepository as unknown as Repository<Conversation>,
    repository(() => seats) as unknown as Repository<ConversationParticipant>,
    messageRepository as unknown as Repository<Message>,
    repository(() => reactions) as unknown as Repository<MessageReaction>,
    repository(
      () => [] as ConversationPinnedMessage[],
    ) as unknown as Repository<ConversationPinnedMessage>,
    repository(() => stars) as unknown as Repository<MessageStar>,
    repository(() => hides) as unknown as Repository<MessageHide>,
    repository(
      () => moderationRows,
    ) as unknown as Repository<ContentModeration>,
    repository(() => profiles) as unknown as Repository<Profile>,
    {} as unknown as Repository<Sticker>,
    {
      getRepository: () => userRepository,
    } as unknown as DataSource,
    {} as unknown as EventEmitter2,
    {
      findById: jest.fn((userId: string) =>
        Promise.resolve(users.find((user) => user.id === userId) ?? null),
      ),
    } as unknown as UsersService,
    identitiesService as unknown as IdentitiesService,
    identityAttribution,
  );
  return { core, messages };
}

interface Scenario {
  messageId: string;
  viewerIds: string[];
  conversationKind: ConversationKind;
}

const MAILBOX_MESSAGE_IDS = [
  'business-text',
  BUSINESS_IMAGE_MESSAGE_ID,
  'reply-to-customer-photo',
  'reply-to-business-parent',
  'edited-reacted-starred',
  'customer-text',
  'system-member-added',
  'moved-note',
];

const SCENARIOS: Scenario[] = [
  ...MAILBOX_MESSAGE_IDS.map((messageId) => ({
    messageId,
    viewerIds: MAILBOX_VIEWER_IDS,
    conversationKind: ConversationKind.Direct,
  })),
  {
    messageId: 'group-text',
    viewerIds: [GROUP_OWNER_ID, GROUP_MEMBER_ID],
    conversationKind: ConversationKind.Group,
  },
  {
    messageId: 'unresolved-reacted',
    viewerIds: [FIRST_SHARED_VIEWER_ID, SECOND_SHARED_VIEWER_ID],
    conversationKind: ConversationKind.Direct,
  },
];

const WORLD_OPTIONS: WorldOptions[] = [
  { isAttributionOn: true },
  { isAttributionOn: false },
];

/** The per-viewer path: `toMessageResponses` once for each viewer. */
async function renderPerViewer(
  world: World,
  scenario: Scenario,
): Promise<Map<string, ViewerMessageResponse>> {
  const message = world.messages.get(scenario.messageId)!;
  const entries = await Promise.all(
    scenario.viewerIds.map(
      async (viewerId): Promise<[string, ViewerMessageResponse]> => {
        const [response] = await world.core.toMessageResponses(
          [message],
          viewerId,
          false,
          scenario.conversationKind,
        );
        return [viewerId, response!];
      },
    ),
  );
  return new Map(entries);
}

async function renderByClass(
  world: World,
  scenario: Scenario,
  keyComponents = VIEWER_RENDER_CLASS_KEY_COMPONENTS,
): Promise<Map<string, ViewerMessageResponse>> {
  const renderErrors: unknown[] = [];
  const rendered = await world.core.renderMessageForViewerClasses(
    world.messages.get(scenario.messageId)!,
    scenario.viewerIds,
    scenario.conversationKind,
    (error) => renderErrors.push(error),
    keyComponents,
  );
  expect(renderErrors).toEqual([]);
  return rendered;
}

describe('Final review I2: rendering a live message once per viewer class', () => {
  beforeEach(() => {
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe.each(WORLD_OPTIONS)(
    'with staff attribution on: $isAttributionOn',
    (worldOptions) => {
      it.each(SCENARIOS.map((scenario) => [scenario.messageId, scenario]))(
        'gives every viewer of %s exactly the per-viewer render',
        async (_messageId, scenario) => {
          const world = buildWorld(worldOptions);

          const expected = await renderPerViewer(world, scenario);
          const actual = await renderByClass(world, scenario);

          expect([...actual.keys()]).toEqual(scenario.viewerIds);
          expect(isSameRender(actual, expected)).toBe(true);
          for (const viewerId of scenario.viewerIds) {
            expect({ viewerId, response: actual.get(viewerId) }).toStrictEqual({
              viewerId,
              response: expected.get(viewerId),
            });
          }
        },
      );
    },
  );

  it('renders a customer and ten staff members in two renders', async () => {
    const extraStaffIds = Array.from(
      { length: 8 },
      (_unused, index) => `user-extra-staff-${index}`,
    );
    const world = buildWorld({ isAttributionOn: false, extraStaffIds });
    const scenario: Scenario = {
      messageId: 'business-text',
      viewerIds: [CUSTOMER_ID, OWNER_ID, PLAIN_CO_MANAGER_ID, ...extraStaffIds],
      conversationKind: ConversationKind.Direct,
    };
    const expected = await renderPerViewer(world, scenario);
    const renderSpy = jest.spyOn(world.core, 'toMessageResponses');

    const rendered = await renderByClass(world, scenario);

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(rendered).toStrictEqual(expected);
  });

  it('renders a lone viewer once, as the per-viewer path does', async () => {
    const world = buildWorld({ isAttributionOn: false });
    const scenario: Scenario = {
      messageId: 'reply-to-customer-photo',
      viewerIds: [FLOORED_CO_MANAGER_ID],
      conversationKind: ConversationKind.Direct,
    };
    const expected = await renderPerViewer(world, scenario);
    const renderSpy = jest.spyOn(world.core, 'toMessageResponses');

    const rendered = await renderByClass(world, scenario);

    expect(renderSpy).toHaveBeenCalledTimes(1);
    expect(isSameRender(rendered, expected)).toBe(true);
    expect(rendered).toStrictEqual(expected);
  });

  it('never gives the customer a staff name when the roster changes mid-render', async () => {
    const world = buildWorld({
      isAttributionOn: false,
      isRosterChangedAfterFirstRead: true,
    });

    // The off-roster seat is keyed first, so it reaches the identity
    // loader first.
    const rendered = await renderByClass(world, {
      messageId: 'business-text',
      viewerIds: [OFF_ROSTER_SEAT_ID, CUSTOMER_ID],
      conversationKind: ConversationKind.Direct,
    });

    expect(rendered.get(CUSTOMER_ID)?.sender).not.toHaveProperty(
      'staffFirstName',
    );
    // Both readers are judged against the one roster read the key used.
    expect(rendered.get(OFF_ROSTER_SEAT_ID)?.sender).not.toHaveProperty(
      'staffFirstName',
    );
  });

  it('gives each viewer an object of their own', async () => {
    const world = buildWorld({ isAttributionOn: true });
    const rendered = await renderByClass(world, {
      messageId: 'business-text',
      viewerIds: [OWNER_ID, PLAIN_CO_MANAGER_ID],
      conversationKind: ConversationKind.Direct,
    });

    expect(rendered.get(OWNER_ID)).toStrictEqual(
      rendered.get(PLAIN_CO_MANAGER_ID),
    );
    expect(rendered.get(OWNER_ID)).not.toBe(rendered.get(PLAIN_CO_MANAGER_ID));
  });

  // The scenario in which each component's pair of viewers meets: two
  // viewers who differ in that input alone.
  const PAIR_SCENARIO_BY_COMPONENT: Record<string, string> = {
    // The sender and a plain colleague.
    isolatedViewer: 'business-text',
    // A seat carrying the listing off its roster, and the customer.
    seatIdentity: 'business-text',
    // A group owner and a member on one shared identity.
    seatRole: 'group-text',
    // A moderator co-manager and a plain one.
    platformStaff: 'business-text',
    starred: 'edited-reacted-starred',
    ownReactions: 'edited-reacted-starred',
    // The co-manager who hid the quoted photo, and a plain one.
    hiddenReplyParents: 'reply-to-customer-photo',
    // The co-manager whose floor covers the quoted photo, and a plain one.
    flooredReplyParents: 'reply-to-customer-photo',
    // Rostered and off-roster seats of the listing, attribution off.
    attributionReader: 'business-text',
    systemEventActor: 'system-member-added',
    systemEventTarget: 'system-member-added',
  };

  it('names a pair scenario for every class key component', () => {
    expect(Object.keys(PAIR_SCENARIO_BY_COMPONENT).sort()).toEqual(
      VIEWER_RENDER_CLASS_KEY_COMPONENTS.map(({ name }) => name).sort(),
    );
  });

  describe('each class key component is needed', () => {
    it.each(VIEWER_RENDER_CLASS_KEY_COMPONENTS.map(({ name }) => [name]))(
      'mismatches the per-viewer render once %s is left out of the key',
      async (omittedComponentName) => {
        const keyComponents = VIEWER_RENDER_CLASS_KEY_COMPONENTS.filter(
          (component) => component.name !== omittedComponentName,
        );
        const mismatchedMessageIds = new Set<string>();
        for (const worldOptions of WORLD_OPTIONS) {
          for (const scenario of SCENARIOS) {
            const world = buildWorld(worldOptions);
            const expected = await renderPerViewer(world, scenario);
            const actual = await renderByClass(world, scenario, keyComponents);
            if (!isSameRender(actual, expected)) {
              mismatchedMessageIds.add(scenario.messageId);
            }
          }
        }

        expect([...mismatchedMessageIds]).toContain(
          PAIR_SCENARIO_BY_COMPONENT[omittedComponentName],
        );
      },
    );
  });
});

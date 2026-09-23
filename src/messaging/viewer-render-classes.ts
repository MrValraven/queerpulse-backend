import { In, Repository } from 'typeorm';
import { Identity, IdentityKind } from '../identities/entities/identity.entity';
import type {
  IdentityAttributionService,
  StaffNameResolverInputs,
} from '../identities/identity-attribution.service';
import type {
  IdentitiesService,
  IdentityDescription,
} from '../identities/identities.service';
import { User, UserRole } from '../users/entities/user.entity';
import {
  loadSenderIdentityContext,
  SenderIdentityContext,
} from './author-summary';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { MessageHide } from './entities/message-hide.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message, MessageKind } from './entities/message.entity';
import { mailboxStaffHistoryFloorCoversPredicate } from './mailbox-seats';
import type { MessageLike } from './messaging-core.service';
import {
  movedNoteMailboxIdentityIds,
  ViewerMessageResponse,
} from './viewer-message-fields';

/**
 * Final review I2: a live message on a business mailbox thread is rendered
 * once per class of viewers who would receive the same payload. Two
 * viewers share a class only when every per-viewer input
 * `MessagingCoreService.toMessageResponses` reads is identical for them,
 * so each viewer still receives exactly the payload their own call would
 * build. The inputs, and where that method reads each one:
 *
 * - the viewer's seat: its identity (kind, `isSentByViewer`, the moved
 *   note's actor, the official lookup, the delivered recipients) and its
 *   role (group pins);
 * - whether the viewer sent the message (`delivered`, `canEdit`,
 *   `canDelete`, `canReport`, `isSentByViewer`);
 * - platform staff role (moderation tombstones, quote withholding,
 *   `canDelete`);
 * - the viewer's own star and own reactions. The business reactions a
 *   viewer counts as one come from their seat's identity and the thread's
 *   seats, less the viewer's own seat, so two viewers with the same seat
 *   identity and the same own reactions always count alike;
 * - the viewer's own hide of the quoted parent;
 * - the quoted parents the viewer's mailbox staff history floor covers;
 * - the sender identities whose staff the viewer belongs to (the
 *   `StaffNameResolver` reader);
 * - whether the viewer is a system event's actor or target.
 *
 * A viewer who sent the message gets a class of their own. So does a
 * viewer holding more than one seat in the thread, which
 * `UQ_conversation_participants` (one seat per user per thread) rules out
 * today; the check is kept as a cheap guard should that ever change.
 *
 * The identity rows, their descriptions, each identity's staff and its
 * attribution preferences are loaded once per message and shared across
 * classes, since none of them depend on the viewer. The inputs are read
 * once, before the renders, so a star, reaction or hide a colleague adds
 * in between reaches that whole class the same way.
 */

/** What decides one viewer's render of one message. */
export interface ViewerRenderInputs {
  viewerId: string;
  seatCount: number;
  seatIdentityId: string | null;
  seatRole: string | null;
  isAuthor: boolean;
  isPlatformStaff: boolean;
  isStarred: boolean;
  ownReactionKeys: string[];
  hiddenReplyParentIds: string[];
  flooredReplyParentIds: string[];
  staffedSenderIdentityIds: string[];
  isSystemEventActor: boolean;
  isSystemEventTarget: boolean;
}

/** One named part of the class key. */
export interface ViewerRenderClassKeyComponent {
  name: string;
  read: (inputs: ViewerRenderInputs) => unknown;
}

/** Every part of the class key. Each one maps to an input listed above. */
export const VIEWER_RENDER_CLASS_KEY_COMPONENTS: ReadonlyArray<ViewerRenderClassKeyComponent> =
  [
    {
      name: 'isolatedViewer',
      read: (inputs) =>
        inputs.isAuthor || inputs.seatCount > 1 ? inputs.viewerId : null,
    },
    { name: 'seatIdentity', read: (inputs) => inputs.seatIdentityId },
    { name: 'seatRole', read: (inputs) => inputs.seatRole },
    { name: 'platformStaff', read: (inputs) => inputs.isPlatformStaff },
    { name: 'starred', read: (inputs) => inputs.isStarred },
    { name: 'ownReactions', read: (inputs) => inputs.ownReactionKeys },
    {
      name: 'hiddenReplyParents',
      read: (inputs) => inputs.hiddenReplyParentIds,
    },
    {
      name: 'flooredReplyParents',
      read: (inputs) => inputs.flooredReplyParentIds,
    },
    {
      name: 'attributionReader',
      read: (inputs) => inputs.staffedSenderIdentityIds,
    },
    { name: 'systemEventActor', read: (inputs) => inputs.isSystemEventActor },
    {
      name: 'systemEventTarget',
      read: (inputs) => inputs.isSystemEventTarget,
    },
  ];

/** The class key of one viewer, built from `components`. */
export function viewerRenderClassKey(
  inputs: ViewerRenderInputs,
  components: ReadonlyArray<ViewerRenderClassKeyComponent> = VIEWER_RENDER_CLASS_KEY_COMPONENTS,
): string {
  return JSON.stringify(
    components.map((component) => [component.name, component.read(inputs)]),
  );
}

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort();

/**
 * The sender identity context of one message, shared by every class that
 * renders it. The identity rows, their descriptions, each identity's staff
 * and the attribution preferences are read once per message. Every reader
 * gets a `StaffNameResolver` built with that reader, from those same rows,
 * and the class key reads the same staff lists, so a roster change during
 * the render can never make the key and a resolver disagree.
 */
export class SharedSenderIdentityContextLoader {
  private readonly describedByIdSet = new Map<
    string,
    Promise<{
      identities: Identity[];
      identityKindById: ReadonlyMap<string, IdentityKind>;
      identityDescriptionById: ReadonlyMap<string, IdentityDescription>;
    }>
  >();
  private readonly staffUserIdsByIdentityId = new Map<
    string,
    Promise<string[]>
  >();
  private readonly resolverInputsByIdSet = new Map<
    string,
    Promise<StaffNameResolverInputs>
  >();

  constructor(
    private readonly dependencies: {
      identities: Pick<
        IdentitiesService,
        'getByIds' | 'describeIdentities' | 'staffUserIds'
      >;
      identityAttribution: Pick<
        IdentityAttributionService,
        'buildStaffNameResolver' | 'loadStaffNameResolverInputs'
      >;
    },
  ) {}

  private describe(identityIds: ReadonlyArray<string>) {
    const uniqueIdentityIds = sortedUnique(identityIds);
    const idSetKey = uniqueIdentityIds.join(',');
    let described = this.describedByIdSet.get(idSetKey);
    if (!described) {
      described = Promise.all([
        this.dependencies.identities.getByIds(uniqueIdentityIds),
        this.dependencies.identities.describeIdentities(uniqueIdentityIds),
      ]).then(([identities, identityDescriptionById]) => ({
        identities,
        identityKindById: new Map(
          identities.map((identity: Identity) => [identity.id, identity.kind]),
        ),
        identityDescriptionById,
      }));
      this.describedByIdSet.set(idSetKey, described);
    }
    return described;
  }

  private staffUserIds(identityId: string): Promise<string[]> {
    let staff = this.staffUserIdsByIdentityId.get(identityId);
    if (!staff) {
      staff = this.dependencies.identities.staffUserIds(identityId);
      this.staffUserIdsByIdentityId.set(identityId, staff);
    }
    return staff;
  }

  /** The business, persona or company identities among `identityIds`
   *  whose staff include `readerUserId`, sorted. A profile identity or one
   *  that does not resolve gets no staff name for any reader, so it is left
   *  out. */
  async staffedIdentityIds(
    identityIds: ReadonlyArray<string>,
    readerUserId: string,
  ): Promise<string[]> {
    const { identityKindById } = await this.describe(identityIds);
    const mailboxIdentityIds = sortedUnique(identityIds).filter(
      (identityId) => {
        const kind = identityKindById.get(identityId);
        return kind !== undefined && kind !== IdentityKind.Profile;
      },
    );
    const staffLists = await Promise.all(
      mailboxIdentityIds.map((identityId) => this.staffUserIds(identityId)),
    );
    return mailboxIdentityIds.filter((_identityId, index) =>
      staffLists[index]!.includes(readerUserId),
    );
  }

  /** The resolver inputs for `identityIds`, read once: the identity rows
   *  and staff lists come from this loader's own reads. */
  private resolverInputs(
    identityIds: ReadonlyArray<string>,
  ): Promise<StaffNameResolverInputs> {
    const uniqueIdentityIds = sortedUnique(identityIds);
    const idSetKey = uniqueIdentityIds.join(',');
    let inputs = this.resolverInputsByIdSet.get(idSetKey);
    if (!inputs) {
      inputs = this.describe(uniqueIdentityIds).then(({ identities }) =>
        this.dependencies.identityAttribution.loadStaffNameResolverInputs(
          uniqueIdentityIds,
          {
            identities,
            staffUserIds: (identityId) => this.staffUserIds(identityId),
          },
        ),
      );
      this.resolverInputsByIdSet.set(idSetKey, inputs);
    }
    return inputs;
  }

  /** Drop-in for `loadSenderIdentityContext`, with the same result. */
  async load(
    identityIds: ReadonlyArray<string>,
    readerUserId: string,
  ): Promise<SenderIdentityContext> {
    const uniqueIdentityIds = [...new Set(identityIds)];
    const [described, resolverInputs] = await Promise.all([
      this.describe(uniqueIdentityIds),
      this.resolverInputs(uniqueIdentityIds),
    ]);
    return {
      identityKindById: described.identityKindById,
      identityDescriptionById: described.identityDescriptionById,
      staffNameResolver:
        await this.dependencies.identityAttribution.buildStaffNameResolver(
          uniqueIdentityIds,
          readerUserId,
          resolverInputs,
        ),
    };
  }
}

/** What `renderMessageByViewerClass` reads and calls. */
export interface ViewerClassRenderDependencies {
  participants: Pick<Repository<ConversationParticipant>, 'find'>;
  messages: Pick<Repository<Message>, 'find' | 'createQueryBuilder'>;
  reactions: Pick<Repository<MessageReaction>, 'find'>;
  stars: Pick<Repository<MessageStar>, 'find'>;
  hides: Pick<Repository<MessageHide>, 'find'>;
  users: Pick<Repository<User>, 'find'>;
  identities: Pick<
    IdentitiesService,
    'getByIds' | 'describeIdentities' | 'staffUserIds'
  >;
  identityAttribution: Pick<
    IdentityAttributionService,
    'buildStaffNameResolver' | 'loadStaffNameResolverInputs'
  >;
  /** `toMessageResponses` for one viewer, reading sender identities
   *  through `loadSenderIdentities`. */
  render: (
    message: MessageLike,
    viewerId: string,
    loadSenderIdentities: SharedSenderIdentityContextLoader['load'],
  ) => Promise<ViewerMessageResponse | undefined>;
}

/** Loads every viewer's {@link ViewerRenderInputs} for `message`, in a
 *  fixed number of batched queries whatever the viewer count. */
export async function loadViewerRenderInputs(
  dependencies: ViewerClassRenderDependencies,
  senderIdentities: SharedSenderIdentityContextLoader,
  message: MessageLike,
  viewerIds: ReadonlyArray<string>,
): Promise<ViewerRenderInputs[]> {
  const replyIds = message.replyToId ? [message.replyToId] : [];
  const [seats, users, starRows, reactionRows, loadedParents, hideRows] =
    await Promise.all([
      dependencies.participants.find({
        where: { conversationId: message.conversationId },
      }),
      dependencies.users.find({
        select: { id: true, role: true },
        where: { id: In([...viewerIds]) },
      }),
      dependencies.stars.find({
        where: { userId: In([...viewerIds]), messageId: message.id },
      }),
      dependencies.reactions.find({ where: { messageId: message.id } }),
      replyIds.length
        ? dependencies.messages.find({
            where: { id: In(replyIds) },
            withDeleted: true,
          })
        : Promise.resolve([] as Message[]),
      replyIds.length
        ? dependencies.hides.find({
            where: { userId: In([...viewerIds]), messageId: In(replyIds) },
          })
        : Promise.resolve([] as MessageHide[]),
    ]);
  // A parent from another conversation renders as a missing parent in
  // `toMessageResponses`, so it adds no sender identity or floored parent to
  // any viewer's class key either.
  const parents = loadedParents.filter(
    (parent) => parent.conversationId === message.conversationId,
  );

  const firstSeatByUserId = new Map<string, ConversationParticipant>();
  const seatCountByUserId = new Map<string, number>();
  for (const seat of seats) {
    if (!firstSeatByUserId.has(seat.userId)) {
      firstSeatByUserId.set(seat.userId, seat);
    }
    seatCountByUserId.set(
      seat.userId,
      (seatCountByUserId.get(seat.userId) ?? 0) + 1,
    );
  }

  // The same floor rule `toMessageResponses` applies to its viewer's seat,
  // asked once for every floored seat in the audience.
  const flooredSeatIds = viewerIds
    .map((viewerId) => firstSeatByUserId.get(viewerId))
    .filter((seat): seat is ConversationParticipant =>
      Boolean(seat?.historyFloorAt),
    )
    .map((seat) => seat.id);
  const flooredParentRows =
    parents.length > 0 && flooredSeatIds.length > 0
      ? await dependencies.messages
          .createQueryBuilder('parent')
          .withDeleted()
          .select('parent.id', 'parentId')
          .addSelect('seat.id', 'seatId')
          .innerJoin(
            ConversationParticipant,
            'seat',
            'seat.id IN (:...viewerSeatIds)',
            { viewerSeatIds: flooredSeatIds },
          )
          .where('parent.id IN (:...parentIds)', {
            parentIds: parents.map((parent) => parent.id),
          })
          .andWhere(
            mailboxStaffHistoryFloorCoversPredicate(
              'parent.created_at',
              'seat',
            ),
          )
          .getRawMany<{ parentId: string; seatId: string }>()
      : [];

  const senderIdentityIds = [
    ...[message, ...parents]
      .map((row) => row.senderIdentityId)
      .filter((identityId): identityId is string => identityId != null),
    ...movedNoteMailboxIdentityIds([message]),
  ];
  const staffedSenderIdentityIds = await Promise.all(
    viewerIds.map((viewerId) =>
      senderIdentities.staffedIdentityIds(senderIdentityIds, viewerId),
    ),
  );

  const roleByUserId = new Map(users.map((user) => [user.id, user.role]));
  const systemEvent =
    message.kind === MessageKind.System ? message.systemEvent : null;
  return viewerIds.map((viewerId, index): ViewerRenderInputs => {
    const seat = firstSeatByUserId.get(viewerId);
    const role = roleByUserId.get(viewerId);
    return {
      viewerId,
      seatCount: seatCountByUserId.get(viewerId) ?? 0,
      seatIdentityId: seat?.identityId ?? null,
      seatRole: seat?.role ?? null,
      isAuthor: message.senderId === viewerId,
      isPlatformStaff: role === UserRole.Admin || role === UserRole.Moderator,
      isStarred: starRows.some((star) => star.userId === viewerId),
      ownReactionKeys: sortedUnique(
        reactionRows
          .filter((reaction) => reaction.userId === viewerId)
          .map((reaction) => reaction.key),
      ),
      hiddenReplyParentIds: sortedUnique(
        hideRows
          .filter((hide) => hide.userId === viewerId)
          .map((hide) => hide.messageId),
      ),
      flooredReplyParentIds: sortedUnique(
        flooredParentRows
          .filter((row) => row.seatId === seat?.id)
          .map((row) => row.parentId),
      ),
      staffedSenderIdentityIds: staffedSenderIdentityIds[index]!,
      isSystemEventActor: systemEvent?.actorId === viewerId,
      isSystemEventTarget: systemEvent?.targetId === viewerId,
    };
  });
}

/**
 * `message` rendered for every viewer in `viewerIds`, once per class of
 * viewers built from `keyComponents`. Each viewer gets their own copy of
 * their class's payload. A class whose render throws is reported through
 * `onRenderError` and left out, so nobody receives a payload rendered for
 * another class; a failure to load the inputs leaves every viewer out the
 * same way. The result keeps `viewerIds`' order.
 */
export async function renderMessageByViewerClass(
  dependencies: ViewerClassRenderDependencies,
  message: MessageLike,
  viewerIds: ReadonlyArray<string>,
  onRenderError: (error: unknown) => void,
  keyComponents: ReadonlyArray<ViewerRenderClassKeyComponent> = VIEWER_RENDER_CLASS_KEY_COMPONENTS,
): Promise<Map<string, ViewerMessageResponse>> {
  const uniqueViewerIds = [...new Set(viewerIds)];
  if (uniqueViewerIds.length === 0) {
    return new Map();
  }
  const senderIdentities = new SharedSenderIdentityContextLoader(dependencies);
  const loadSenderIdentities: SharedSenderIdentityContextLoader['load'] = (
    identityIds,
    readerUserId,
  ) => senderIdentities.load(identityIds, readerUserId);
  // One viewer is one class, so the inputs that tell classes apart are
  // never read, and nothing is shared.
  if (uniqueViewerIds.length === 1) {
    const [viewerId] = uniqueViewerIds as [string];
    try {
      const response = await dependencies.render(
        message,
        viewerId,
        (identityIds, readerUserId) =>
          loadSenderIdentityContext(dependencies, identityIds, readerUserId),
      );
      return new Map(response ? [[viewerId, response]] : []);
    } catch (error) {
      onRenderError(error);
      return new Map();
    }
  }
  let inputs: ViewerRenderInputs[];
  try {
    inputs = await loadViewerRenderInputs(
      dependencies,
      senderIdentities,
      message,
      uniqueViewerIds,
    );
  } catch (error) {
    onRenderError(error);
    return new Map();
  }
  const viewerIdsByClassKey = new Map<string, string[]>();
  for (const viewerInputs of inputs) {
    const classKey = viewerRenderClassKey(viewerInputs, keyComponents);
    viewerIdsByClassKey.set(classKey, [
      ...(viewerIdsByClassKey.get(classKey) ?? []),
      viewerInputs.viewerId,
    ]);
  }
  const responseByViewerId = new Map<string, ViewerMessageResponse>();
  await Promise.all(
    [...viewerIdsByClassKey.values()].map(async (classViewerIds) => {
      try {
        const response = await dependencies.render(
          message,
          classViewerIds[0]!,
          loadSenderIdentities,
        );
        if (!response) {
          return;
        }
        for (const viewerId of classViewerIds) {
          responseByViewerId.set(viewerId, structuredClone(response));
        }
      } catch (error) {
        onRenderError(error);
      }
    }),
  );
  return new Map(
    uniqueViewerIds.flatMap((viewerId): [string, ViewerMessageResponse][] => {
      const response = responseByViewerId.get(viewerId);
      return response ? [[viewerId, response]] : [];
    }),
  );
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { toVisibleAvatarUrl } from '../common/member-ref';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { ConnectionsService } from '../connections/connections.service';
import { Event } from '../events/entities/event.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { FeedbackDto } from './dto/feedback.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import {
  MEET_AGAIN_VERDICTS,
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import type { GoTogetherFeedbackResponse } from './go-together-group-response';
import {
  GROUP_PROFILE_COLUMNS,
  feedbackWindow,
} from './go-together-group.service';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

function isMeetAgainVerdict(value: unknown): value is MeetAgainVerdict {
  return (MEET_AGAIN_VERDICTS as readonly unknown[]).includes(value);
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: unknown } | undefined;
  return driverError?.code === UNIQUE_VIOLATION;
}

function invalidFeedback(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message,
    code: 'GO_TOGETHER_INVALID_FEEDBACK',
  });
}

/** The other grouped members of a group, each with their profile. */
interface GroupPeer {
  userId: string;
  profile: Profile;
}

/**
 * The private "meet again?" answers after a gathering. A "No" is a permanent
 * avoidance read as a hard filter in every later pool; a mutual "Yes" becomes
 * a connection, unless a block or an earlier decision between the two says
 * otherwise. No answer is ever shown to the member it is about.
 */
@Injectable()
export class GoTogetherFeedbackService {
  private readonly logger = new Logger(GoTogetherFeedbackService.name);

  constructor(
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(EventMatchGroup)
    private readonly groups: Repository<EventMatchGroup>,
    @InjectRepository(EventMatchConfig)
    private readonly configs: Repository<EventMatchConfig>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(MatchFeedback)
    private readonly feedback: Repository<MatchFeedback>,
    @InjectRepository(MatchGroupFeedback)
    private readonly groupFeedback: Repository<MatchGroupFeedback>,
    @InjectRepository(MatchAvoidance)
    private readonly avoidances: Repository<MatchAvoidance>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly connections: ConnectionsService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(
    groupId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<GoTogetherFeedbackResponse> {
    const group = await this.loadGroupAsMember(groupId, userId);
    const [config, peers, verdictRows, groupAnswer] = await Promise.all([
      this.configs.findOne({ where: { eventId: group.eventId } }),
      this.loadPeers(groupId, userId),
      this.feedback.find({ where: { groupId, raterId: userId } }),
      this.groupFeedback.findOne({ where: { groupId, raterId: userId } }),
    ]);
    const verdictByRateeId = new Map(
      verdictRows.map((row) => [row.rateeId, row.verdict]),
    );
    const feedbackState = feedbackWindow(config, now);
    return {
      groupId,
      isOpen: feedbackState.isOpen,
      closesAt: feedbackState.closesAt?.toISOString() ?? null,
      members: peers.map(({ userId: peerId, profile }) => ({
        slug: profile.slug,
        firstName: profile.firstName,
        pronouns: profile.pronouns,
        avatarUrl: toVisibleAvatarUrl(profile),
        verdict: verdictByRateeId.get(peerId) ?? null,
      })),
      clicked: groupAnswer?.clicked ?? null,
      goAgain: groupAnswer?.goAgain ?? false,
    };
  }

  async put(
    groupId: string,
    userId: string,
    dto: FeedbackDto,
    now: Date = new Date(),
  ): Promise<GoTogetherFeedbackResponse> {
    const group = await this.loadGroupAsMember(groupId, userId);
    const config = await this.configs.findOne({
      where: { eventId: group.eventId },
    });
    if (!feedbackWindow(config, now).isOpen) {
      throw new ConflictException({
        statusCode: 409,
        message: 'The questions for this gathering have closed',
        code: 'GO_TOGETHER_FEEDBACK_CLOSED',
      });
    }

    const verdicts = await this.parseVerdicts(groupId, userId, dto.verdicts);
    for (const { rateeId, verdict } of verdicts) {
      await this.feedback.upsert(
        { groupId, raterId: userId, rateeId, verdict },
        ['groupId', 'raterId', 'rateeId'],
      );
      if (verdict === 'no') {
        await this.avoidances
          .createQueryBuilder()
          .insert()
          .into(MatchAvoidance)
          .values({ userId, avoidedUserId: rateeId })
          .orIgnore()
          .execute();
      } else {
        await this.avoidances.delete({ userId, avoidedUserId: rateeId });
      }
      if (verdict === 'yes') {
        await this.connectIfMutual(group, userId, rateeId);
      }
    }

    if (dto.clicked !== undefined || dto.goAgain !== undefined) {
      const existing = await this.groupFeedback.findOne({
        where: { groupId, raterId: userId },
      });
      await this.groupFeedback.upsert(
        {
          groupId,
          raterId: userId,
          clicked: dto.clicked ?? existing?.clicked ?? null,
          goAgain: dto.goAgain ?? existing?.goAgain ?? false,
        },
        ['groupId', 'raterId'],
      );
    }

    return this.get(groupId, userId, now);
  }

  /** Every verdict key must be another grouped member's slug and every value
   *  one of the three answers; one bad pair rejects the whole request. */
  private async parseVerdicts(
    groupId: string,
    userId: string,
    verdicts: Record<string, string> | undefined,
  ): Promise<{ rateeId: string; verdict: MeetAgainVerdict }[]> {
    const pairs = Object.entries(verdicts ?? {});
    if (pairs.length === 0) return [];
    const peers = await this.loadPeers(groupId, userId);
    const userIdBySlug = new Map(
      peers.map((peer) => [peer.profile.slug, peer.userId]),
    );
    return pairs.map(([slug, verdict]) => {
      const rateeId = userIdBySlug.get(slug);
      if (!rateeId) {
        throw invalidFeedback(
          'You can only answer about members of your group',
        );
      }
      if (!isMeetAgainVerdict(verdict)) {
        throw invalidFeedback('Answer yes, maybe or no');
      }
      return { rateeId, verdict };
    });
  }

  /** When the other member already said Yes too, connect the two and tell
   *  both, each with the other as the actor. */
  private async connectIfMutual(
    group: EventMatchGroup,
    userId: string,
    rateeId: string,
  ): Promise<void> {
    const reverse = await this.feedback.findOne({
      where: { groupId: group.id, raterId: rateeId, rateeId: userId },
    });
    if (reverse?.verdict !== 'yes') return;
    if (!(await this.establishConnection(userId, rateeId))) return;
    const event = await this.events.findOne({ where: { id: group.eventId } });
    const recipients: { recipientId: string; otherUserId: string }[] = [
      { recipientId: userId, otherUserId: rateeId },
      { recipientId: rateeId, otherUserId: userId },
    ];
    for (const { recipientId, otherUserId } of recipients) {
      try {
        await this.notifications.create(
          recipientId,
          NotificationType.GoTogetherMutual,
          {
            eventId: group.eventId,
            eventSlug: event?.slug ?? null,
            eventTitle: event?.title ?? null,
            groupId: group.id,
            actorId: otherUserId,
          },
          otherUserId,
        );
      } catch (error) {
        this.logger.error(
          `Go together mutual notice failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  /**
   * Makes the two members connected, in one transaction. Returns true only
   * when this call created the connection or accepted a pending request. A
   * block either way, or an accepted, declined or blocked row, leaves
   * everything as it is and returns false, so a mutual Yes never overrides
   * someone's earlier decision. A lost race on the unique pair also returns
   * false: the other request already connected them.
   */
  private async establishConnection(
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    // The canonical pair, the same least/greatest rule ConnectionsService uses.
    const [userLow, userHigh] =
      firstUserId < secondUserId
        ? [firstUserId, secondUserId]
        : [secondUserId, firstUserId];
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (
          await this.blockFilter.isBlockedEitherWay(firstUserId, secondUserId)
        ) {
          return false;
        }
        const existing = await manager.findOne(Connection, {
          where: { userLow, userHigh },
        });
        if (!existing) {
          return this.connections.createConnectionInTransaction(
            manager,
            firstUserId,
            secondUserId,
          );
        }
        if (existing.status !== ConnectionStatus.Pending) return false;
        const accepted = await manager.update(
          Connection,
          { id: existing.id, status: ConnectionStatus.Pending },
          { status: ConnectionStatus.Accepted, respondedAt: new Date() },
        );
        return (accepted.affected ?? 0) > 0;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async loadGroupAsMember(
    groupId: string,
    userId: string,
  ): Promise<EventMatchGroup> {
    const entry = await this.entries.findOne({
      where: { groupId, userId, status: 'grouped' },
    });
    const group = entry
      ? await this.groups.findOne({ where: { id: groupId } })
      : null;
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  private async loadPeers(
    groupId: string,
    userId: string,
  ): Promise<GroupPeer[]> {
    const groupedEntries = await this.entries.find({
      where: { groupId, status: 'grouped' },
      order: { createdAt: 'ASC' },
    });
    const groupmateIds = groupedEntries
      .map((entry) => entry.userId)
      .filter((peerId) => peerId !== userId);
    // A block between the two, even one placed after the gathering, takes the
    // other member off this page: nothing to answer about them.
    const blockedUserIds = await this.blockFilter.blockedUserIds(
      userId,
      groupmateIds,
    );
    const peerIds = groupmateIds.filter(
      (peerId) => !blockedUserIds.has(peerId),
    );
    if (peerIds.length === 0) return [];
    const profileRows = await this.profiles.find({
      where: { userId: In(peerIds) },
      select: GROUP_PROFILE_COLUMNS,
    });
    const profileByUserId = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const peers: GroupPeer[] = [];
    for (const peerId of peerIds) {
      const profile = profileByUserId.get(peerId);
      if (profile) peers.push({ userId: peerId, profile });
    }
    return peers;
  }
}

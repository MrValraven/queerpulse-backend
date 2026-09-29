import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import type { CheckInStatus } from './dto/check-in.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { MatchFeedback } from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { GoTogetherFormationService } from './go-together-formation.service';
import type {
  GoTogetherGroupMember,
  GoTogetherGroupResponse,
} from './go-together-group-response';

const HOUR_MS = 60 * 60 * 1000;
/** Check-in opens this long before the gathering starts. */
export const CHECK_IN_OPENS_BEFORE_MS = 3 * HOUR_MS;
/** A gathering with no end time is treated as lasting this long. */
export const ASSUMED_EVENT_LENGTH_MS = 6 * HOUR_MS;
/** Check-in stays open this long after the gathering ends. */
export const CHECK_IN_CLOSES_AFTER_MS = 6 * HOUR_MS;
/** The meet-again questions stay open this long after the prompt. The one
 *  definition: the card, the group, the feedback page and the close pass all
 *  read it. */
export const FEEDBACK_WINDOW_MS = 7 * 24 * HOUR_MS;

/** The profile columns a group card shows: first name and pronouns only. */
export const GROUP_PROFILE_COLUMNS: (keyof Profile)[] = [
  'userId',
  'slug',
  'firstName',
  'pronouns',
  'avatarUrl',
  'photoVisible',
];

export function isCheckInOpen(
  event: Pick<Event, 'startAt' | 'endAt'>,
  now: Date,
): boolean {
  const opensAt = event.startAt.getTime() - CHECK_IN_OPENS_BEFORE_MS;
  const endsAt =
    event.endAt?.getTime() ?? event.startAt.getTime() + ASSUMED_EVENT_LENGTH_MS;
  const closesAt = endsAt + CHECK_IN_CLOSES_AFTER_MS;
  return now.getTime() >= opensAt && now.getTime() <= closesAt;
}

/** The feedback window opens at the prompt and lasts seven days. */
export function feedbackWindow(
  config: Pick<EventMatchConfig, 'feedbackPromptedAt'> | null,
  now: Date,
): { isOpen: boolean; closesAt: Date | null } {
  const promptedAt = config?.feedbackPromptedAt ?? null;
  if (!promptedAt) return { isOpen: false, closesAt: null };
  const closesAt = new Date(promptedAt.getTime() + FEEDBACK_WINDOW_MS);
  return {
    isOpen:
      now.getTime() >= promptedAt.getTime() &&
      now.getTime() < closesAt.getTime(),
    closesAt,
  };
}

function groupNotFound(): NotFoundException {
  return new NotFoundException('Group not found');
}

/**
 * A formed group as its members see it: the card, check-in, leaving and
 * accepting a merge offer. Only a member currently grouped in the group can
 * read or act on it; everyone else, a former member included, gets a 404.
 */
@Injectable()
export class GoTogetherGroupService {
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
    private readonly formation: GoTogetherFormationService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async getGroup(
    groupId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<GoTogetherGroupResponse> {
    const callerEntry = await this.findGroupedEntry(groupId, userId);
    const group = await this.groups.findOne({ where: { id: groupId } });
    if (!group) throw groupNotFound();
    const [event, seatedEntries, config, hasAnsweredMembers, hasAnsweredGroup] =
      await Promise.all([
        this.events.findOne({ where: { id: group.eventId } }),
        this.entries.find({
          where: { groupId, status: 'grouped' },
          order: { createdAt: 'ASC' },
        }),
        this.configs.findOne({ where: { eventId: group.eventId } }),
        this.feedback.exists({ where: { groupId, raterId: userId } }),
        this.groupFeedback.exists({ where: { groupId, raterId: userId } }),
      ]);
    if (!event) throw groupNotFound();
    // A block that lands too late to move anyone (after the gathering) still
    // hides the two from each other on the card.
    const blockedUserIds = await this.blockFilter.blockedUserIds(
      userId,
      seatedEntries.map((entry) => entry.userId),
    );
    const groupedEntries = seatedEntries.filter(
      (entry) => !blockedUserIds.has(entry.userId),
    );

    const profileRows = groupedEntries.length
      ? await this.profiles.find({
          where: { userId: In(groupedEntries.map((entry) => entry.userId)) },
          select: GROUP_PROFILE_COLUMNS,
        })
      : [];
    const profileByUserId = new Map(
      profileRows.map((profile) => [profile.userId, profile]),
    );
    const partnerId =
      callerEntry.pairStatus === 'accepted' ? callerEntry.pairPartnerId : null;
    const members: GoTogetherGroupMember[] = [];
    for (const entry of groupedEntries) {
      const profile = profileByUserId.get(entry.userId);
      if (!profile) continue;
      members.push({
        slug: profile.slug,
        firstName: profile.firstName,
        pronouns: profile.pronouns,
        avatarUrl: toVisibleAvatarUrl(profile),
        isYou: entry.userId === userId,
        isPairPartner: partnerId !== null && entry.userId === partnerId,
        ...checkInFlags(entry),
      });
    }
    const feedbackState = feedbackWindow(config, now);

    return {
      id: group.id,
      event: {
        id: event.id,
        slug: event.slug,
        title: event.title,
        startAt: event.startAt.toISOString(),
        endAt: event.endAt?.toISOString() ?? null,
      },
      band: group.band,
      reasons: group.reasons,
      meetingPointNote: config?.meetingPointNote ?? null,
      conversationId: group.conversationId,
      isDissolved: group.dissolvedAt !== null,
      members,
      mergeOffer: callerEntry.mergeOfferGroupId
        ? { groupId: callerEntry.mergeOfferGroupId }
        : null,
      checkIn: {
        isOpen: isCheckInOpen(event, now),
        ...checkInFlags(callerEntry),
      },
      feedback: {
        isOpen: feedbackState.isOpen,
        closesAt: feedbackState.closesAt?.toISOString() ?? null,
        hasAnswered: hasAnsweredMembers || hasAnsweredGroup,
      },
    };
  }

  /** "I'm here" or "I've left". Stored on the entry only; nothing is posted
   *  in the chat (spec delta 5). */
  async checkIn(
    groupId: string,
    userId: string,
    status: CheckInStatus,
    now: Date = new Date(),
  ): Promise<GoTogetherGroupResponse> {
    const entry = await this.findGroupedEntry(groupId, userId);
    const event = await this.events.findOne({ where: { id: entry.eventId } });
    if (!event) throw groupNotFound();
    if (!isCheckInOpen(event, now)) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Check-in is not open for this gathering',
        code: 'GO_TOGETHER_CHECKIN_CLOSED',
      });
    }
    await this.entries.update(
      { id: entry.id },
      status === 'here'
        ? { checkedInAt: now, leftEventAt: null }
        : { leftEventAt: now },
    );
    return this.getGroup(groupId, userId, now);
  }

  async leave(groupId: string, userId: string): Promise<void> {
    const entry = await this.findGroupedEntry(groupId, userId);
    await this.formation.removeMember(entry);
  }

  async acceptMerge(
    groupId: string,
    userId: string,
  ): Promise<GoTogetherGroupResponse> {
    const entry = await this.entries.findOne({
      where: {
        groupId,
        userId,
        status: 'grouped',
        mergeOfferGroupId: Not(IsNull()),
      },
    });
    const targetGroupId = entry?.mergeOfferGroupId;
    if (!entry || !targetGroupId) {
      throw new NotFoundException('No merge offer to accept');
    }
    await this.formation.acceptMerge(entry);
    return this.getGroup(targetGroupId, userId);
  }

  private async findGroupedEntry(
    groupId: string,
    userId: string,
  ): Promise<EventMatchEntry> {
    const entry = await this.entries.findOne({
      where: { groupId, userId, status: 'grouped' },
    });
    if (!entry) throw groupNotFound();
    return entry;
  }
}

function checkInFlags(
  entry: Pick<EventMatchEntry, 'checkedInAt' | 'leftEventAt'>,
): { isHere: boolean; hasLeftEvent: boolean } {
  return {
    isHere: entry.checkedInAt !== null && entry.leftEventAt === null,
    hasLeftEvent: entry.leftEventAt !== null,
  };
}

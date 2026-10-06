import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { toVisibleAvatarUrl } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import { ReportSubjectType } from '../reports/entities/report.entity';
import type { ReportDTO } from '../reports/report-response';
import { ReportsService } from '../reports/reports.service';
import { BlockFilterService } from '../social/block-filter.service';
import type { BlockOptionsDto } from '../social/dto/block-options.dto';
import { SocialService } from '../social/social.service';
import { Profile } from '../users/entities/profile.entity';
import type { CheckInStatus } from './dto/check-in.dto';
import type { GroupMemberReportDto } from './dto/group-member-report.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { MatchFeedback } from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { hasGatheringStarted } from './go-together-formation.helpers';
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

function memberNotFound(): NotFoundException {
  return new NotFoundException('Member not found');
}

/** A filed report as the group sheet gets it back: everything `POST
 *  /reports` answers except the subject, which here is the member's user id
 *  and never leaves the server. */
export type GroupMemberReportResponse = Omit<ReportDTO, 'subjectId'>;

/**
 * A formed group as its members see it: the card, check-in, leaving and
 * accepting a merge offer. Only a member currently grouped in the group can
 * read or act on it; everyone else, a former member included, gets a 404.
 */
@Injectable()
export class GoTogetherGroupService {
  private readonly logger = new Logger(GoTogetherGroupService.name);

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
    private readonly social: SocialService,
    private readonly reports: ReportsService,
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
        memberRef: entry.id,
        firstName: profile.firstName,
        pronouns: profile.pronouns,
        avatarUrl: toVisibleAvatarUrl(profile),
        isYou: entry.userId === userId,
        isPairPartner: partnerId !== null && entry.userId === partnerId,
        ...checkInFlags(entry),
      });
    }
    const feedbackState = feedbackWindow(config, now);
    const hasLeftChat = group.conversationId
      ? await this.formation.hasLeftChat(group.conversationId, userId)
      : false;

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
      isLeaveChatOnly: hasGatheringStarted(event, now),
      hasLeftChat,
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

  /** PRD-418: before the gathering starts the member leaves the group;
   *  from the start onward only the chat (`isLeaveChatOnly` on the card). */
  async leave(
    groupId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const entry = await this.findGroupedEntry(groupId, userId);
    await this.formation.leaveGroup(entry, now);
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

  /**
   * PRD-421: Block from the group sheet. `memberRef` resolves to a member
   * seated in this group, server side, and the ordinary person block runs
   * for them (`SocialService.blockMember`, the service behind
   * `POST /blocks/:slug`) with the same optional body: the same
   * `MEMBER_BLOCKED` event and the same companion report on `alsoReport`.
   *
   * The event's listener is not awaited by the block, so this route then
   * awaits the move out of the group itself (`moveAfterBlock`, the step the
   * listener runs), and the sheet's refetch right after the answer already
   * sees the blocker gone. The listener's own run for the same block then
   * finds the pair apart and changes nothing. A failed move is logged and
   * the block stands. Nothing about the member comes back.
   */
  async blockMember(
    groupId: string,
    userId: string,
    memberRef: string,
    options?: BlockOptionsDto,
  ): Promise<void> {
    const target = await this.resolveGroupMember(groupId, userId, memberRef);
    const profile = await this.profiles.findOne({
      where: { userId: target.userId },
      select: { userId: true, slug: true },
    });
    if (!profile) throw memberNotFound();
    // PRD-423: the block remembers the matched chat the group talks in, so
    // the block list names this member by first name alone, the only name
    // the group ever showed.
    const group = await this.groups.findOne({
      where: { id: groupId },
      select: { id: true, conversationId: true },
    });
    await this.social.blockMember(userId, profile.slug, options, {
      matchedConversationId: group?.conversationId ?? null,
    });
    try {
      await this.formation.moveAfterBlock(
        target.eventId,
        userId,
        target.userId,
      );
    } catch (error) {
      this.logger.error(
        `Go together could not move the blocker out of group ${groupId}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /**
   * PRD-421: Report from the group sheet. `memberRef` resolves to a member
   * seated in this group, server side, and the report is filed through the
   * ordinary pipeline (`ReportsService.create`, the service behind
   * `POST /reports`) as a `member` subject addressed by user id, so its
   * flood caps, severity and moderation queue are the usual ones.
   */
  async reportMember(
    groupId: string,
    userId: string,
    memberRef: string,
    report: GroupMemberReportDto,
  ): Promise<GroupMemberReportResponse> {
    const target = await this.resolveGroupMember(groupId, userId, memberRef);
    const filed = await this.reports.create(userId, {
      reasonCode: report.reasonCode,
      detail: report.detail,
      anonymous: report.anonymous,
      evidence: report.evidence,
      subjectType: ReportSubjectType.Member,
      subjectId: target.userId,
    });
    return {
      id: filed.id,
      subjectType: filed.subjectType,
      reasonCode: filed.reasonCode,
      severity: filed.severity,
      status: filed.status,
      createdAt: filed.createdAt,
      slaDueAt: filed.slaDueAt,
      acknowledgement: filed.acknowledgement,
    };
  }

  /** The member behind `memberRef` (their entry id), seated in the group
   *  the caller is seated in. A non-member caller gets the usual 404, an
   *  unknown or departed member a 404 of their own, and the caller's own
   *  ref a 400. */
  private async resolveGroupMember(
    groupId: string,
    userId: string,
    memberRef: string,
  ): Promise<EventMatchEntry> {
    await this.findGroupedEntry(groupId, userId);
    const target = await this.entries.findOne({
      where: { id: memberRef, groupId, status: 'grouped' },
    });
    if (!target) throw memberNotFound();
    if (target.userId === userId) {
      throw new BadRequestException('You cannot target yourself');
    }
    return target;
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

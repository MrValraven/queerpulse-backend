import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineDeck } from '../magazine/entities/magazine-deck.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp, RsvpStatus } from '../events/entities/event-rsvp.entity';
import { Workshop } from '../workshops/entities/workshop.entity';
import {
  Subprofile,
  SubprofileStatus,
} from '../subprofiles/entities/subprofile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { ConnectionsService } from '../connections/connections.service';
import { SubprofileEndorsementsService } from '../subprofiles/subprofile-endorsements.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { UserStatus } from '../users/entities/user.entity';
import {
  PublicEligibilitySignalsDto,
  toPublicEligibilitySignals,
} from './public-eligibility-response';

const RESULT_CAP = 50;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MEMBER_SUBJECT_TYPE = 'member';

@Injectable()
export class PublicEligibilityService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Workshop)
    private readonly workshops: Repository<Workshop>,
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
    @InjectRepository(ForumPost)
    private readonly forumPosts: Repository<ForumPost>,
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly communityReplies: Repository<CommunityPostReply>,
    private readonly connections: ConnectionsService,
    private readonly endorsements: SubprofileEndorsementsService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  async getSignals(
    user: CurrentUserData,
  ): Promise<PublicEligibilitySignalsDto> {
    const userId = user.userId;
    const now = new Date();

    const profile = await this.profiles.findOne({ where: { userId } });
    const tenureDays = profile
      ? Math.max(
          0,
          Math.floor(
            (now.getTime() - new Date(profile.joinedAt).getTime()) / MS_PER_DAY,
          ),
        )
      : 0;

    const [
      publishedPieces,
      hostedOpenEvents,
      workshopsTaught,
      subprofileIds,
      connectionCounts,
      eventsAttended,
      forumThreadCount,
      forumPostCount,
      communityPostCount,
      communityReplyCount,
      moderationStates,
    ] = await Promise.all([
      this.publishedPieceTimestamps(userId),
      this.hostedOpenEventTimestamps(userId),
      this.workshops.count({ where: { hostId: userId } }),
      this.publishedSubprofileIds(userId),
      this.connections.counts(userId),
      this.attendedEventCount(userId, now),
      this.forumThreads.count({ where: { authorId: userId } }),
      this.forumPosts.count({
        where: { authorId: userId, deletedAt: IsNull() },
      }),
      this.communityPosts.count({
        where: { authorId: userId, deletedAt: IsNull() },
      }),
      this.communityReplies.count({
        where: { authorId: userId, deletedAt: IsNull() },
      }),
      this.contentModeration.statesForAnyType(
        [MEMBER_SUBJECT_TYPE],
        profile ? [profile.slug, userId] : [userId],
      ),
    ]);

    const endorsementCount = await this.endorsementTotal(subprofileIds);

    const blocked = [...moderationStates.values()].some(
      (state) => state.hidden || state.removed,
    );
    const standingOk = user.status === UserStatus.Active && !blocked;

    return toPublicEligibilitySignals({
      verified: profile?.verified === true,
      tenureDays,
      publishedPieces,
      hostedOpenEvents,
      workshopsTaught,
      publishedSubprofiles: subprofileIds.length,
      vouchCount: profile?.vouchCount ?? 0,
      endorsementCount,
      connectionCount: connectionCounts.all,
      eventsAttended,
      communityPosts:
        forumThreadCount +
        forumPostCount +
        communityPostCount +
        communityReplyCount,
      lastActiveDaysAgo: 0,
      standingOk,
    });
  }

  private async publishedPieceTimestamps(userId: string): Promise<string[]> {
    const rows = await this.pieces
      .createQueryBuilder('piece')
      .leftJoin(MagazineArticle, 'article', 'article.id = piece.articleId')
      .leftJoin(MagazineDeck, 'deck', 'deck.id = piece.deckId')
      .where('piece.writerId = :userId', { userId })
      .andWhere(
        '(article.publishedAt IS NOT NULL OR deck.publishedAt IS NOT NULL)',
      )
      .select('COALESCE(article.publishedAt, deck.publishedAt)', 'publishedAt')
      .orderBy('COALESCE(article.publishedAt, deck.publishedAt)', 'DESC')
      .limit(RESULT_CAP)
      .getRawMany<{ publishedAt: Date }>();
    return rows.map((row) => new Date(row.publishedAt).toISOString());
  }

  private async hostedOpenEventTimestamps(userId: string): Promise<string[]> {
    const cohosted = await this.cohosts.find({
      where: { userId },
      select: ['eventId'],
    });
    const cohostIds = cohosted.map((row) => row.eventId);
    const rows = await this.events
      .createQueryBuilder('event')
      .where('event.status = :status', { status: EventStatus.Published })
      .andWhere('event.visibility = :visibility', {
        visibility: EventVisibility.Public,
      })
      .andWhere(
        new Brackets((qb) => {
          qb.where('event.hostId = :userId', { userId });
          if (cohostIds.length)
            qb.orWhere('event.id IN (:...cohostIds)', { cohostIds });
        }),
      )
      .orderBy('event.startAt', 'DESC')
      .limit(RESULT_CAP)
      .getMany();
    return rows.map((event) => new Date(event.startAt).toISOString());
  }

  private async publishedSubprofileIds(userId: string): Promise<string[]> {
    const rows = await this.subprofiles.find({
      where: {
        userId,
        status: SubprofileStatus.Published,
        removedAt: IsNull(),
      },
      select: ['id'],
    });
    return rows.map((row) => row.id);
  }

  private async endorsementTotal(subprofileIds: string[]): Promise<number> {
    if (!subprofileIds.length) return 0;
    const counts =
      await this.endorsements.loadEndorsementCountsFor(subprofileIds);
    return [...counts.values()].reduce((sum, count) => sum + count, 0);
  }

  private async attendedEventCount(userId: string, now: Date): Promise<number> {
    return this.rsvps
      .createQueryBuilder('rsvp')
      .innerJoin(Event, 'event', 'event.id = rsvp.eventId')
      .where('rsvp.userId = :userId', { userId })
      .andWhere('rsvp.status = :status', { status: RsvpStatus.Going })
      .andWhere('event.startAt < :now', { now })
      .getCount();
  }
}

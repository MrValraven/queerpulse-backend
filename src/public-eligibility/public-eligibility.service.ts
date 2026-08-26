import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
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
  PublicEligibilityDecisionDto,
  PublicEligibilitySignalsDto,
  RawSignals,
  toPublicEligibilitySignals,
} from './public-eligibility-response';
import {
  PUBLIC_ELIGIBILITY_REASON_MESSAGE,
  evaluatePublicEligibility,
} from './public-eligibility.rules';

const RESULT_CAP = 50;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const MEMBER_SUBJECT_TYPE = 'member';

@Injectable()
export class PublicEligibilityService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(MagazinePiece)
    private readonly pieces: Repository<MagazinePiece>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
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

  /**
   * The full signal set plus the decision the server itself would apply on a
   * write. One shape, so the tracker the member reads and the gate that stops
   * the write are answering from the same numbers.
   */
  async getSignals(
    user: CurrentUserData,
  ): Promise<PublicEligibilitySignalsDto> {
    const now = new Date();
    const raw = await this.collectSignals(user, now);
    return toPublicEligibilitySignals(
      raw,
      evaluatePublicEligibility(raw, now.toISOString()),
    );
  }

  /** The decision on its own, for callers that only need the verdict. */
  async evaluate(user: CurrentUserData): Promise<PublicEligibilityDecisionDto> {
    const now = new Date();
    return evaluatePublicEligibility(
      await this.collectSignals(user, now),
      now.toISOString(),
    );
  }

  /**
   * The server-side gate on publishing to the open web. Throws 403 with a
   * coarse reason code when the member may not publish, and returns the
   * decision when they may.
   *
   * Call this from EVERY path that can set a publication flag to true. Turning
   * publication OFF must never go through here: a member who has become
   * ineligible (or suspended, or deactivated) still has to be able to
   * un-publish, and a switch you can turn on but not off is a trap.
   */
  async assertMayGoPublic(
    user: CurrentUserData,
  ): Promise<PublicEligibilityDecisionDto> {
    const decision = await this.evaluate(user);
    if (!decision.isEligible) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message:
          PUBLIC_ELIGIBILITY_REASON_MESSAGE[
            decision.reasonCode ?? 'not_eligible'
          ],
        reasonCode: decision.reasonCode ?? 'not_eligible',
      });
    }
    return decision;
  }

  private async collectSignals(
    user: CurrentUserData,
    now: Date,
  ): Promise<RawSignals> {
    const userId = user.userId;

    const profile = await this.profiles.findOne({ where: { userId } });
    // Only the raw day count is computed here. The 90-day hard gate itself
    // (`TENURE_FLOOR_DAYS`) is applied by `public-eligibility.rules.ts`, which
    // is the single source of truth for the whole rule. The frontend keeps the
    // copy that explains it and renders the numbers this service returns.
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
      subprofileIds,
      connectionCounts,
      eventsAttended,
      vouchesGivenCount,
      forumThreadCount,
      forumPostCount,
      communityPostCount,
      communityReplyCount,
      moderationStates,
    ] = await Promise.all([
      this.publishedPieceTimestamps(userId),
      this.hostedOpenEventTimestamps(userId),
      this.publishedSubprofileIds(userId),
      this.connections.counts(userId),
      this.attendedEventCount(userId, now),
      this.vouches.count({
        where: { voucherId: userId, withdrawnAt: IsNull() },
      }),
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
    // `user.status` is a JWT claim, typed `string` on `CurrentUserData`; the
    // widening keeps the comparison honest about that.
    const standingOk =
      user.status === (UserStatus.Active as string) && !blocked;

    return {
      verified: profile?.verified === true,
      tenureDays,
      publishedPieces,
      hostedOpenEvents,
      publishedSubprofiles: subprofileIds.length,
      vouchCount: profile?.vouchCount ?? 0,
      vouchesGivenCount,
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
    };
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

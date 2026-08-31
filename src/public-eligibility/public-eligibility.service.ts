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
import { CommunityMember } from '../communities/entities/community-member.entity';
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
/**
 * How many people OTHER than the author a community must hold before a post
 * inside it counts towards recognition XP.
 *
 * XP converts into monthly invitations at levels 4 and 5
 * (`INVITE_QUOTA_BONUS_BY_LEVEL`), so on an invite-gated platform every XP
 * signal has to cost the earner either a second person's cooperation or a
 * moderator's decision. Creating a community is one API call and the creator
 * is written onto its roster by `CommunitiesService.create`, so a member
 * could stand up a room nobody else is in and talk to themselves twenty
 * times for the whole `posts` cap. Two other people is the smallest audience
 * that is an audience: one other person is a conversation, and a pair of
 * accounts is the cheapest thing somebody farming invitations can produce.
 *
 * Real communities clear this the day they open. A brand-new community's
 * first posts start counting the moment its second and third member arrive,
 * and nothing is taken back from posts written before that: `communityPosts`
 * on the eligibility DTO is untouched by this and still counts every post.
 */
const COMMUNITY_AUDIENCE_FLOOR = 2;
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
    // Roster rows, read only to answer "does anybody else stand in this
    // room?" for the XP-side counts below. The eligibility score itself never
    // reads them.
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
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

  /**
   * Gatherings this member hosted or co-hosted that ACTUALLY HAPPENED and
   * drew somebody: published, public, `startAt` already in the past, and
   * carrying at least one "going" RSVP from a person who is neither the
   * event's host nor this member.
   *
   * Deliberately stricter than `hostedOpenEventTimestamps` above, and kept
   * separate from it. `hostedOpenEvents` answers "is this member visible
   * enough to have a public profile", where an announced-but-future gathering
   * is honest evidence. This answers "did this member do the work", which is
   * what recognition XP pays for, and XP converts into monthly invitations
   * (`INVITE_QUOTA_BONUS_BY_LEVEL`). Creating a published, public event is a
   * single unguarded API call, and one recurrence rule expands to 52 rows, so
   * the looser definition would have handed a brand-new account the whole
   * `hosting` XP cap for free. The two requirements this adds cost a farmer
   * real calendar time and a second person's cooperation per gathering.
   *
   * Changing THIS definition does not move public-profile eligibility, and
   * changing that one does not move XP. That separation is the point.
   */
  async countHeldGatherings(userId: string, now = new Date()): Promise<number> {
    const cohosted = await this.cohosts.find({
      where: { userId },
      select: ['eventId'],
    });
    const cohostIds = cohosted.map((row) => row.eventId);
    return this.events
      .createQueryBuilder('event')
      .where('event.status = :status', { status: EventStatus.Published })
      .andWhere('event.visibility = :visibility', {
        visibility: EventVisibility.Public,
      })
      .andWhere('event.startAt < :now', { now })
      .andWhere(
        new Brackets((qb) => {
          qb.where('event.hostId = :userId', { userId });
          if (cohostIds.length)
            qb.orWhere('event.id IN (:...cohostIds)', { cohostIds });
        }),
      )
      .andWhere(
        `EXISTS (
           SELECT 1 FROM event_rsvps rsvp
           WHERE rsvp.event_id = event.id
             AND rsvp.status = :goingStatus
             AND rsvp.user_id IS DISTINCT FROM event.host_id
             AND rsvp.user_id <> :userId
         )`,
        { goingStatus: RsvpStatus.Going, userId },
      )
      .getCount();
  }

  /**
   * ── THE XP-SIDE COUNTS ────────────────────────────────────────────────────
   *
   * Everything below answers "did somebody other than this member take part?"
   * for `RecognitionAwardingService`. They are deliberately separate from the
   * looser counts `collectSignals` assembles above, for exactly the reason
   * `countHeldGatherings` is separate from `hostedOpenEventTimestamps`:
   * public-profile eligibility asks whether a member is visible enough to be
   * citable on the open web, where their own output is honest evidence, and
   * recognition XP asks whether they did work other people were part of,
   * because XP buys monthly invitations (`INVITE_QUOTA_BONUS_BY_LEVEL`) and
   * invitations are the membrane around an invite-only platform.
   *
   * Changing a count here never moves public-profile eligibility, and changing
   * one up there never moves XP. That separation is the point, and every one
   * of these has a looser twin above that must stay looser.
   */

  /**
   * Communities this member belongs to that hold at least
   * `COMMUNITY_AUDIENCE_FLOOR` people besides them.
   *
   * `communityMembers.count({ userId })`, which is what recognition used to
   * pay the `communities` rule on, counts a roster row the member wrote
   * themselves: `CommunitiesService.create` puts the creator on the roster of
   * every community they found, and nothing caps how many they may found. So
   * three API calls bought the entire capped 120 XP. This asks the different
   * question: is there a room, and are there people in it.
   */
  async countAudiencedCommunities(userId: string): Promise<number> {
    return this.communityMembers
      .createQueryBuilder('membership')
      .where('membership.userId = :userId', { userId })
      .andWhere(
        `(
           SELECT count(*) FROM community_members peer
           WHERE peer.community_id = membership.community_id
             AND peer.user_id <> :userId
         ) >= :audienceFloor`,
        { userId, audienceFloor: COMMUNITY_AUDIENCE_FLOOR },
      )
      .getCount();
  }

  /**
   * Posts and replies by this member with a second person on the other end of
   * them.
   *
   * The four parts, and why each one is shaped the way it is. A member's own
   * volume is never the unit:
   *
   *   1. A forum THREAD they started that drew a reply from somebody else.
   *      The forum has no roster to measure an audience against, so the test
   *      is whether the thread reached anyone.
   *   2. A forum POST of theirs on a thread somebody else started, excluding
   *      the opening post (`is_op`, which part 1 already accounts for, and
   *      which the old count double-paid: a thread row plus its OP row are
   *      two units for one act).
   *   3. A community post of theirs in a community with a real audience
   *      (`COMMUNITY_AUDIENCE_FLOOR`). Communities do have a roster, so here
   *      the audience is a thing that can be counted directly.
   *   4. A reply of theirs to a post somebody else wrote. `IS DISTINCT FROM`
   *      rather than `<>` so a reply to a post whose author erased their
   *      account still counts: there really was another person there.
   *
   * Deleted rows are excluded throughout, the same as the eligibility count.
   */
  async countEngagedCommunityPosts(userId: string): Promise<number> {
    const [
      answeredThreads,
      repliesOnOthersThreads,
      postsWithAudience,
      repliesToOthers,
    ] = await Promise.all([
      this.forumThreads
        .createQueryBuilder('thread')
        .where('thread.authorId = :userId', { userId })
        .andWhere(
          `EXISTS (
             SELECT 1 FROM forum_post reply
             WHERE reply.thread_id = thread.id
               AND reply.author_id <> :userId
               AND reply.deleted_at IS NULL
           )`,
          { userId },
        )
        .getCount(),
      this.forumPosts
        .createQueryBuilder('post')
        .innerJoin(ForumThread, 'thread', 'thread.id = post.threadId')
        .where('post.authorId = :userId', { userId })
        .andWhere('post.deletedAt IS NULL')
        .andWhere('post.isOp = false')
        .andWhere('thread.authorId <> :userId', { userId })
        .getCount(),
      this.communityPosts
        .createQueryBuilder('post')
        .where('post.authorId = :userId', { userId })
        .andWhere('post.deletedAt IS NULL')
        .andWhere('post.communityId IS NOT NULL')
        .andWhere(
          `(
             SELECT count(*) FROM community_members peer
             WHERE peer.community_id = post.community_id
               AND peer.user_id <> :userId
           ) >= :audienceFloor`,
          { userId, audienceFloor: COMMUNITY_AUDIENCE_FLOOR },
        )
        .getCount(),
      this.communityReplies
        .createQueryBuilder('reply')
        .innerJoin(CommunityPost, 'post', 'post.id = reply.postId')
        .where('reply.authorId = :userId', { userId })
        .andWhere('reply.deletedAt IS NULL')
        .andWhere('post.authorId IS DISTINCT FROM :userId', { userId })
        .getCount(),
    ]);

    return (
      answeredThreads +
      repliesOnOthersThreads +
      postsWithAudience +
      repliesToOthers
    );
  }

  /**
   * Gatherings this member turned up to that somebody ELSE was running:
   * a `going` RSVP on a published gathering whose start time has passed,
   * where the member is neither the host nor a co-host.
   *
   * `attendedEventCount` below counts every past `going` RSVP, including one
   * a host left on their own gathering, and that made the whole 600 XP
   * `events` cap solo. `EventsService.create` rejects a start time in the
   * past, so the naive version of that farm costs a wait, but `update` calls
   * `assertScheduleValid` with `rejectPast: false`, so a host can create a
   * gathering for tomorrow, PATCH `startAt` into last week, RSVP to it and
   * collect immediately. Twelve of those is one script.
   *
   * Requiring a host other than the member is what puts a second person in
   * the loop. Hosting is already paid separately and on its own stricter
   * unit (`countHeldGatherings`), so nothing here takes credit away from a
   * host: it stops one gathering paying its organiser twice.
   */
  async countAttendedGatherings(
    userId: string,
    now = new Date(),
  ): Promise<number> {
    const cohosted = await this.cohosts.find({
      where: { userId },
      select: ['eventId'],
    });
    const cohostIds = cohosted.map((row) => row.eventId);
    const query = this.rsvps
      .createQueryBuilder('rsvp')
      .innerJoin(Event, 'event', 'event.id = rsvp.eventId')
      .where('rsvp.userId = :userId', { userId })
      .andWhere('rsvp.status = :status', { status: RsvpStatus.Going })
      .andWhere('event.startAt < :now', { now })
      // `IS DISTINCT FROM` so a gathering whose host erased their account
      // still counts for the people who went to it.
      .andWhere('event.hostId IS DISTINCT FROM :userId', { userId });
    if (cohostIds.length) {
      query.andWhere('event.id NOT IN (:...cohostIds)', { cohostIds });
    }
    return query.getCount();
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

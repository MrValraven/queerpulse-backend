import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { liftExpiredRestriction } from '../auth/restriction-state';
import { Event } from '../events/entities/event.entity';
import { EventBan } from '../events/entities/event-ban.entity';
import { EventsService } from '../events/events.service';
import { BlockFilterService } from '../social/block-filter.service';
import { User } from '../users/entities/user.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { quizshowError } from './quizshow-errors';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_OPEN_SESSION_STATUSES,
} from './quizshow.contract';

export interface QuizshowMayPlayInput {
  session: Pick<
    QuizshowSessionRecord,
    'id' | 'eventId' | 'startedByUserId' | 'attachedOrganiserUserIds'
  >;
  event: Event;
  userId: string;
  isRestricted: boolean;
  shouldCheckCapacity: boolean;
}

export interface QuizshowMayPlayResult {
  existingPlayer: QuizshowPlayerRecord | null;
  isCohost: boolean;
}

/**
 * The permission boundary of Pulse Live: who organises an event, who may play
 * its live game, and who is barred, restricted or turned away by capacity.
 * Every refusal is a thrown `quizshowError`, so REST callers rethrow it and
 * the gateway maps it with `quizshowCodeOf`.
 */
@Injectable()
export class QuizshowAccessService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventBan)
    private readonly eventBans: Repository<EventBan>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(QuizshowSessionRecord)
    private readonly sessions: Repository<QuizshowSessionRecord>,
    @InjectRepository(QuizshowPlayerRecord)
    private readonly players: Repository<QuizshowPlayerRecord>,
    private readonly eventsService: EventsService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /** A missing event and an event the viewer cannot see both answer 404. */
  async loadViewableEvent(
    slug: string,
    viewerId: string,
  ): Promise<{ event: Event; isOrganizer: boolean }> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) throw quizshowError('quizshow_event_not_found');
    try {
      const isOrganizer = await this.eventsService.assertCanView(
        event,
        viewerId,
      );
      return { event, isOrganizer };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw quizshowError('quizshow_event_not_found');
      }
      throw error;
    }
  }

  async assertOrganiser(event: Event, userId: string): Promise<void> {
    const isOrganizer = await this.eventsService.isOrganizer(event.id, userId);
    if (!isOrganizer) throw quizshowError('quizshow_not_organiser');
  }

  /**
   * A non-removed player row of this organiser in a lobby, running or paused
   * session. Every caller has already asserted the user organises the event,
   * so any player row counts, including one that joined before the user
   * became a co-host (its join-time `isCohostPlayer` flag reads false).
   */
  async isCohostPlayingOpenSession(
    eventId: string,
    userId: string,
  ): Promise<boolean> {
    const openSessions = await this.sessions.find({
      where: { eventId, status: In([...QUIZSHOW_OPEN_SESSION_STATUSES]) },
      select: { id: true },
    });
    if (openSessions.length === 0) return false;
    return this.players.exists({
      where: {
        sessionId: In(openSessions.map((session) => session.id)),
        userId,
        removedAt: IsNull(),
      },
    });
  }

  async assertNotCohostPlaying(eventId: string, userId: string): Promise<void> {
    if (await this.isCohostPlayingOpenSession(eventId, userId)) {
      throw quizshowError('quizshow_cohost_is_playing');
    }
  }

  /** An event ban, or a block either way with the host. Organisers are never barred. */
  async isBarredFromEvent(event: Event, userId: string): Promise<boolean> {
    if (await this.eventsService.isOrganizer(event.id, userId)) return false;
    const isBanned = await this.eventBans.exists({
      where: { eventId: event.id, userId },
    });
    if (isBanned) return true;
    if (event.hostId === null) return false;
    return this.blockFilter.isBlockedEitherWay(event.hostId, userId);
  }

  async isRestricted(userId: string): Promise<boolean> {
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, restricted: true, restrictedUntil: true },
    });
    if (!user) return false;
    return liftExpiredRestriction(this.users, user);
  }

  isAdultsEvent(event: Pick<Event, 'formatDetails'>): boolean {
    return event.formatDetails?.isAdultsOnly === true;
  }

  /** Refuses in a fixed order: view, ban, restriction, removal, organiser, capacity. */
  async assertMayPlay(
    input: QuizshowMayPlayInput,
  ): Promise<QuizshowMayPlayResult> {
    const { session, event, userId } = input;
    try {
      await this.eventsService.assertCanView(event, userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw quizshowError('quizshow_cannot_view_event');
      }
      throw error;
    }
    if (await this.isBarredFromEvent(event, userId)) {
      throw quizshowError('quizshow_banned_from_event');
    }
    if (input.isRestricted) throw quizshowError('ACCOUNT_RESTRICTED');

    const existingPlayer = await this.players.findOne({
      where: { sessionId: session.id, userId },
    });
    if (existingPlayer?.removedAt) {
      throw quizshowError('quizshow_player_removed');
    }

    const isHost = event.hostId === userId;
    const isOpener = session.startedByUserId === userId;
    const isAttachedOrganiser =
      session.attachedOrganiserUserIds.includes(userId);
    if (isHost || isOpener || isAttachedOrganiser) {
      throw quizshowError('quizshow_organiser_running');
    }

    if (input.shouldCheckCapacity && !existingPlayer) {
      const activePlayerCount = await this.players.count({
        where: { sessionId: session.id, removedAt: IsNull() },
      });
      if (activePlayerCount >= QUIZSHOW_LIMITS.playersPerSessionMax) {
        throw quizshowError('quizshow_session_full');
      }
    }

    const isCohost =
      !isHost && (await this.eventsService.isOrganizer(event.id, userId));
    return { existingPlayer, isCohost };
  }
}

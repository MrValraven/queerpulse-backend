import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { EventsService } from '../events/events.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { HostConfigDto } from './dto/host-config.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import {
  changedHostQuestionIds,
  parseHostQuestions,
} from './go-together-answers';
import {
  MAX_CUTOFF_LEAD_MS,
  OPT_IN_CLOSE_MS,
  defaultCutoffAt,
  effectiveCutoffAt,
  optInClosesAt,
} from './go-together-eligibility.service';
import { GoTogetherHouseService } from './go-together-house.service';
import { HOST_SWITCHED_OFF_REASON } from './go-together-notice-reasons';
import type {
  HostConfigResponse,
  HostSummaryResponse,
} from './go-together-response';

/** Raw rows from an UPDATE ... RETURNING (snake_case database columns). */
interface ClosedEntryRow {
  user_id: string;
}

/** The fields a closed entry gets, the same shape a member's own withdrawal
 *  writes. Shared with the opt-in paths that close an entry which raced a
 *  switch-off. */
export const CLOSED_ENTRY_FIELDS = {
  status: 'withdrawn',
  pairStatus: 'none',
  pairPartnerId: null,
  mergeOfferGroupId: null,
  lens: null,
  lensConsentedAt: null,
} as const satisfies Partial<EventMatchEntry>;

export { HOST_SWITCHED_OFF_REASON };

function lockedError(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'Matching has already run for this gathering',
    code: 'GO_TOGETHER_LOCKED',
  });
}

/** The host side of Go together: settings for one gathering and the
 *  anonymous counts the host sees. Only the host or a co-host gets here. */
@Injectable()
export class GoTogetherHostService {
  private readonly logger = new Logger(GoTogetherHostService.name);

  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventMatchConfig)
    private readonly configs: Repository<EventMatchConfig>,
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(EventMatchGroup)
    private readonly groups: Repository<EventMatchGroup>,
    private readonly eventsService: EventsService,
    private readonly house: GoTogetherHouseService,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /** A saved config, or for an official event with no row yet a virtual
   *  enabled one with the default cutoff (spec 3.1: on by default for official
   *  events). The virtual config is never saved here; `ensureConfigRow` saves
   *  it on the first opt-in so the cron can see it. Once opt-in has closed an
   *  official event without a row gets none, so no past cutoff is ever saved. */
  async effectiveConfig(
    event: Event,
    now: Date = new Date(),
  ): Promise<EventMatchConfig | null> {
    const saved = await this.configs.findOne({ where: { eventId: event.id } });
    return saved ?? this.virtualConfig(event, now);
  }

  /** The unsaved default config an official event gets while opt-in is
   *  open, or null for any other gathering. */
  private async virtualConfig(
    event: Event,
    now: Date,
  ): Promise<EventMatchConfig | null> {
    if (
      event.hostId !== null &&
      now.getTime() < optInClosesAt(event).getTime() &&
      event.hostId === (await this.house.houseUserId())
    ) {
      return this.configs.create({
        eventId: event.id,
        enabled: true,
        cutoffAt: defaultCutoffAt(event.startAt, now),
        hostQuestions: [],
        meetingPointNote: null,
        matchedAt: null,
        lateGroupAt: null,
        feedbackPromptedAt: null,
        runCount: 0,
      });
    }
    return null;
  }

  /**
   * The saved config row, inserting the virtual one on an official event's
   * first opt-in. A saved row is returned as it is and never written back:
   * saving a loaded row would overwrite a cutoff claim (`matchedAt`) or a
   * host save that committed in between. The insert skips on conflict, so a
   * concurrent first opt-in keeps whichever row landed first.
   */
  async ensureConfigRow(
    event: Event,
    now: Date = new Date(),
  ): Promise<EventMatchConfig> {
    const saved = await this.configs.findOne({ where: { eventId: event.id } });
    if (saved) return saved;
    const virtual = await this.virtualConfig(event, now);
    if (virtual) {
      await this.configs
        .createQueryBuilder()
        .insert()
        .into(EventMatchConfig)
        .values(virtual)
        .orIgnore()
        .execute();
    }
    const stored = virtual
      ? await this.configs.findOne({ where: { eventId: event.id } })
      : null;
    if (!stored) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Go together is off for this gathering',
        code: 'GO_TOGETHER_UNAVAILABLE',
        reason: 'notEnabled',
      });
    }
    return stored;
  }

  async getConfig(
    slug: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<HostConfigResponse> {
    const event = await this.loadAsOrganizer(slug, userId);
    return this.toConfigResponse(
      event,
      await this.effectiveConfig(event, now),
      now,
    );
  }

  async putConfig(
    slug: string,
    userId: string,
    dto: HostConfigDto,
    now: Date = new Date(),
  ): Promise<HostConfigResponse> {
    const event = await this.loadAsOrganizer(slug, userId);
    const existing = await this.effectiveConfig(event, now);
    if (existing?.matchedAt) throw lockedError();
    if (now.getTime() >= optInClosesAt(event).getTime()) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Opt-in for this gathering has already closed',
        code: 'GO_TOGETHER_UNAVAILABLE',
        reason: 'closed',
      });
    }

    const startMs = event.startAt.getTime();
    const cutoffAt = dto.cutoffAt
      ? new Date(dto.cutoffAt)
      : defaultCutoffAt(event.startAt, now);
    const earliestMs = startMs - MAX_CUTOFF_LEAD_MS;
    const latestMs = startMs - OPT_IN_CLOSE_MS;
    const isOutsideRange =
      cutoffAt.getTime() < earliestMs || cutoffAt.getTime() > latestMs;
    // Only a time the host chose is refused for being past; the default never
    // is, and neither is the saved time sent back, raw or as the response
    // showed it (clamped to the current start).
    const isSavedCutoff =
      existing !== null &&
      (existing.cutoffAt.getTime() === cutoffAt.getTime() ||
        effectiveCutoffAt(existing.cutoffAt, event.startAt).getTime() ===
          cutoffAt.getTime());
    const isNewPastCutoff =
      dto.cutoffAt !== undefined &&
      cutoffAt.getTime() < now.getTime() &&
      !isSavedCutoff;
    if (isOutsideRange || isNewPastCutoff) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          'Pick a matching time between 7 days and 6 hours before the start',
        code: 'GO_TOGETHER_BAD_CUTOFF',
      });
    }

    const parsedQuestions = parseHostQuestions(dto.hostQuestions);
    if (!parsedQuestions.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Check the host questions',
        code: 'GO_TOGETHER_INVALID_QUESTIONS',
        errors: parsedQuestions.errors,
      });
    }

    const trimmedNote = dto.meetingPointNote?.trim() ?? '';
    const { saved, closedUserIds } = await this.dataSource.transaction(
      async (manager) => {
        const configRepository = manager.getRepository(EventMatchConfig);
        const entryRepository = manager.getRepository(EventMatchEntry);
        // The row lock orders this save against the cutoff claim: either the
        // claim waits for this commit (and skips a config switched off), or
        // this save sees `matchedAt` and refuses. A group therefore never
        // sits on a config that reads off.
        const stored = await configRepository.findOne({
          where: { eventId: event.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (stored?.matchedAt) throw lockedError();
        // Every save that leaves the config off sweeps waiting entries, so
        // one left by an opt-in racing an earlier switch-off closes too.
        const shouldCloseWaiting = !dto.enabled;
        const changedQuestionIds = changedHostQuestionIds(
          stored?.hostQuestions ?? [],
          parsedQuestions.value,
        );
        const config =
          stored ??
          configRepository.create({
            eventId: event.id,
            matchedAt: null,
            lateGroupAt: null,
            feedbackPromptedAt: null,
            runCount: 0,
          });
        config.enabled = dto.enabled;
        config.cutoffAt = cutoffAt;
        config.hostQuestions = parsedQuestions.value;
        config.meetingPointNote = trimmedNote.length > 0 ? trimmedNote : null;
        const savedConfig = await configRepository.save(config);
        await this.clearAnswers(entryRepository, event.id, changedQuestionIds);
        return {
          saved: savedConfig,
          closedUserIds: shouldCloseWaiting
            ? await this.closeWaitingEntries(entryRepository, event.id)
            : [],
        };
      },
    );
    await this.notifySwitchedOff(event, closedUserIds);
    return this.toConfigResponse(event, saved, now);
  }

  /**
   * An edited or removed host question makes its saved answers mean
   * something the member never picked, so they go. The card then asks a
   * waiting member for the missing answer (`unansweredHostQuestionIds`).
   */
  private async clearAnswers(
    entryRepository: Repository<EventMatchEntry>,
    eventId: string,
    questionIds: string[],
  ): Promise<void> {
    if (questionIds.length === 0) return;
    await entryRepository
      .createQueryBuilder()
      .update(EventMatchEntry)
      .set({ hostAnswers: () => 'host_answers - CAST(:questionIds AS text[])' })
      .where('event_id = :eventId', { eventId })
      .andWhere('host_answers - CAST(:questionIds AS text[]) <> host_answers', {
        questionIds,
      })
      .execute();
  }

  /**
   * Go together is off for this gathering: every waiting entry closes, the
   * way a member's own withdrawal does, and a pending pair invite (it lives
   * on the inviter's waiting entry) closes with it. Switching back on revives
   * none of them; members opt in again. Returns the members whose entry
   * closed, so a repeat save while off notifies nobody twice.
   */
  private async closeWaitingEntries(
    entryRepository: Repository<EventMatchEntry>,
    eventId: string,
  ): Promise<string[]> {
    const result = await entryRepository
      .createQueryBuilder()
      .update(EventMatchEntry)
      .set({ ...CLOSED_ENTRY_FIELDS })
      .where('event_id = :eventId', { eventId })
      .andWhere("status = 'waiting'")
      .returning('user_id')
      .execute();
    return ((result.raw ?? []) as ClosedEntryRow[]).map((row) => row.user_id);
  }

  /** Tells each member whose entry closed that no group is coming for this
   *  gathering, with the reason on the payload. Runs after the commit; a
   *  failed notice is logged and the save stands. */
  private async notifySwitchedOff(
    event: Event,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.notifications.createForRecipients(
        userIds,
        NotificationType.GoTogetherUnmatched,
        {
          eventId: event.id,
          eventSlug: event.slug,
          eventTitle: event.title,
          isFinal: true,
          reason: HOST_SWITCHED_OFF_REASON,
        },
      );
    } catch (error) {
      this.logger.error(
        `Go together switch-off notice failed for event ${event.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Counts only: the host never sees who opted in or who was grouped. */
  async summary(slug: string, userId: string): Promise<HostSummaryResponse> {
    const event = await this.loadAsOrganizer(slug, userId);
    const [waiting, grouped, unmatched, groups] = await Promise.all([
      this.entries.count({ where: { eventId: event.id, status: 'waiting' } }),
      this.entries.count({ where: { eventId: event.id, status: 'grouped' } }),
      this.entries.count({ where: { eventId: event.id, status: 'unmatched' } }),
      this.groups.count({
        where: { eventId: event.id, dissolvedAt: IsNull() },
      }),
    ]);
    return { waiting, grouped, unmatched, groups };
  }

  /** A non-organizer gets the same 404 as a missing gathering, so these
   *  routes never confirm that an invite-only slug exists. */
  private async loadAsOrganizer(slug: string, userId: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event || !(await this.eventsService.isOrganizer(event.id, userId))) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private toConfigResponse(
    event: Event,
    config: EventMatchConfig | null,
    now: Date,
  ): HostConfigResponse {
    const startMs = event.startAt.getTime();
    return {
      enabled: config?.enabled ?? false,
      // The time matching actually runs, even after the gathering moved.
      cutoffAt: (config
        ? effectiveCutoffAt(config.cutoffAt, event.startAt)
        : defaultCutoffAt(event.startAt, now)
      ).toISOString(),
      earliestCutoffAt: new Date(startMs - MAX_CUTOFF_LEAD_MS).toISOString(),
      latestCutoffAt: new Date(startMs - OPT_IN_CLOSE_MS).toISOString(),
      hostQuestions: config?.hostQuestions ?? [],
      meetingPointNote: config?.meetingPointNote ?? null,
      isLocked: config?.matchedAt != null,
    };
  }
}

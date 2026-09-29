import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { toMemberRef } from '../common/member-ref';
import { ConnectionsService } from '../connections/connections.service';
import { Event } from '../events/entities/event.entity';
import { EventAudienceGateService } from '../events/event-audience-gate.service';
import { EventsService } from '../events/events.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  OptInDto,
  PairAnswersDto,
  UpdateHostAnswersDto,
} from './dto/opt-in.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import {
  changedHostQuestionIds,
  mergeHostAnswers,
  omitHostAnswers,
  parseHostAnswers,
  unansweredHostQuestionIds,
} from './go-together-answers';
import { computeCardState } from './go-together-card';
import {
  GoTogetherEligibilityService,
  effectiveCutoffAt,
  optInClosesAt,
} from './go-together-eligibility.service';
import { feedbackWindow } from './go-together-group.service';
import {
  CLOSED_ENTRY_FIELDS,
  GoTogetherHostService,
} from './go-together-host.service';
import { GoTogetherProfileService } from './go-together-profile.service';
import type {
  HostAnswers,
  HostQuestion,
  Lens,
} from './go-together-questionnaire.catalog';
import type { GoTogetherCardResponse } from './go-together-response';

/** The fields an opt-in writes onto the caller's entry. */
type EntryWrite = Pick<
  EventMatchEntry,
  | 'status'
  | 'pairPartnerId'
  | 'pairStatus'
  | 'hostAnswers'
  | 'lens'
  | 'lensConsentedAt'
  | 'groupId'
  | 'mergeOfferGroupId'
>;

/** The answer fields an opt-in or an acceptance writes. */
type AnswerFields = Pick<
  EventMatchEntry,
  'hostAnswers' | 'lens' | 'lensConsentedAt'
>;

function unavailableError(reason: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'Go together is not open for this gathering',
    code: 'GO_TOGETHER_UNAVAILABLE',
    reason,
  });
}

function notWaitingError(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'You are not waiting for a group for this gathering',
    code: 'GO_TOGETHER_NOT_WAITING',
  });
}

function partnerUnavailableError(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    message: 'That friend cannot join you for this gathering',
    code: 'GO_TOGETHER_PARTNER_UNAVAILABLE',
  });
}

interface JoinCheck {
  hostAnswers: HostAnswers;
  /** The host questions the answers were checked against. */
  answeredQuestions: HostQuestion[];
  lens: Lens | null;
  existing: EventMatchEntry | null;
}

/**
 * A member's own Go together entry for one gathering: the card state, opting
 * in alone or with one friend, answering a friend's invite and withdrawing.
 * Grouped members leave through the group routes instead.
 */
@Injectable()
export class GoTogetherEntryService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly eventsService: EventsService,
    private readonly audienceGate: EventAudienceGateService,
    private readonly eligibility: GoTogetherEligibilityService,
    private readonly host: GoTogetherHostService,
    private readonly profileService: GoTogetherProfileService,
    private readonly connections: ConnectionsService,
    private readonly notifications: NotificationsService,
  ) {}

  async card(slug: string, userId: string): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    return this.buildCard(event, userId);
  }

  async optIn(
    slug: string,
    userId: string,
    dto: OptInDto,
  ): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    const { hostAnswers, answeredQuestions, lens, existing } =
      await this.assertMayJoin(event, userId, dto);
    await this.host.ensureConfigRow(event);
    const answerFields: AnswerFields = {
      hostAnswers,
      lens,
      lensConsentedAt: lens ? new Date() : null,
    };
    const previousAcceptedPartnerId =
      existing?.pairStatus === 'accepted' ? existing.pairPartnerId : null;

    if (dto.mode === 'pair') {
      const { partnerId, partnerEntry } = await this.resolvePartner(
        event,
        userId,
        dto.partnerSlug,
      );
      const isPartnerPairingWithCaller =
        partnerEntry !== null &&
        partnerEntry.status === 'waiting' &&
        partnerEntry.pairPartnerId === userId &&
        partnerEntry.pairStatus !== 'none';
      if (partnerEntry && isPartnerPairingWithCaller) {
        // The friend already invited the caller (crossing invites) or the two
        // are already an accepted pair: either way both sides end accepted,
        // and an accepted pair always shares one lens.
        this.assertSameLens(lens, partnerEntry.lens);
        await this.completeAcceptance(
          event.id,
          userId,
          partnerEntry,
          existing,
          answerFields,
          answeredQuestions,
        );
      } else {
        const isRepeatInvite =
          existing?.status === 'waiting' &&
          existing.pairStatus === 'pending' &&
          existing.pairPartnerId === partnerId;
        if (previousAcceptedPartnerId) {
          await this.resetPartnerToSolo(
            event.id,
            previousAcceptedPartnerId,
            userId,
          );
        }
        await this.upsertEntry(this.entries, event.id, userId, existing, {
          status: 'waiting',
          pairPartnerId: partnerId,
          pairStatus: 'pending',
          groupId: null,
          mergeOfferGroupId: null,
          ...answerFields,
        });
        const isStillOpen = await this.settleAgainstConfig(
          event.id,
          userId,
          answeredQuestions,
        );
        if (isStillOpen && !isRepeatInvite) {
          await this.notifications.create(
            partnerId,
            NotificationType.GoTogetherPairInvite,
            {
              eventId: event.id,
              eventSlug: event.slug,
              eventTitle: event.title,
              actorId: userId,
            },
            userId,
          );
        }
      }
    } else {
      await this.upsertEntry(this.entries, event.id, userId, existing, {
        status: 'waiting',
        pairPartnerId: null,
        pairStatus: 'none',
        groupId: null,
        mergeOfferGroupId: null,
        ...answerFields,
      });
      await this.settleAgainstConfig(event.id, userId, answeredQuestions);
      if (previousAcceptedPartnerId) {
        await this.resetPartnerToSolo(
          event.id,
          previousAcceptedPartnerId,
          userId,
        );
      }
    }

    await this.profileService.touchUsed(userId);
    return this.buildCard(event, userId);
  }

  async acceptPair(
    slug: string,
    userId: string,
    dto: PairAnswersDto,
  ): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    const inviter = await this.findIncomingInvite(event.id, userId);
    if (!inviter) throw new NotFoundException('That invite is no longer open');
    const { hostAnswers, answeredQuestions, lens, existing } =
      await this.assertMayJoin(event, userId, dto);
    this.assertSameLens(lens, inviter.lens);
    await this.host.ensureConfigRow(event);
    await this.completeAcceptance(
      event.id,
      userId,
      inviter,
      existing,
      { hostAnswers, lens, lensConsentedAt: lens ? new Date() : null },
      answeredQuestions,
    );
    await this.profileService.touchUsed(userId);
    return this.buildCard(event, userId);
  }

  /**
   * A waiting member answers the host questions again after the host changed
   * them. Only the host answers change: pairing, lens and consent stay as
   * they are.
   */
  async updateHostAnswers(
    slug: string,
    userId: string,
    dto: UpdateHostAnswersDto,
  ): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    const config = await this.openConfig(event);
    await this.assertMemberEligible(event.id, userId);
    const entry = await this.entries.findOne({
      where: { eventId: event.id, userId },
    });
    if (entry?.status !== 'waiting') throw notWaitingError();
    const merged = mergeHostAnswers(
      config.hostQuestions,
      entry.hostAnswers,
      dto.hostAnswers,
    );
    if (!merged.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: "Answer the host's questions",
        code: 'GO_TOGETHER_INVALID_ANSWERS',
        errors: merged.errors,
      });
    }
    // Guarded on `waiting` so a cutoff run that grouped the member meanwhile
    // keeps the answers it scored.
    const result = await this.entries.update(
      { id: entry.id, status: 'waiting' },
      { hostAnswers: merged.value },
    );
    if (!result.affected) throw notWaitingError();
    await this.settleAgainstConfig(event.id, userId, config.hostQuestions);
    return this.buildCard(event, userId);
  }

  /**
   * Closes the window between reading the config and writing the entry. The
   * config row is read `FOR SHARE` after the caller's entry committed, so a
   * host save either finished first (and is seen here) or starts after this
   * and its own sweep sees the entry. A config switched off meanwhile
   * withdraws the caller's waiting entry; a question edited meanwhile drops
   * the answer to it, and the card asks for it again. Returns whether the
   * entry is still open.
   */
  private async settleAgainstConfig(
    eventId: string,
    userId: string,
    answeredQuestions: HostQuestion[],
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const lockedConfig = await manager
        .getRepository(EventMatchConfig)
        .findOne({ where: { eventId }, lock: { mode: 'pessimistic_read' } });
      const entryRepository = manager.getRepository(EventMatchEntry);
      if (!lockedConfig?.enabled) {
        await entryRepository.update(
          { eventId, userId, status: 'waiting' },
          { ...CLOSED_ENTRY_FIELDS },
        );
        return false;
      }
      const staleQuestionIds = changedHostQuestionIds(
        answeredQuestions,
        lockedConfig.hostQuestions,
      );
      if (staleQuestionIds.length === 0) return true;
      const entry = await entryRepository.findOne({
        where: { eventId, userId },
      });
      if (entry) {
        await entryRepository.update(
          { id: entry.id },
          { hostAnswers: omitHostAnswers(entry.hostAnswers, staleQuestionIds) },
        );
      }
      return true;
    });
  }

  async declinePair(
    slug: string,
    userId: string,
  ): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    const inviter = await this.findIncomingInvite(event.id, userId);
    if (inviter) {
      // The inviter stays waiting, now as a solo.
      await this.entries.update(
        { id: inviter.id },
        { pairStatus: 'none', pairPartnerId: null },
      );
    }
    return this.buildCard(event, userId);
  }

  async withdraw(
    slug: string,
    userId: string,
  ): Promise<GoTogetherCardResponse> {
    const event = await this.loadViewable(slug, userId);
    const entry = await this.entries.findOne({
      where: { eventId: event.id, userId },
    });
    if (entry?.status === 'grouped') {
      throw new ConflictException({
        statusCode: 409,
        message: 'Use Leave group on your group card',
        code: 'GO_TOGETHER_ALREADY_GROUPED',
      });
    }
    if (entry && (entry.status === 'waiting' || entry.status === 'unmatched')) {
      const acceptedPartnerId =
        entry.pairStatus === 'accepted' ? entry.pairPartnerId : null;
      entry.status = 'withdrawn';
      entry.pairStatus = 'none';
      entry.pairPartnerId = null;
      // The lens only serves matching for this gathering, which just ended
      // for this member; opting in again asks for it afresh.
      entry.lens = null;
      entry.lensConsentedAt = null;
      await this.entries.save(entry);
      if (acceptedPartnerId) {
        await this.resetPartnerToSolo(event.id, acceptedPartnerId, userId);
      }
    }
    return this.buildCard(event, userId);
  }

  private async loadViewable(slug: string, userId: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) throw new NotFoundException('Event not found');
    await this.audienceGate.assertViewable(
      event,
      userId,
      await this.eventsService.isOrganizer(event.id, userId),
    );
    return event;
  }

  private async buildCard(
    event: Event,
    userId: string,
    now: Date = new Date(),
  ): Promise<GoTogetherCardResponse> {
    const config = await this.host.effectiveConfig(event);
    const eventBlocker = this.eligibility.eventBlocker(event, config, now);
    const memberBlocker =
      (await this.eligibility.memberBlockers(event.id, [userId], now)).get(
        userId,
      ) ?? null;
    const [entry, incoming, profile] = await Promise.all([
      this.entries.findOne({ where: { eventId: event.id, userId } }),
      this.findIncomingInvite(event.id, userId),
      this.profileService.getMine(userId),
    ]);
    const hasProfile = profile.questionnaireVersion !== null;
    const isFeedbackOpen = feedbackWindow(config, now).isOpen;
    const activeEntry = entry?.status === 'withdrawn' ? null : entry;
    const { state, reason } = computeCardState({
      eventBlocker,
      memberBlocker,
      hasUsableProfile: hasProfile && !profile.needsRefresh,
      entry: activeEntry,
      hasIncomingPairInvite: incoming !== null,
      isFeedbackOpen,
      isFinalPassDone: config?.lateGroupAt != null,
    });

    return {
      state,
      ineligibleReason: reason,
      // The time matching actually runs, even after the gathering moved.
      cutoffAt: config
        ? effectiveCutoffAt(config.cutoffAt, event.startAt).toISOString()
        : null,
      optInClosesAt: optInClosesAt(event).toISOString(),
      hostQuestions: config?.hostQuestions ?? [],
      unansweredHostQuestionIds:
        state === 'waiting' && activeEntry && config
          ? unansweredHostQuestionIds(
              config.hostQuestions,
              activeEntry.hostAnswers,
            )
          : [],
      pair: await this.buildPair(activeEntry, incoming),
      lens: activeEntry?.lens ?? null,
      groupId: activeEntry?.groupId ?? null,
      profile: { exists: hasProfile, needsRefresh: profile.needsRefresh },
    };
  }

  private async buildPair(
    entry: EventMatchEntry | null,
    incoming: EventMatchEntry | null,
  ): Promise<GoTogetherCardResponse['pair']> {
    let partnerId: string;
    let status: 'pending' | 'accepted';
    let direction: 'sent' | 'received';
    if (entry?.pairPartnerId && entry.pairStatus !== 'none') {
      partnerId = entry.pairPartnerId;
      status = entry.pairStatus;
      direction = 'sent';
    } else if (incoming) {
      partnerId = incoming.userId;
      status = 'pending';
      direction = 'received';
    } else {
      return null;
    }
    const partner = toMemberRef(
      await this.profiles.findOne({ where: { userId: partnerId } }),
    );
    return partner ? { partner, status, direction } : null;
  }

  /** The newest open invite a friend sent this member for this gathering. */
  private findIncomingInvite(
    eventId: string,
    userId: string,
  ): Promise<EventMatchEntry | null> {
    return this.entries.findOne({
      where: {
        eventId,
        pairPartnerId: userId,
        pairStatus: 'pending',
        status: 'waiting',
      },
      order: { updatedAt: 'DESC' },
    });
  }

  /** The checks shared by opting in and accepting a friend's invite. */
  private async assertMayJoin(
    event: Event,
    userId: string,
    dto: PairAnswersDto,
  ): Promise<JoinCheck> {
    const config = await this.openConfig(event);
    await this.assertMemberEligible(event.id, userId);
    if (!(await this.profileService.findUsable(userId))) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Fill in the Go together questions first',
        code: 'GO_TOGETHER_PROFILE_NEEDED',
      });
    }
    const parsedAnswers = parseHostAnswers(
      config.hostQuestions,
      dto.hostAnswers,
    );
    if (!parsedAnswers.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: "Answer the host's questions",
        code: 'GO_TOGETHER_INVALID_ANSWERS',
        errors: parsedAnswers.errors,
      });
    }
    const lens = dto.lens ?? null;
    if (lens && dto.lensConsent !== true) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Confirm you are happy to share your group focus',
        code: 'GO_TOGETHER_LENS_CONSENT_REQUIRED',
      });
    }
    const existing = await this.entries.findOne({
      where: { eventId: event.id, userId },
    });
    if (existing?.status === 'grouped') {
      throw new ConflictException({
        statusCode: 409,
        message: 'You already have a group for this gathering',
        code: 'GO_TOGETHER_ALREADY_GROUPED',
      });
    }
    return {
      hostAnswers: parsedAnswers.value,
      answeredQuestions: config.hostQuestions,
      lens,
      existing,
    };
  }

  /** The config when Go together is open for this gathering, else a 409. */
  private async openConfig(event: Event): Promise<EventMatchConfig> {
    const config = await this.host.effectiveConfig(event);
    const eventBlocker = this.eligibility.eventBlocker(event, config);
    if (eventBlocker || !config) {
      throw unavailableError(eventBlocker ?? 'notEnabled');
    }
    return config;
  }

  /** The same member checks for joining and for answering again. */
  private async assertMemberEligible(
    eventId: string,
    userId: string,
  ): Promise<void> {
    const memberBlocker = (
      await this.eligibility.memberBlockers(eventId, [userId])
    ).get(userId);
    if (memberBlocker) {
      throw new ForbiddenException({
        statusCode: 403,
        message: 'You cannot join Go together for this gathering',
        code: 'GO_TOGETHER_INELIGIBLE',
        reason: memberBlocker,
      });
    }
  }

  /** An accepted pair always shares one lens (`isPairFeasible` compares it). */
  private assertSameLens(lens: Lens | null, partnerLens: Lens | null): void {
    if (lens !== partnerLens) {
      throw new ConflictException({
        statusCode: 409,
        message: 'Pick the same group focus as your friend',
        code: 'GO_TOGETHER_LENS_MISMATCH',
      });
    }
  }

  /**
   * Makes the caller and `inviter` an accepted pair in one transaction. The
   * upsert overwrites the caller's own pair fields, which clears any invite
   * they had sent; a previous accepted partner and anyone else still waiting
   * on the caller go back to solo.
   */
  private async completeAcceptance(
    eventId: string,
    userId: string,
    inviter: EventMatchEntry,
    existing: EventMatchEntry | null,
    answerFields: AnswerFields,
    answeredQuestions: HostQuestion[],
  ): Promise<void> {
    const previousAcceptedPartnerId =
      existing?.pairStatus === 'accepted' &&
      existing.pairPartnerId !== inviter.userId
        ? existing.pairPartnerId
        : null;
    await this.dataSource.transaction(async (manager) => {
      // The config first, in the order a host save locks: a switch-off that
      // committed meanwhile refuses the acceptance, and one that starts later
      // waits and then sweeps both entries.
      const lockedConfig = await manager
        .getRepository(EventMatchConfig)
        .findOne({ where: { eventId }, lock: { mode: 'pessimistic_read' } });
      if (!lockedConfig?.enabled) throw unavailableError('notEnabled');
      const staleQuestionIds = changedHostQuestionIds(
        answeredQuestions,
        lockedConfig.hostQuestions,
      );
      const entryRepository = manager.getRepository(EventMatchEntry);
      // Guarded so an inviter who re-invited someone else in the meantime is
      // left alone.
      const inviterUpdate = await entryRepository.update(
        { id: inviter.id, pairPartnerId: userId, status: 'waiting' },
        { pairStatus: 'accepted' },
      );
      if (!inviterUpdate.affected) throw partnerUnavailableError();
      if (previousAcceptedPartnerId) {
        await entryRepository.update(
          { eventId, userId: previousAcceptedPartnerId, pairPartnerId: userId },
          { pairStatus: 'none', pairPartnerId: null },
        );
      }
      await this.upsertEntry(entryRepository, eventId, userId, existing, {
        status: 'waiting',
        pairPartnerId: inviter.userId,
        pairStatus: 'accepted',
        groupId: null,
        mergeOfferGroupId: null,
        ...answerFields,
        hostAnswers: omitHostAnswers(
          answerFields.hostAnswers,
          staleQuestionIds,
        ),
      });
      await entryRepository.update(
        {
          eventId,
          pairPartnerId: userId,
          pairStatus: 'pending',
          id: Not(inviter.id),
        },
        { pairStatus: 'none', pairPartnerId: null },
      );
    });
  }

  /** The friend when they can be invited, with their entry, else a 409. */
  private async resolvePartner(
    event: Event,
    userId: string,
    partnerSlug: string | undefined,
  ): Promise<{ partnerId: string; partnerEntry: EventMatchEntry | null }> {
    if (!partnerSlug) throw partnerUnavailableError();
    const partnerProfile = await this.profiles.findOne({
      where: { slug: partnerSlug },
    });
    const partnerId = partnerProfile?.userId;
    if (!partnerId || partnerId === userId) throw partnerUnavailableError();
    if (!(await this.connections.areConnected(userId, partnerId))) {
      throw partnerUnavailableError();
    }
    const partnerBlockers = await this.eligibility.memberBlockers(event.id, [
      partnerId,
    ]);
    if (partnerBlockers.has(partnerId)) throw partnerUnavailableError();
    const partnerEntry = await this.entries.findOne({
      where: { eventId: event.id, userId: partnerId },
    });
    const isPartnerGrouped = partnerEntry?.status === 'grouped';
    const isPartnerPairedElsewhere =
      partnerEntry?.pairStatus === 'accepted' &&
      partnerEntry.pairPartnerId !== userId;
    if (isPartnerGrouped || isPartnerPairedElsewhere) {
      throw partnerUnavailableError();
    }
    return { partnerId, partnerEntry };
  }

  /** Puts a former partner back to waiting alone, when they still point at
   *  the caller. */
  private async resetPartnerToSolo(
    eventId: string,
    partnerId: string,
    userId: string,
  ): Promise<void> {
    await this.entries.update(
      { eventId, userId: partnerId, pairPartnerId: userId },
      { pairStatus: 'none', pairPartnerId: null },
    );
  }

  /** UQ(event_id, user_id): update the existing row or create the first one. */
  private async upsertEntry(
    repository: Repository<EventMatchEntry>,
    eventId: string,
    userId: string,
    existing: EventMatchEntry | null,
    fields: EntryWrite,
  ): Promise<EventMatchEntry> {
    const row = existing
      ? Object.assign(existing, fields)
      : repository.create({ eventId, userId, ...fields });
    return repository.save(row);
  }
}

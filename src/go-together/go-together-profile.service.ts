import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { UpsertFriendMatchProfileDto } from './dto/upsert-friend-match-profile.dto';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { parseFriendMatchAnswers } from './go-together-answers';
import { PENDING_STATUSES } from './go-together-formation.service';
import {
  FriendMatchAnswers,
  MIN_ACCEPTED_QUESTIONNAIRE_VERSION,
  QUESTIONNAIRE_VERSION,
} from './go-together-questionnaire.catalog';

const REFRESH_SUGGESTED_AFTER_MS = 182 * 24 * 60 * 60 * 1000;

export interface FriendMatchProfileResponse {
  answers: FriendMatchAnswers | null;
  questionnaireVersion: number | null;
  currentVersion: number;
  needsRefresh: boolean;
  refreshSuggested: boolean;
  consentedAt: string | null;
  updatedAt: string | null;
}

function toResponse(
  row: FriendMatchProfile | null,
  now: Date,
): FriendMatchProfileResponse {
  if (!row) {
    return {
      answers: null,
      questionnaireVersion: null,
      currentVersion: QUESTIONNAIRE_VERSION,
      needsRefresh: false,
      refreshSuggested: false,
      consentedAt: null,
      updatedAt: null,
    };
  }
  return {
    answers: row.answers,
    questionnaireVersion: row.questionnaireVersion,
    currentVersion: QUESTIONNAIRE_VERSION,
    needsRefresh: row.questionnaireVersion < MIN_ACCEPTED_QUESTIONNAIRE_VERSION,
    refreshSuggested: row.updatedAt
      ? now.getTime() - row.updatedAt.getTime() > REFRESH_SUGGESTED_AFTER_MS
      : false,
    consentedAt: row.consentedAt.toISOString(),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * The member's own questionnaire. Nobody else can read these answers: no
 * route returns another member's profile, hosts see counts only, and group
 * members see only the reasons built in `go-together-reasons.ts`.
 */
@Injectable()
export class GoTogetherProfileService {
  constructor(
    @InjectRepository(FriendMatchProfile)
    private readonly profiles: Repository<FriendMatchProfile>,
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
  ) {}

  async getMine(userId: string): Promise<FriendMatchProfileResponse> {
    return toResponse(
      await this.profiles.findOne({ where: { userId } }),
      new Date(),
    );
  }

  async findUsable(userId: string): Promise<FriendMatchProfile | null> {
    const row = await this.profiles.findOne({ where: { userId } });
    if (!row || row.questionnaireVersion < MIN_ACCEPTED_QUESTIONNAIRE_VERSION)
      return null;
    return row;
  }

  async upsertMine(
    userId: string,
    dto: UpsertFriendMatchProfileDto,
  ): Promise<FriendMatchProfileResponse> {
    if (dto.consent !== true) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Consent is needed to use your answers for matching',
        code: 'GO_TOGETHER_CONSENT_REQUIRED',
      });
    }
    const parsed = parseFriendMatchAnswers(dto.answers);
    if (!parsed.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Some answers need another look',
        code: 'GO_TOGETHER_INVALID_ANSWERS',
        errors: parsed.errors,
      });
    }
    const existing = await this.profiles.findOne({ where: { userId } });
    const row =
      existing ??
      this.profiles.create({
        userId,
        consentedAt: new Date(),
        lastUsedAt: null,
      });
    row.answers = parsed.value;
    row.questionnaireVersion = QUESTIONNAIRE_VERSION;
    return toResponse(await this.profiles.save(row), new Date());
  }

  /**
   * Withdrawing consent stops the processing. Every pending entry (waiting,
   * or unmatched and still live for late places) is withdrawn with its lens
   * erased, and any pair partner goes back to solo; a grouped entry stays,
   * because leaving a chat of real people is the group's own Leave action.
   * Then the answers are deleted.
   */
  async deleteMine(userId: string): Promise<{ ok: true }> {
    const pending = await this.entries.find({
      where: { userId, status: In(PENDING_STATUSES) },
    });
    for (const entry of pending) {
      if (entry.pairPartnerId && entry.pairStatus === 'accepted') {
        await this.entries.update(
          { eventId: entry.eventId, userId: entry.pairPartnerId },
          { pairStatus: 'none', pairPartnerId: null },
        );
      }
    }
    if (pending.length > 0) {
      await this.entries.update(
        {
          userId,
          id: In(pending.map((entry) => entry.id)),
          status: In(PENDING_STATUSES),
        },
        {
          status: 'withdrawn',
          pairStatus: 'none',
          pairPartnerId: null,
          mergeOfferGroupId: null,
          lens: null,
          lensConsentedAt: null,
        },
      );
    }
    await this.entries.update(
      { pairPartnerId: userId, pairStatus: 'pending' },
      { pairStatus: 'none', pairPartnerId: null },
    );
    await this.profiles.delete({ userId });
    return { ok: true };
  }

  /**
   * Stamps the last opt-in that used the answers. `updated_at` is written
   * back to itself so the update does not bump it: it stays the time of the
   * last edit, which the six-month refresh hint and the settings page read.
   */
  async touchUsed(userId: string): Promise<void> {
    await this.profiles.update(
      { userId },
      { lastUsedAt: new Date(), updatedAt: () => '"updated_at"' },
    );
  }
}

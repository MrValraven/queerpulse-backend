import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { PAGE_SIZE } from '../common/pagination';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';
import {
  AdminResourceSuggestionDTO,
  AdminResourceSuggestionsPageDTO,
  toAdminResourceSuggestionDTO,
} from './resource-suggestion-response';
import { ListAdminResourceSuggestionsQuery } from './dto/list-admin-resource-suggestions.query';

/**
 * Read model + decision transitions behind the admin resource-suggestion
 * review queue (CNT-14) — mirrors `AdminReadingGroupProposalsService`
 * exactly, including resolving suggesters in ONE batched profile lookup per
 * page, never one query per row.
 */
@Injectable()
export class AdminResourceSuggestionsService {
  private readonly logger = new Logger(AdminResourceSuggestionsService.name);

  constructor(
    @InjectRepository(ResourceSuggestion)
    private readonly suggestions: Repository<ResourceSuggestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly submissionDecisions: SubmissionDecisionNotifier,
  ) {}

  async list(
    query: ListAdminResourceSuggestionsQuery,
  ): Promise<AdminResourceSuggestionsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;

    const qb = this.suggestions
      .createQueryBuilder('suggestion')
      .orderBy('suggestion.createdAt', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    if (query.category) {
      qb.andWhere('suggestion.category = :category', {
        category: query.category,
      });
    }
    if (query.status) {
      qb.andWhere('suggestion.status = :status', { status: query.status });
    }

    const [rows, total] = await qb.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize: PAGE_SIZE };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const refsByUserId = await memberLookup.byUserIds(memberIds);

    const items = rows.map((suggestion) =>
      toAdminResourceSuggestionDTO(
        suggestion,
        refsByUserId.get(suggestion.memberId) ?? null,
      ),
    );

    return { items, total, page, pageSize: PAGE_SIZE };
  }

  /**
   * Approve a suggestion — record it as accepted. Deliberately does NOT
   * create a `ResourceListing`: this service holds no `Repository<ResourceListing>`
   * at all, so it structurally cannot write one. An admin who has actually
   * verified the organisation creates the real listing by hand via
   * `AdminResourceListingsController`, using this suggestion as a reference.
   */
  approve(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Approved,
      adminUserId,
      note,
    );
  }

  decline(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Declined,
      adminUserId,
      note,
    );
  }

  archive(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Archived,
      adminUserId,
      note,
    );
  }

  private async decide(
    id: string,
    status: ResourceSuggestionStatus,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    const suggestion = await this.suggestions.findOne({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException('Resource suggestion not found.');
    }

    // Captured BEFORE the write: re-clicking approve on an already-approved
    // suggestion still restamps `decidedAt` and the note, which is a
    // legitimate correction, but it is not news. Notifying again would put a
    // second identical row in the member's bell for a decision they were
    // already told about.
    const isRepeatDecision = suggestion.status === status;

    suggestion.status = status;
    suggestion.decidedAt = new Date();
    suggestion.decidedBy = adminUserId;
    suggestion.decisionNote = note?.trim() ? note.trim() : null;
    const saved = await this.suggestions.save(suggestion);

    // AFTER the decision has committed, and best-effort: see
    // `notifyMemberOfDecision`.
    if (!isRepeatDecision) {
      await this.notifyMemberOfDecision(saved);
    }

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([saved.memberId]);

    return toAdminResourceSuggestionDTO(
      saved,
      refsByUserId.get(saved.memberId) ?? null,
    );
  }

  /**
   * Tell the member what happened to the resource they suggested (PRD-45).
   *
   * Goes through the shared `SubmissionDecisionNotifier` rather than writing
   * a notification type of its own, so a suggested resource, a partner
   * application and a barter proposal all report back the same way and adding
   * a fourth intake is a decision the compiler forces
   * (`SUBMISSION_KIND_NOTIFICATION` is total over `SubmissionKind`).
   *
   * ARCHIVE IS DELIBERATELY SILENT, and this is the one judgement call here.
   * Archiving is how the queue is tidied: a duplicate, a row about a service
   * that never existed, a stale item nobody is going to act on. It is not a
   * verdict on the suggestion, and `AdminReadingGroupProposalsService.archive`
   * (the intake this module mirrors) takes exactly the same position, in
   * exactly the same words: a notification whose only content is that nobody
   * decided. The member is not left guessing either way, because the state
   * still shows honestly on `GET /resources/suggestions/mine`. The division of
   * labour the submit copy now promises is precisely that: the bell carries
   * verdicts, the member's own submissions page carries state.
   *
   * BEST EFFORT. `SubmissionDecisionNotifier.notifyDecided` already swallows
   * its own failures and documents that it never throws; the `try` here is
   * defence in depth so a future change inside the notifier can never turn a
   * bell outage into a 500 on an admin's decision that has already committed.
   * An admin who saw a 500 would reasonably retry, and the retry would land on
   * an already-decided row.
   */
  private async notifyMemberOfDecision(
    suggestion: ResourceSuggestion,
  ): Promise<void> {
    const outcome = AdminResourceSuggestionsService.outcomeFor(
      suggestion.status,
    );
    if (!outcome) return;

    // `resource_suggestion.member_id` is `NOT NULL` with an
    // `ON DELETE CASCADE` FK, so an erased member takes their suggestions
    // with them and there is normally nobody to skip. This guards the blank
    // case anyway rather than asking the notifier to write a row addressed to
    // nobody.
    if (!suggestion.memberId) return;

    try {
      await this.submissionDecisions.notifyDecided({
        recipientId: suggestion.memberId,
        kind: SubmissionKind.ResourceSuggestion,
        outcome,
        // The member's own words: the organisation they named. Safe to read
        // back for the same reason `ReadingGroupProposalDecided` reads back
        // the book title.
        subjectLabel: suggestion.name,
        // The reviewer's reason, written TO this member: see
        // `DecideResourceSuggestionDto`, which says so to the staff member
        // typing it. The bell is one of only two places it can land, since
        // QueerPulse sends no email.
        reviewNote: suggestion.decisionNote,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to notify the member of resource suggestion ${suggestion.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * This intake's own status vocabulary, mapped onto the three shared
   * `SubmissionOutcome` values. `null` means "say nothing", which is the
   * answer for both statuses that are not a terminal verdict: `pending`
   * (nothing has happened yet) and `archived` (see `notifyMemberOfDecision`).
   */
  private static outcomeFor(
    status: ResourceSuggestionStatus,
  ): SubmissionOutcome | null {
    switch (status) {
      case ResourceSuggestionStatus.Approved:
        return SubmissionOutcome.Accepted;
      case ResourceSuggestionStatus.Declined:
        return SubmissionOutcome.Declined;
      case ResourceSuggestionStatus.Archived:
      case ResourceSuggestionStatus.Pending:
        return null;
    }
  }
}

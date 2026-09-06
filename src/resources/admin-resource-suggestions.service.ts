import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { PAGE_SIZE } from '../common/pagination';
import { SubmissionDecisionNotifier } from '../submissions/submission-decision-notifier.service';
import {
  SubmissionKind,
  SubmissionOutcome,
} from '../submissions/submission-kinds';
import { Profile } from '../users/entities/profile.entity';
import { ApproveResourceSuggestionDto } from './dto/approve-resource-suggestion.dto';
import {
  ResourceListing,
  ResourceListingStatus,
} from './entities/resource-listing.entity';
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

/** Empty or blank in, NULL out — a contact field a reviewer cleared means
 *  "there is no phone number", not "the empty string". Mirrors
 *  `AdminResourceListingsService.create`. */
function trimmedOrNull(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Read model + decision transitions behind the admin resource-suggestion
 * review queue (CNT-14) — mirrors `AdminReadingGroupProposalsService`
 * exactly, including resolving suggesters in ONE batched profile lookup per
 * page, never one query per row.
 *
 * The one place it now diverges from that sibling is `approve`, which
 * publishes a real `ResourceListing` rather than only recording a verdict
 * (PRD-269). See that method for why.
 */
@Injectable()
export class AdminResourceSuggestionsService {
  private readonly logger = new Logger(AdminResourceSuggestionsService.name);

  constructor(
    @InjectRepository(ResourceSuggestion)
    private readonly suggestions: Repository<ResourceSuggestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly submissionDecisions: SubmissionDecisionNotifier,
    // Approving writes two tables and must not be able to half-happen, so
    // this service owns a transaction rather than two repository saves. Same
    // idiom as `VouchService`: `dataSource.transaction(async (manager) => …)`
    // with a pessimistic lock on the row being decided.
    private readonly dataSource: DataSource,
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
   * Approve a suggestion, and PUBLISH IT (PRD-269).
   *
   * ---------------------------------------------------------------------
   * The defect this closes
   * ---------------------------------------------------------------------
   * Approving used to flip a status and tell the member their resource had
   * been accepted, and stop. The organisation itself only reached the public
   * directory if somebody later remembered to open a different console and
   * retype it. So the member was told "accepted" while nothing appeared, for
   * as long as nobody remembered, and when somebody did the phone number and
   * URL were keyed a second time by hand. On a legal-aid or clinic list, a
   * transposed digit in that second keying is the whole cost of the defect.
   *
   * ---------------------------------------------------------------------
   * The human verification step did not go away
   * ---------------------------------------------------------------------
   * It moved INTO the approval. `ApproveResourceSuggestionDto.listing` is
   * required, and the console pre-fills it from the suggestion and asks the
   * reviewer to confirm or correct every field first. The listing written
   * here is therefore the REVIEWER'S text, never the member's unverified
   * words copied through, and the fields a suggestion cannot capture at all
   * (`region`, and a contact where the member gave none) are supplied by the
   * person who checked rather than defaulted by this code.
   *
   * ---------------------------------------------------------------------
   * One transaction, and two guards
   * ---------------------------------------------------------------------
   * The listing and the status flip commit together, so a failure can never
   * leave a suggestion marked approved with nothing in the directory, which
   * is precisely the state the old two-step flow produced on purpose.
   *
   * Both guards run inside that transaction, against a row locked
   * `pessimistic_write`, so a double-click or two curators on the same queue
   * serialize rather than both passing the check:
   *
   *  - already `approved` is a `409`. Unlike decline and archive, where
   *    restamping a note is a legitimate correction, a second approve would
   *    mean a second listing for the same organisation.
   *  - `createdListingId` already set is a `409` too, and it is the stronger
   *    of the two: it catches a row whose status was moved by some other
   *    path. The partial unique index behind the column is the last line, so
   *    even a serialization anomaly cannot produce two listings.
   */
  async approve(
    id: string,
    adminUserId: string,
    dto: ApproveResourceSuggestionDto,
  ): Promise<AdminResourceSuggestionDTO> {
    const { suggestion, listing } = await this.dataSource.transaction(
      async (manager) => {
        const locked = await manager.findOne(ResourceSuggestion, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked) {
          throw new NotFoundException('Resource suggestion not found.');
        }
        if (locked.createdListingId) {
          throw new ConflictException(
            'This suggestion has already been published to the directory.',
          );
        }
        if (locked.status === ResourceSuggestionStatus.Approved) {
          throw new ConflictException(
            'This suggestion has already been approved.',
          );
        }

        const createdListing = await manager.save(
          manager.create(ResourceListing, {
            category: dto.listing.category,
            title: dto.listing.title.trim(),
            description: dto.listing.description.trim(),
            phone: trimmedOrNull(dto.listing.phone),
            email: trimmedOrNull(dto.listing.email),
            website: trimmedOrNull(dto.listing.website),
            region: trimmedOrNull(dto.listing.region),
            status: dto.listing.status ?? ResourceListingStatus.Active,
            createdBy: adminUserId,
            updatedBy: adminUserId,
          }),
        );

        locked.status = ResourceSuggestionStatus.Approved;
        locked.decidedAt = new Date();
        locked.decidedBy = adminUserId;
        locked.decisionNote = trimmedOrNull(dto.note);
        locked.createdListingId = createdListing.id;
        const savedSuggestion = await manager.save(locked);

        return { suggestion: savedSuggestion, listing: createdListing };
      },
    );

    // AFTER the transaction has committed, and best-effort — the same
    // contract `decide` documents below, for the same reason: an admin who
    // saw a 500 from a bell outage would retry onto an already-approved row,
    // which now 409s.
    await this.notifyMemberOfDecision(suggestion, listing);

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([suggestion.memberId]);

    return toAdminResourceSuggestionDTO(
      suggestion,
      refsByUserId.get(suggestion.memberId) ?? null,
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

  /**
   * The shared decline/archive transition. `approve` no longer routes through
   * it (PRD-269): approving writes a second table and needs a transaction and
   * a lock, which the two verdicts that only stamp a status do not.
   */
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

    // A published approval cannot be quietly walked back here. Flipping this
    // row to `declined` would leave the organisation live in the public
    // directory while the queue said it had been turned down, and the member
    // would get a second, contradicting bell. Taking the listing down is a
    // deliberate act on `/admin/resource-listings`, and it has to happen
    // there first.
    if (suggestion.createdListingId) {
      throw new ConflictException(
        'This suggestion is published in the directory. Archive or delete its listing on Resource listings first.',
      );
    }

    // Captured BEFORE the write: re-deciding the same way still restamps
    // `decidedAt` and the note, which is a legitimate correction, but it is
    // not news. Notifying again would put a second identical row in the
    // member's bell for a decision they were already told about.
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
    publishedListing?: ResourceListing,
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
        // PRD-269. "Accepted" now has somewhere real to point: the public
        // directory page the organisation is on as of this decision. Sent
        // only when an approval actually produced a listing, so a decline
        // keeps the submissions index (where its reason is), and so does an
        // approval that was decided before this transition published
        // anything.
        //
        // The CATEGORY, not an id: `GET /resources/listings` returns a small
        // curated set that the two category pages render inline, and there is
        // no per-listing page to link to. `resource_directory` is declared on
        // this kind's `alternateDeepLinkSources`, which is why the notifier
        // accepts it; any other value it would silently ignore.
        ...(publishedListing
          ? {
              deepLinkSource: 'resource_directory' as const,
              deepLinkSlug: publishedListing.category,
            }
          : {}),
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

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { EditSuggestionDTO, toEditSuggestionDTO } from './listing-response';
import {
  collectAcceptedSuggestionValueErrors,
  isAcceptedSuggestionValueValid,
  resolveAcceptedSuggestionTarget,
} from './accepted-suggestion-value';

export interface ListEditSuggestionsQueryInput {
  status?: ListingEditSuggestionStatus;
}

/** What `submit`/`resolve` hand back to the FE — the FE modal (a later,
 * separate task) needs only the identity + current status, not the full
 * admin-queue shape (`EditSuggestionDTO`) that requires a listing/member
 * join. Mirrors `StorySubmissionsService.create`'s minimal-response shape. */
export interface EditSuggestionResult {
  id: string;
  status: ListingEditSuggestionStatus;
}

/**
 * One admin-queue row: the shared `EditSuggestionDTO` widened with the
 * suggester's typed replacement value, so a moderator sees the exact proposal
 * next to the prose and can judge both before clicking accept.
 *
 * Widened here rather than inside `toEditSuggestionDTO` because this queue is
 * the only surface that serialises a suggestion, and the mapper stays the
 * shared shape other listing responses reference.
 */
export interface EditSuggestionQueueDTO extends EditSuggestionDTO {
  /** `null` when the member reported a problem without proposing a fix. */
  proposedValue: string | null;
}

/**
 * "Suggest an edit" — a non-owner member's proposed correction to a business
 * listing (spec: `field` + free-text `message`), landing in a
 * moderator-reviewable queue. Mirrors `StorySubmissionsService`'s
 * member-submits/staff-reviews shape; kept as its own service (not folded
 * into `ListingsService`) since it owns a distinct entity + resolution model
 * with no overlap with the listing CRUD/moderation methods there.
 */
@Injectable()
export class ListingEditSuggestionsService {
  private readonly logger = new Logger(ListingEditSuggestionsService.name);

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingEditSuggestion)
    private readonly suggestions: Repository<ListingEditSuggestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Keyed by the listing's public `slug`, NOT `ref` — this is a non-owner
   * action reached from the public `/local/directory/:slug` detail page,
   * which only ever has the `slug` (`ref` is exposed solely on the
   * owner-scoped `ListingDTO`, 403'd for a non-owner). Mirrors
   * `DirectoryService.addReview`'s identical slug-keyed, `Live`-only lookup
   * (`loadLiveOr404` below) — a non-live listing has no public detail page to
   * suggest an edit from.
   *
   * Any active member may submit — this is a non-owner correction, so unlike
   * every `:ref` mutation on `ListingsController` there is no `assertOwner`
   * gate here. The one exception: the owner themself is blocked (below),
   * since they can already PATCH the listing directly and a self-suggestion
   * would just be noise in the moderation queue.
   */
  async submit(
    slug: string,
    userId: string,
    dto: CreateEditSuggestionDto,
  ): Promise<EditSuggestionResult> {
    const listing = await this.loadLiveOr404(slug);

    if (listing.ownerId === userId) {
      throw new BadRequestException(
        'You own this listing — edit it directly instead of suggesting a change',
      );
    }

    // `@IsNotEmpty` only rejects an empty string, not a whitespace-only one
    // (mirrors `ListingsService.replyToReview`'s identical re-check).
    const message = dto.message.trim();
    if (!message) {
      throw new BadRequestException('Message cannot be empty');
    }

    // Already trimmed and already validated against the target column's own
    // create-path rules by `IsValidProposedSuggestionValue` on the DTO. Trimmed
    // again here for the same reason `message` is: the class-transformer step
    // is a property of the HTTP pipeline, and this method is also reachable
    // directly. A blank proposal is stored as `null`, so the column has exactly
    // one representation of "no value proposed".
    const proposedValue = dto.proposedValue?.trim() || null;

    const saved = await this.suggestions.save(
      this.suggestions.create({
        listingId: listing.id,
        suggestedByUserId: userId,
        field: dto.field,
        message,
        proposedValue,
        status: ListingEditSuggestionStatus.Pending,
      }),
    );

    return { id: saved.id, status: saved.status };
  }

  /** Moderator/admin-only (`ListingsController.listEditSuggestions`'s
   * `RolesGuard` gate): every suggestion, optionally filtered by status,
   * newest first — the review queue. Bounded like `ListingsService`'s other
   * admin lists so it can never dump an unbounded table. */
  async listForAdmin(
    query: ListEditSuggestionsQueryInput,
  ): Promise<EditSuggestionQueueDTO[]> {
    const qb = this.suggestions
      .createQueryBuilder('s')
      .orderBy('s.created_at', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (query.status) {
      qb.andWhere('s.status = :status', { status: query.status });
    }

    const rows = await qb.getMany();
    if (!rows.length) return [];

    const listingIds = [...new Set(rows.map((row) => row.listingId))];
    const listings = await this.listings.find({
      where: { id: In(listingIds) },
    });
    const listingById = new Map(
      listings.map((listing) => [listing.id, listing]),
    );

    const userIds = rows
      .map((row) => row.suggestedByUserId)
      .filter((id): id is string => id !== null);
    const refs = await new MemberLookup(this.profiles).byUserIds(userIds);

    // A suggestion whose listing has since been hard-deleted has nothing left
    // to render a queue row against — skip it rather than throw, since the
    // FK is `ON DELETE CASCADE` and this should be unreachable in practice.
    return rows
      .map((row): EditSuggestionQueueDTO | null => {
        const listing = listingById.get(row.listingId);
        if (!listing) return null;
        return {
          ...toEditSuggestionDTO(
            row,
            listing,
            row.suggestedByUserId
              ? (refs.get(row.suggestedByUserId) ?? null)
              : null,
          ),
          proposedValue: row.proposedValue,
        };
      })
      .filter((dto): dto is EditSuggestionQueueDTO => dto !== null);
  }

  /** Moderator/admin-only (`ListingsController.resolveEditSuggestion`'s
   * `RolesGuard` gate): accept or dismiss a pending suggestion. Re-resolving
   * an already-resolved row overwrites the prior decision (idempotent
   * update, mirrors `ListingsService.replyToReview`'s overwrite semantics) —
   * there's no narrower state machine in the spec's contract.
   *
   * Accepting used to only flip this row's own status — the listing itself
   * never changed and the owner was never told. It now also applies the
   * correction (where there's a safe column to apply it to) and notifies the
   * owner, best-effort, AFTER this row's own status commits — see
   * `applyAcceptedBestEffort`. A failure there must never surface as if the
   * accept/dismiss itself failed.
   *
   * Which value gets written, highest precedence first:
   *
   *   1. `dto.value`, the moderator's explicit override. They are looking at
   *      the listing and the proposal side by side, so their deliberate typed
   *      correction outranks anything the row carries.
   *   2. `suggestion.proposedValue`, the suggester's typed replacement. This is
   *      the one-click case: a moderator who agrees with the proposal accepts
   *      with an empty body and it is written as it stands, with nobody
   *      retyping it.
   *   3. `suggestion.message`, the prose. The long-standing fallback for rows
   *      filed before proposals existed, and for members who describe the fix
   *      in the message instead of typing it into the field.
   *
   * A moderator override is checked BEFORE anything is mutated, and a bad one
   * is a 400 rather than a silent skip. That is the one place this method
   * refuses outright, and deliberately so: the best-effort silence downstream
   * exists because a member's unconstrained prose must not be able to jam a
   * queue row, while a moderator who typed a value and saw nothing happen
   * cannot tell "applied" from "discarded" and can simply retry. */
  async resolve(
    id: string,
    moderatorUserId: string,
    dto: ResolveEditSuggestionDto,
  ): Promise<EditSuggestionResult> {
    const suggestion = await this.suggestions.findOne({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException('Edit suggestion not found');
    }

    const moderatorValue = dto.value?.trim() || null;
    if (moderatorValue !== null) {
      this.assertModeratorValueApplicable(
        suggestion,
        dto.status,
        moderatorValue,
      );
    }

    suggestion.status =
      dto.status === 'accepted'
        ? ListingEditSuggestionStatus.Accepted
        : ListingEditSuggestionStatus.Dismissed;
    suggestion.resolvedAt = new Date();
    suggestion.resolvedByUserId = moderatorUserId;

    const saved = await this.suggestions.save(suggestion);

    if (saved.status === ListingEditSuggestionStatus.Accepted) {
      await this.applyAcceptedBestEffort(saved, moderatorValue);
    }

    return { id: saved.id, status: saved.status };
  }

  /**
   * Rejects a moderator override that could never be written, before `resolve`
   * mutates anything. Three ways it fails, each answered with the reason:
   * dismissing writes nothing at all, `other` (and any future picker entry with
   * no column behind it yet) has nowhere to write to, and a value that breaks
   * the target column's own create-path rules is the very thing
   * `accepted-suggestion-value.ts` exists to keep out of the table.
   */
  private assertModeratorValueApplicable(
    suggestion: ListingEditSuggestion,
    requestedStatus: ResolveEditSuggestionDto['status'],
    moderatorValue: string,
  ): void {
    if (requestedStatus !== 'accepted') {
      throw new BadRequestException(
        'A replacement value only applies when accepting a suggestion. ' +
          'Dismissing one leaves the listing untouched.',
      );
    }

    const target = resolveAcceptedSuggestionTarget(suggestion.field);
    if (target === null) {
      throw new BadRequestException(
        `The "${suggestion.field}" bucket has no listing column a replacement ` +
          'value can be written to. Accept it without a value and edit the ' +
          'listing directly.',
      );
    }

    const constraintFailures = collectAcceptedSuggestionValueErrors(
      target,
      moderatorValue,
    );
    if (constraintFailures.length > 0) {
      throw new BadRequestException(
        `That value is not valid for "${suggestion.field}": ` +
          constraintFailures.join('; '),
      );
    }
  }

  /**
   * Writes an accepted correction onto the actual `Listing` row and notifies
   * the owner. Best-effort (mirrors `ListingsService.notifyApprovedBestEffort`
   * exactly): the suggestion's own status flip has already committed by the
   * time this runs, so a lookup/save/notify failure here must not undo or
   * appear to undo that decision.
   *
   * Only 3 of the 6 `EDIT_SUGGESTION_FIELDS` map onto a plain string column
   * the free-text `message` can be applied to: `address` ->
   * `Listing.address`, `phone`/`website` -> the matching key in
   * `Listing.social`. `hours` has no safe auto-apply target — `Listing.hours`
   * is a structured per-weekday interval map (`ListingDayHours`), and a
   * free-text correction can't become that shape without a human parsing it,
   * so it lands on the adjoining free-text `hoursNote` column instead (which
   * exists for exactly this: a plain-text clarification shown next to the
   * hours grid). `description` has no dedicated column at all; the closest
   * fit is `tagline` (the detail page's own pull-quote copy), not `blurb`,
   * which is DB-capped at 140 chars and would reject a longer correction
   * outright. `other` is an intentional catch-all with no column to target —
   * accepting it still resolves the queue row and still notifies the owner
   * with the suggested message, it just leaves every listing column
   * untouched (there's nothing safe to overwrite).
   *
   * BE-HSG-04: the value is NEVER written verbatim any more. Every target runs
   * through `isAcceptedSuggestionValueValid`, which re-applies that column's
   * own create-path rules, most importantly the real `@IsSafeExternalUrl()`
   * decorator on `website`. The create path carries that decorator precisely so
   * a `javascript:`/`data:` URL can never be stored, and this path used to
   * bypass it entirely: `message` is 2000 chars of unvalidated free text, so a
   * phishing or scripting URL, or a 2000-char blob in the `address` a map pin
   * and JSON-LD are built from, reached the CDN-cached public detail page the
   * moment a moderator clicked accept on a plausible-looking row.
   *
   * A rejected value skips the column write and is logged; the queue row still
   * resolves and the owner is still notified with the raw message, so the
   * moderator's own decision stands and a human can follow up. Refusing the
   * accept outright would instead leave the row stuck in the queue forever.
   *
   * `moderatorValue` is the override from the resolve body, already checked
   * against this suggestion's target in `assertModeratorValueApplicable`, or
   * `null` when the moderator accepted as-is. It outranks the suggester's
   * `proposedValue`, which in turn outranks the prose `message`. See
   * `resolve`'s doc comment for why that order. Whichever value wins still runs
   * through `isAcceptedSuggestionValueValid` below: a proposal was validated at
   * submit time, but the rules can be tightened between submit and accept, and
   * the check protecting the column belongs next to the write.
   */
  private async applyAcceptedBestEffort(
    suggestion: ListingEditSuggestion,
    moderatorValue: string | null,
  ): Promise<void> {
    try {
      const listing = await this.listings.findOne({
        where: { id: suggestion.listingId },
      });
      // Hard-deleted since the suggestion was filed — nothing left to
      // correct or notify about.
      if (!listing) return;

      // The suggestion's `field` resolved to the column the value actually
      // lands on. `null` is 'other' (or any future field): no column to apply
      // to, so nothing is overwritten and the owner still gets notified below
      // with the raw message.
      const target = resolveAcceptedSuggestionTarget(suggestion.field);

      if (target !== null) {
        const valueToWrite =
          moderatorValue ?? suggestion.proposedValue ?? suggestion.message;

        if (!isAcceptedSuggestionValueValid(target, valueToWrite)) {
          this.logger.warn(
            `Edit suggestion ${suggestion.id} was accepted but not applied: ` +
              `the suggested value fails the validation the create path ` +
              `enforces on "${target}". Listing ${listing.ref} left unchanged.`,
          );
        } else if (target === 'phone') {
          listing.social = { ...listing.social, phone: valueToWrite };
          await this.listings.save(listing);
        } else if (target === 'website') {
          listing.social = { ...listing.social, website: valueToWrite };
          await this.listings.save(listing);
        } else {
          // 'address' | 'hoursNote' | 'tagline' — all plain string columns.
          listing[target] = valueToWrite;
          await this.listings.save(listing);
        }
      }

      // A NULL `ownerId` is an entry whose owner erased their account
      // (`SetNullContentAuthorFksOnUserErasure1794610000000`); the suggestion
      // still applies to the venue, there is just nobody to tell about it.
      if (listing.ownerId === null) return;
      await this.notifications.create(
        listing.ownerId,
        NotificationType.ListingEditSuggestionAccepted,
        {
          source: 'listing',
          listingSlug: listing.slug,
          field: suggestion.field,
        },
      );
    } catch {
      // Intentionally ignored — the suggestion's own accept already
      // committed; a failure here must not surface to the moderator as if
      // the accept itself failed.
    }
  }

  /** Mirrors `DirectoryService.loadLiveOr404` exactly (slug + `Live` status +
   * not owner-paused) — kept as a local copy rather than a shared import since
   * `DirectoryService` doesn't export it, matching how
   * `ListingsService.loadOr404` (by `ref`) stays private/file-local too.
   *
   * Suggestions come from the public detail page, so a listing that page 404s
   * has to 404 here too: a member cannot be suggesting an edit to a listing
   * they have no way of reading. */
  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live, isHiddenByOwner: false },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { CreateEditSuggestionDto } from './dto/create-edit-suggestion.dto';
import { ResolveEditSuggestionDto } from './dto/resolve-edit-suggestion.dto';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import { EditSuggestionDTO, toEditSuggestionDTO } from './listing-response';

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
 * "Suggest an edit" — a non-owner member's proposed correction to a business
 * listing (spec: `field` + free-text `message`), landing in a
 * moderator-reviewable queue. Mirrors `StorySubmissionsService`'s
 * member-submits/staff-reviews shape; kept as its own service (not folded
 * into `ListingsService`) since it owns a distinct entity + resolution model
 * with no overlap with the listing CRUD/moderation methods there.
 */
@Injectable()
export class ListingEditSuggestionsService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingEditSuggestion)
    private readonly suggestions: Repository<ListingEditSuggestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
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

    const saved = await this.suggestions.save(
      this.suggestions.create({
        listingId: listing.id,
        suggestedByUserId: userId,
        field: dto.field,
        message,
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
  ): Promise<EditSuggestionDTO[]> {
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
      .map((row): EditSuggestionDTO | null => {
        const listing = listingById.get(row.listingId);
        if (!listing) return null;
        return toEditSuggestionDTO(
          row,
          listing,
          row.suggestedByUserId
            ? (refs.get(row.suggestedByUserId) ?? null)
            : null,
        );
      })
      .filter((dto): dto is EditSuggestionDTO => dto !== null);
  }

  /** Moderator/admin-only (`ListingsController.resolveEditSuggestion`'s
   * `RolesGuard` gate): accept or dismiss a pending suggestion. Re-resolving
   * an already-resolved row overwrites the prior decision (idempotent
   * update, mirrors `ListingsService.replyToReview`'s overwrite semantics) —
   * there's no narrower state machine in the spec's contract. */
  async resolve(
    id: string,
    moderatorUserId: string,
    dto: ResolveEditSuggestionDto,
  ): Promise<EditSuggestionResult> {
    const suggestion = await this.suggestions.findOne({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException('Edit suggestion not found');
    }

    suggestion.status =
      dto.status === 'accepted'
        ? ListingEditSuggestionStatus.Accepted
        : ListingEditSuggestionStatus.Dismissed;
    suggestion.resolvedAt = new Date();
    suggestion.resolvedByUserId = moderatorUserId;

    const saved = await this.suggestions.save(suggestion);
    return { id: saved.id, status: saved.status };
  }

  /** Mirrors `DirectoryService.loadLiveOr404` exactly (slug + `Live` status) —
   * kept as a local copy rather than a shared import since `DirectoryService`
   * doesn't export it, matching how `ListingsService.loadOr404` (by `ref`)
   * stays private/file-local too. */
  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}

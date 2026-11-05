import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  ListingCoManager,
  ListingCoManagerStatus,
} from './entities/listing-co-manager.entity';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';

/** A gathering's "Run by" line: the business's ref, public slug and name. */
export interface RunByListingRef {
  ref: string;
  slug: string;
  name: string;
}

/** What `assertCanRunGatherings` hands back: the listing id to store, beside its display ref. */
export interface RunnableListingRef extends RunByListingRef {
  id: string;
}

/**
 * The "Run by" line plus the business's PUBLIC directory address, for the one
 * reader that needs it: a gathering's detail, which shows the gathering's own
 * address to every reader when it is this public address
 * (`EventsService.buildDetail`).
 *
 * `publicAddress` follows `VenueListingRef.address` in
 * `listing-lookup.service.ts`: the listing's `address` column, trimmed, and
 * null when its directory page does not print one. The page does not render
 * for a paused, hidden or removed listing, and `resolveForDisplay` already
 * leaves those out. An online-only listing has no premises and reads null. A
 * mobile listing keeps its meeting point, which the listing write rules store
 * in `address` only when the owner placed one, and which its directory page
 * prints for every member. A permanently closed business keeps its address.
 *
 * Kept OFF `RunByListingRef`, which every summary and detail carries as
 * `runByListing`: the caller strips `publicAddress` before it reaches a
 * response.
 */
export interface RunByListingWithPublicAddress extends RunByListingRef {
  publicAddress: string | null;
}

/** The coded 403 for a member who names a listing they do not run. */
export const RUN_BY_NOT_MANAGER_CODE = 'RUN_BY_NOT_MANAGER';

export const RUN_BY_NOT_MANAGER_MESSAGE =
  'Only someone who runs this business can name it as running an event.';

/**
 * "Run by" on gatherings, from the listings side: who may name a listing as
 * running a gathering, and the line every gathering summary and detail
 * carries. Lives in `ListingLookupModule` beside `ListingLookupService`, so
 * `EventsService` reaches it without importing `ListingsModule`.
 */
@Injectable()
export class ListingRunByService {
  // A directory business is reported (and taken down) under either code,
  // keyed by its slug: the pair `ListingLookupService` and
  // `DirectoryService.SUBJECT_TYPES` read.
  private static readonly MODERATION_SUBJECT_TYPES = ['business', 'listing'];

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingCoManager)
    private readonly coManagers: Repository<ListingCoManager>,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * A listing a gathering may newly name as "Run by", checked against every
   * member in `managerUserIds` (the gathering's host, and on an edit the
   * organiser making it). 400 `Run by listing not found` unless the listing
   * is live, shown by its owner, still trading and untouched by a moderator;
   * then 403 `RUN_BY_NOT_MANAGER` unless each member owns it or holds an
   * active co-manager seat on it. The message never names the listing.
   */
  async assertCanRunGatherings(
    listingId: string,
    managerUserIds: readonly string[],
  ): Promise<RunnableListingRef> {
    const listing = await this.listings.findOne({
      where: {
        id: listingId,
        status: ListingStatus.Live,
        isHiddenByOwner: false,
        operatingState: Not(ListingOperatingState.PermanentlyClosed),
      },
    });
    if (
      !listing ||
      (await this.moderatedSlugs([listing.slug])).has(listing.slug)
    ) {
      throw new BadRequestException('Run by listing not found');
    }
    for (const managerUserId of new Set(managerUserIds)) {
      if (!(await this.isRunBy(listing, managerUserId))) {
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          code: RUN_BY_NOT_MANAGER_CODE,
          message: RUN_BY_NOT_MANAGER_MESSAGE,
        });
      }
    }
    return {
      id: listing.id,
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
    };
  }

  /**
   * The "Run by" line for each listing id, in one listing read and one
   * moderation read for a whole page. A listing that is no longer live, that
   * its owner paused, or that a moderator hid or removed is left out, and the
   * gathering reads `runByListing: null`. A permanently closed business keeps
   * its line: its page stays up.
   *
   * With `{ shouldIncludePublicAddress: true }` each line also carries the
   * business's public directory address (`RunByListingWithPublicAddress`),
   * read by the same single listing query.
   */
  async resolveForDisplay(
    listingIds: readonly string[],
  ): Promise<Map<string, RunByListingRef>>;
  async resolveForDisplay(
    listingIds: readonly string[],
    options: { shouldIncludePublicAddress: true },
  ): Promise<Map<string, RunByListingWithPublicAddress>>;
  async resolveForDisplay(
    listingIds: readonly string[],
    options: { shouldIncludePublicAddress?: boolean } = {},
  ): Promise<Map<string, RunByListingRef | RunByListingWithPublicAddress>> {
    const refsById = new Map<
      string,
      RunByListingRef | RunByListingWithPublicAddress
    >();
    const uniqueListingIds = [...new Set(listingIds)];
    if (uniqueListingIds.length === 0) return refsById;
    const shouldIncludePublicAddress =
      options.shouldIncludePublicAddress === true;
    const rows = await this.listings.find({
      where: {
        id: In(uniqueListingIds),
        status: ListingStatus.Live,
        isHiddenByOwner: false,
      },
      select: {
        id: true,
        ref: true,
        slug: true,
        name: true,
        ...(shouldIncludePublicAddress ? { online: true, address: true } : {}),
      },
    });
    const moderatedSlugs = await this.moderatedSlugs(
      rows.map((row) => row.slug),
    );
    for (const row of rows) {
      if (moderatedSlugs.has(row.slug)) continue;
      const displayRef = { ref: row.ref, slug: row.slug, name: row.name };
      refsById.set(
        row.id,
        shouldIncludePublicAddress
          ? {
              ...displayRef,
              publicAddress: ListingRunByService.publicAddressOf(row),
            }
          : displayRef,
      );
    }
    return refsById;
  }

  /** The address the listing's directory page prints, trimmed, or null. See
   *  `RunByListingWithPublicAddress` for the rule. */
  private static publicAddressOf(
    listing: Pick<Listing, 'online' | 'address'>,
  ): string | null {
    if (listing.online) return null;
    const trimmedAddress = (listing.address ?? '').trim();
    return trimmedAddress.length > 0 ? trimmedAddress : null;
  }

  /**
   * The stored name of a listing in any state, or `null` for an unknown id.
   * For the batch preview's notice, which names a "Run by" line the caller
   * can no longer keep: the business may be paused, closed or taken down, and
   * the notice still has to say which one it was. A display read that grants
   * nothing, so it skips every state and moderation check the two reads above
   * apply.
   */
  async displayNameOf(listingId: string): Promise<string | null> {
    const listing = await this.listings.findOne({
      where: { id: listingId },
      select: { id: true, name: true },
    });
    return listing ? listing.name : null;
  }

  private async isRunBy(listing: Listing, userId: string): Promise<boolean> {
    if (listing.ownerId === userId) return true;
    return this.coManagers.exists({
      where: {
        listingId: listing.id,
        userId,
        status: ListingCoManagerStatus.Active,
      },
    });
  }

  private async moderatedSlugs(slugs: readonly string[]): Promise<Set<string>> {
    const states = await this.contentModeration.statesForAnyType(
      ListingRunByService.MODERATION_SUBJECT_TYPES,
      slugs,
    );
    const moderated = new Set<string>();
    for (const [slug, state] of states) {
      if (state.hidden || state.removed) moderated.add(slug);
    }
    return moderated;
  }
}

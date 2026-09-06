import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  CinemaTitle,
  TitleStatus,
} from '../cinema/entities/cinema-title.entity';
import { RosterRole } from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { FlatmateProfile } from '../flatmate-profiles/entities/flatmate-profile.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import {
  HousingListing,
  HousingListingStatus,
} from '../housing-listings/entities/housing-listing.entity';
import { Job } from '../jobs/entities/job.entity';
import {
  Landlord,
  LandlordStatus,
} from '../landlords/entities/landlord.entity';
import { Listing, ListingStatus } from '../listings/entities/listing.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { FeatureKey, isFeatureLaunched } from '../launchedFeatures';
import { BlockFilterService } from '../social/block-filter.service';
import { SavedItem, SavedKind } from './entities/saved-item.entity';
import { toSavedId } from './saved-ref.util';

/** The subject columns availability resolution reads off a saved item. */
export type SavedSubjectRef = Pick<SavedItem, 'subjectType' | 'subjectId'>;

/**
 * Whose eyes the resolution runs through. `null` is the anonymous
 * share-link recipient (`GET /saved-lists/:token` is `@Public()`); a string is
 * the id of a signed-in ACTIVE member, which is the same bar
 * `ActiveMemberGuard` sets on every member-only read below.
 */
export type SavedViewerId = string | null;

/**
 * Postgres refuses a `uuid` comparison against a non-uuid literal with a
 * `22P02` error rather than returning no rows, so an id that cannot be a uuid
 * is dropped before it reaches a uuid-keyed lookup. A saved subject id is
 * member-supplied through the composite ref in the URL, so this is reachable.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The feature whose launch flag gates each kind's own pages. A saved item
 *  pointing into an unlaunched surface has nowhere to navigate: every route
 *  that would render it is 404ed by `LaunchedFeaturesGuard`, so it reads as
 *  unavailable until the flag flips, at which point it comes back on its own. */
const FEATURE_BY_KIND: Record<SavedKind, FeatureKey> = {
  [SavedKind.Article]: 'magazine',
  [SavedKind.Film]: 'cinema',
  [SavedKind.Job]: 'jobs',
  [SavedKind.Post]: 'forum',
  [SavedKind.Event]: 'events',
  [SavedKind.Group]: 'communities',
  [SavedKind.Housing]: 'housingListings',
  [SavedKind.Flatmate]: 'flatmateProfiles',
  [SavedKind.Landlord]: 'landlords',
  [SavedKind.Listing]: 'listings',
};

/**
 * The kinds whose own detail route is reachable WITHOUT an account. Only the
 * business directory is (`DirectoryController` is `@Public()` route by route);
 * every other subject module puts `@UseGuards(ActiveMemberGuard)` on its
 * controller class, so an anonymous share-link recipient tapping that card
 * lands on a sign-in wall rather than the thing. That is precisely the
 * "unavailable" this resolver exists to report, so the anonymous viewer is
 * held to the narrower set rather than told everything is fine.
 */
const ANONYMOUS_READABLE_KINDS: ReadonlySet<SavedKind> = new Set([
  SavedKind.Listing,
]);

/**
 * Resolves, for a page of saved items, which ones still have something on the
 * other end of them (PRD-169).
 *
 * A saved item has always carried a real reference to its subject
 * (`subject_type` + `subject_id` — see `SavedItem`), so nothing here is
 * reconstructing a lost link. What was missing is that NOTHING EVER ASKED
 * whether that subject was still there: `GET /me/saved` and the public share
 * read returned the presentational snapshot verbatim, so a thread that was
 * deleted, a listing taken down, a community turned private and a housing post
 * that filled all kept rendering as a live card pointing at a page that
 * answers 404. On a shared list that lands on somebody who did not save any of
 * it and cannot tell a stale card from a live one.
 *
 * ONE QUERY PER KIND PRESENT ON THE PAGE, never one per item. The subject ids
 * are grouped by kind and each kind's rule runs as a single `slug IN (...)`
 * (or `id IN (...)`) lookup with its module's own visibility predicates folded
 * into the same statement. A page of twenty saved threads costs one query; a
 * mixed page costs at most one per distinct kind on it.
 *
 * EVERY RULE MIRRORS THE SUBJECT MODULE'S OWN READ GATE, deliberately, because
 * the alternative is a saved card that discloses something the subject's own
 * page would 404. A private community's thread title must not leak back
 * through a bookmark, so `post` re-applies `ForumThreadsService.loadOr404`'s
 * block check and private-community check; `group` re-applies
 * `CommunitiesService.getBySlug`'s private/archived/takedown trio; and so on
 * per kind below. When a rule cannot be answered cheaply for a viewer (an
 * event on one of the four per-viewer audience tiers), the answer is
 * "unavailable" rather than a guess: withholding a card the member still has
 * the title of is recoverable, and disclosing one they should not see is not.
 */
@Injectable()
export class SavedAvailabilityService {
  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /**
   * The subset of `refs` whose subject the viewer can still open, as a set of
   * composite `${kind}:${subjectId}` keys (`toSavedId`) so a caller can test a
   * row with one lookup.
   */
  async availableRefs(
    refs: readonly SavedSubjectRef[],
    viewerId: SavedViewerId,
  ): Promise<Set<string>> {
    const available = new Set<string>();
    if (!refs.length) return available;

    const idsByKind = new Map<SavedKind, Set<string>>();
    for (const ref of refs) {
      const existing = idsByKind.get(ref.subjectType);
      if (existing) {
        existing.add(ref.subjectId);
      } else {
        idsByKind.set(ref.subjectType, new Set([ref.subjectId]));
      }
    }

    // Kinds run concurrently: they touch unrelated tables, so there is nothing
    // to serialize them for, and the page waits on the slowest rather than the
    // sum. Bounded by the number of DISTINCT kinds on the page (ten at the
    // absolute maximum), so this cannot fan out with page size.
    await Promise.all(
      [...idsByKind].map(async ([kind, ids]) => {
        const resolved = await this.resolveKind(kind, [...ids], viewerId);
        for (const subjectId of resolved) {
          available.add(toSavedId(kind, subjectId));
        }
      }),
    );

    return available;
  }

  /** The subset of `subjectIds` of one kind that still resolve for the viewer. */
  private async resolveKind(
    kind: SavedKind,
    subjectIds: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    // Two cheap refusals before any SQL: a kind whose whole surface is not
    // launched has no page to navigate to, and an anonymous recipient cannot
    // read anything but the directory whatever the row says.
    if (!isFeatureLaunched(FEATURE_BY_KIND[kind])) return [];
    if (viewerId === null && !ANONYMOUS_READABLE_KINDS.has(kind)) return [];

    switch (kind) {
      case SavedKind.Article:
        return this.resolveArticles(subjectIds);
      case SavedKind.Film:
        return this.resolveFilms(subjectIds);
      case SavedKind.Job:
        return this.resolveJobs(subjectIds, viewerId);
      case SavedKind.Post:
        return this.resolveThreads(subjectIds, viewerId);
      case SavedKind.Event:
        return this.resolveEvents(subjectIds, viewerId);
      case SavedKind.Group:
        return this.resolveCommunities(subjectIds, viewerId);
      case SavedKind.Housing:
        return this.resolveHousingListings(subjectIds, viewerId);
      case SavedKind.Flatmate:
        return this.resolveFlatmateProfiles(subjectIds, viewerId);
      case SavedKind.Landlord:
        return this.resolveLandlords(subjectIds);
      case SavedKind.Listing:
        return this.resolveListings(subjectIds);
    }
  }

  /**
   * `MagazineService.getArticleBySlug`: published and not future-dated. A
   * scheduled piece and an unknown slug are one state on purpose there, and so
   * they are here.
   */
  private async resolveArticles(slugs: string[]): Promise<string[]> {
    const queryBuilder = this.queryBuilderFor(MagazineArticle, 'article')
      .where('article.slug IN (:...slugs)', { slugs })
      .andWhere('article.publishedAt IS NOT NULL')
      .andWhere('article.publishedAt <= now()');
    return this.subjectKeys(queryBuilder, 'article.slug');
  }

  /**
   * A cinema title is addressed by its uuid rather than a slug (the table has
   * no slug column), so a non-uuid subject id resolves to nothing rather than
   * erroring the whole page. Playable means `ready` and published, matching
   * what the catalogue serves.
   */
  private async resolveFilms(subjectIds: string[]): Promise<string[]> {
    const ids = subjectIds.filter((subjectId) => UUID_PATTERN.test(subjectId));
    if (!ids.length) return [];
    const queryBuilder = this.queryBuilderFor(CinemaTitle, 'title')
      .where('title.id IN (:...ids)', { ids })
      .andWhere('title.status = :readyStatus', {
        readyStatus: TitleStatus.Ready,
      })
      .andWhere('title.publishedAt IS NOT NULL')
      .andWhere('title.publishedAt <= now()');
    return this.subjectKeys(queryBuilder, 'title.id');
  }

  /**
   * `JobsService.getBySlug`: the row exists and carries no takedown. A CLOSED
   * posting stays available on purpose, exactly as that route does — a closed
   * job still has a page, and a member who bookmarked it did so to keep the
   * record. The poster is exempt from the takedown gate there and here.
   */
  private async resolveJobs(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    const queryBuilder = this.queryBuilderFor(Job, 'job').where(
      'job.slug IN (:...slugs)',
      { slugs },
    );
    this.excludeModerated(queryBuilder, ['job'], '"job"."slug"', {
      // `savedViewerId` is the bound name `excludeModerated` supplies; the
      // exemption predicate must spell it the same or Postgres refuses the
      // statement outright for an undefined parameter.
      exemptWhen:
        viewerId === null ? null : '"job"."poster_id" = :savedViewerId',
      viewerId,
    });
    return this.subjectKeys(queryBuilder, 'job.slug');
  }

  /**
   * `ForumThreadsService.loadOr404`, predicate for predicate: the thread
   * exists, its author is not blocked in either direction, and a thread scoped
   * to a PRIVATE community is invisible to a non-member.
   *
   * Blocks only, no mute. `loadOr404` checks the same way and says why: a mute
   * is a soft silence that keeps content out of feeds and lists, and opening
   * something you deliberately bookmarked is a direct navigation, not a feed.
   *
   * The `deleted_at` predicate is applied ONLY when the column exists in the
   * entity metadata. Thread-level soft delete is landing separately (contract
   * C1, owned by another agent); probing the metadata rather than the property
   * means this file neither declares that column nor breaks before it arrives,
   * and starts excluding deleted threads the moment it does, with no second
   * edit here.
   */
  private async resolveThreads(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    if (viewerId === null) return [];
    const queryBuilder = this.queryBuilderFor(ForumThread, 'thread').where(
      'thread.slug IN (:...slugs)',
      { slugs },
    );
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"thread"."author_id"',
    );
    queryBuilder.andWhere(
      `(
        "thread"."community_id" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM "communities" "saved_com"
          WHERE "saved_com"."id" = "thread"."community_id"
            AND "saved_com"."access_tier" = :savedPrivateTier
            AND NOT EXISTS (
              SELECT 1 FROM "community_members" "saved_mem"
              WHERE "saved_mem"."community_id" = "saved_com"."id"
                AND "saved_mem"."user_id" = :savedViewerId
            )
        )
      )`,
      { savedPrivateTier: AccessTier.Private, savedViewerId: viewerId },
    );
    if (this.hasColumn(ForumThread, 'deletedAt')) {
      queryBuilder.andWhere('"thread"."deleted_at" IS NULL');
    }
    return this.subjectKeys(queryBuilder, 'thread.slug');
  }

  /**
   * `EventsService.assertCanView`, as far as it can be answered in one
   * statement: published, no takedown, and an audience the viewer is plainly
   * in. `public` and `members` are that; `invite_only`, `network`,
   * `extended_network` and `community` are a per-viewer computation
   * (`EventAudienceGateService`) that has no batched form, so a saved item on
   * one of those tiers reads as unavailable unless the viewer organizes it.
   * Erring that way withholds a card whose title the member still sees. Erring
   * the other way would publish a gathering's existence to somebody its host
   * scoped away from them.
   *
   * A CANCELLED gathering stays available: its page renders the cancellation,
   * and answering "no longer available" for something whose page still
   * explains what happened would hide the very notice the member needs.
   *
   * The takedown is keyed by the event's uuid rather than its slug (see
   * `EventsService.SUBJECT_TYPE`'s call site), hence the `::text` cast against
   * `content_moderation.subject_id`, which is `varchar`.
   */
  private async resolveEvents(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    if (viewerId === null) return [];
    const queryBuilder = this.queryBuilderFor(Event, 'event')
      .where('event.slug IN (:...slugs)', { slugs })
      .andWhere('event.status != :draftStatus', {
        draftStatus: EventStatus.Draft,
      });
    const isOrganizer = `(
      "event"."host_id" = :savedViewerId
      OR EXISTS (
        SELECT 1 FROM "event_cohosts" "saved_cohost"
        WHERE "saved_cohost"."event_id" = "event"."id"
          AND "saved_cohost"."user_id" = :savedViewerId
      )
    )`;
    queryBuilder.andWhere(
      `("event"."visibility" IN (:...savedOpenTiers) OR ${isOrganizer})`,
      {
        savedOpenTiers: [EventVisibility.Public, EventVisibility.Members],
        savedViewerId: viewerId,
      },
    );
    this.excludeModerated(queryBuilder, ['event'], '"event"."id"::text', {
      exemptWhen: isOrganizer,
      viewerId,
    });
    return this.subjectKeys(queryBuilder, 'event.slug');
  }

  /**
   * `CommunitiesService.getBySlug`'s three gates: a PRIVATE community is
   * invisible to a non-member, an ARCHIVED one is invisible to everyone but
   * its own owner/mods, and a takedown does the same. Roster membership answers
   * all three in one `EXISTS` here — the staff exemption is narrower than
   * "on the roster", so a plain member of an archived or taken-down community
   * sees `unavailable`, which is what its own detail route gives them.
   */
  private async resolveCommunities(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    if (viewerId === null) return [];
    const isStaffOfCommunity = `EXISTS (
      SELECT 1 FROM "community_members" "saved_mem"
      WHERE "saved_mem"."community_id" = "community"."id"
        AND "saved_mem"."user_id" = :savedViewerId
        AND "saved_mem"."role" IN (:...savedStaffRoles)
    )`;
    const queryBuilder = this.queryBuilderFor(Community, 'community')
      .where('community.slug IN (:...slugs)', { slugs })
      .andWhere(
        `(
          "community"."access_tier" != :savedPrivateTier
          OR EXISTS (
            SELECT 1 FROM "community_members" "saved_roster"
            WHERE "saved_roster"."community_id" = "community"."id"
              AND "saved_roster"."user_id" = :savedViewerId
          )
        )`,
        { savedPrivateTier: AccessTier.Private, savedViewerId: viewerId },
      )
      .andWhere(
        `("community"."archived_at" IS NULL OR ${isStaffOfCommunity})`,
        {
          savedStaffRoles: [
            RosterRole.Owner,
            RosterRole.CoOwner,
            RosterRole.Mod,
          ],
        },
      );
    this.excludeModerated(queryBuilder, ['community'], '"community"."slug"', {
      exemptWhen: isStaffOfCommunity,
      viewerId,
    });
    return this.subjectKeys(queryBuilder, 'community.slug');
  }

  /**
   * `HousingDirectoryService.detail`: live, no takedown, and neither FILLED nor
   * EXPIRED — with the owner exempt from that last pair, because the owner
   * reaches the same public detail route from their own listings view to
   * un-mark it.
   */
  private async resolveHousingListings(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    if (viewerId === null) return [];
    const queryBuilder = this.queryBuilderFor(HousingListing, 'housing')
      .where('housing.slug IN (:...slugs)', { slugs })
      .andWhere('housing.status = :liveStatus', {
        liveStatus: HousingListingStatus.Live,
      })
      .andWhere(
        `(
          ("housing"."filled_at" IS NULL AND "housing"."expires_at" > now())
          OR "housing"."owner_id" = :savedViewerId
        )`,
        { savedViewerId: viewerId },
      );
    this.excludeModerated(queryBuilder, ['housing'], '"housing"."slug"', {
      exemptWhen: null,
      viewerId,
    });
    return this.subjectKeys(queryBuilder, 'housing.slug');
  }

  /**
   * `FlatmateDirectoryService.detail`: the profile exists, its owner is not
   * blocked either way, and it carries no takedown. The owner is deliberately
   * NOT exempt from the takedown there ("leaving the public detail live for
   * them would leak the shareable link back into circulation"), so no exemption
   * here either.
   */
  private async resolveFlatmateProfiles(
    slugs: string[],
    viewerId: SavedViewerId,
  ): Promise<string[]> {
    if (viewerId === null) return [];
    const queryBuilder = this.queryBuilderFor(
      FlatmateProfile,
      'flatmate',
    ).where('flatmate.slug IN (:...slugs)', { slugs });
    this.blockFilter.excludeBlocked(
      queryBuilder,
      viewerId,
      '"flatmate"."owner_id"',
    );
    this.excludeModerated(queryBuilder, ['flatmate'], '"flatmate"."slug"', {
      exemptWhen: null,
      viewerId,
    });
    return this.subjectKeys(queryBuilder, 'flatmate.slug');
  }

  /** `LandlordsService.loadLiveOr404`: live, and no takedown, for everyone. */
  private async resolveLandlords(slugs: string[]): Promise<string[]> {
    const queryBuilder = this.queryBuilderFor(Landlord, 'landlord')
      .where('landlord.slug IN (:...slugs)', { slugs })
      .andWhere('landlord.status = :liveStatus', {
        liveStatus: LandlordStatus.Live,
      });
    this.excludeModerated(queryBuilder, ['landlord'], '"landlord"."slug"', {
      exemptWhen: null,
      viewerId: null,
    });
    return this.subjectKeys(queryBuilder, 'landlord.slug');
  }

  /**
   * `DirectoryService.loadLiveOr404`: live, not hidden by its owner, and no
   * takedown under either subject type a business is reported under. A
   * PERMANENTLY CLOSED business stays available, as that route intends: every
   * link, bookmark and review ever pointed at it still resolves, and the page
   * renders the closure notice rather than erasing the record.
   *
   * The one kind an anonymous share-link recipient can still open, which is
   * also the kind a shared list is mostly made of.
   */
  private async resolveListings(slugs: string[]): Promise<string[]> {
    const queryBuilder = this.queryBuilderFor(Listing, 'listing')
      .where('listing.slug IN (:...slugs)', { slugs })
      .andWhere('listing.status = :liveStatus', {
        liveStatus: ListingStatus.Live,
      })
      .andWhere('listing.isHiddenByOwner = false');
    this.excludeModerated(
      queryBuilder,
      ['business', 'listing'],
      '"listing"."slug"',
      { exemptWhen: null, viewerId: null },
    );
    return this.subjectKeys(queryBuilder, 'listing.slug');
  }

  // --- internals ---

  /**
   * A query builder over another module's entity through the saved repository's
   * shared entity manager, so `SavedModule` needs no `forFeature` registration
   * for ten tables it only ever reads (the same move
   * `ForumThreadsService.isCommunityHiddenFrom` makes for `Community`).
   */
  private queryBuilderFor<Subject extends ObjectLiteral>(
    entity: { new (): Subject },
    alias: string,
  ): SelectQueryBuilder<Subject> {
    return this.savedItems.manager.createQueryBuilder(entity, alias);
  }

  /**
   * Appends a `NOT EXISTS` dropping any row under a moderator takedown, HIDDEN
   * OR REMOVED. Deliberately not `ContentModerationService.excludeHidden`,
   * which excludes only `hidden` because its callers still render a removed
   * subject as a tombstone. A saved card has no tombstone rendering and the
   * subject's own detail route 404s a removed row, so both states are withheld
   * here.
   *
   * `subjectIdColumn` and `exemptWhen` are spliced verbatim into SQL, so both
   * are literals written above in this file, never member input. Bound
   * parameter names are prefixed `savedModeration` so a caller can still carry
   * `BlockFilterService`'s own fixed parameter on the same builder.
   */
  private excludeModerated<Subject extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<Subject>,
    subjectTypes: string[],
    subjectIdColumn: string,
    options: { exemptWhen: string | null; viewerId: SavedViewerId },
  ): void {
    const notTakenDown = `NOT EXISTS (
      SELECT 1 FROM "content_moderation" "saved_moderation"
      WHERE "saved_moderation"."subject_type" IN (:...savedModerationTypes)
        AND "saved_moderation"."subject_id" = ${subjectIdColumn}
        AND (
          "saved_moderation"."hidden_at" IS NOT NULL
          OR "saved_moderation"."removed_at" IS NOT NULL
        )
    )`;
    const canExempt = options.exemptWhen !== null && options.viewerId !== null;
    queryBuilder.andWhere(
      canExempt ? `(${notTakenDown} OR ${options.exemptWhen})` : notTakenDown,
      {
        savedModerationTypes: subjectTypes,
        ...(canExempt ? { savedViewerId: options.viewerId } : {}),
      },
    );
  }

  /**
   * Runs the builder for the one column that identifies the subject and
   * nothing else. A saved list never needs the subject's own fields (the card
   * renders the stored snapshot), so the resolution reads exactly one narrow
   * column per row and never hydrates ten unrelated entities into memory.
   */
  private async subjectKeys<Subject extends ObjectLiteral>(
    queryBuilder: SelectQueryBuilder<Subject>,
    keyColumn: string,
  ): Promise<string[]> {
    const rows = await queryBuilder
      .select(keyColumn, 'subject_key')
      .getRawMany<{ subject_key: string }>();
    return rows.map((row) => row.subject_key);
  }

  /** Whether the mapped entity actually carries `propertyName` in this build,
   *  used where a sibling module is mid-flight adding a column. */
  private hasColumn(
    entity: { new (): ObjectLiteral },
    propertyName: string,
  ): boolean {
    return this.savedItems.manager.connection
      .getMetadata(entity)
      .columns.some((column) => column.propertyName === propertyName);
  }
}

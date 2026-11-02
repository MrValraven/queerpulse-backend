import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  AttachableListingRef,
  ListingLookupService,
} from '../listings/listing-lookup.service';
import { normalizeAccessibilityAnswers } from '../listings/listing-accessibility';
import {
  ListingRunByService,
  RunnableListingRef,
} from '../listings/listing-run-by.service';
import { EventCohost } from './entities/event-cohost.entity';
import { Event, EventStatus, EventVisibility } from './entities/event.entity';
import {
  eventBatchTemplateCommunityOnly,
  eventBatchTemplateNotFound,
  seededCostKind,
  templateCreateInput,
  wallClockTimeOf,
  type EventBatchTemplateFields,
  type EventBatchTemplateView,
} from './event-batch';

// The taxonomy code a moderator takedown is recorded under for a gathering,
// the same value `EventsService.SUBJECT_TYPE` uses for its detail gate. Kept
// as its own constant here because that one is private to `EventsService`.
const EVENT_MODERATION_SUBJECT_TYPE = 'event';

/**
 * The starting event as one caller may copy it: the event itself, the fields
 * every batch event inherits, and which of its community, run by and venue
 * links survive for this caller. A dropped link is `null` in the kept slot
 * and named in its `...Dropped` slot, so the preview can say what went.
 */
export interface ResolvedEventBatchTemplate {
  template: Event;
  templateFields: EventBatchTemplateFields;
  community: { id: string; slug: string; name: string } | null;
  communityDropped: {
    name: string;
    reason: 'notModerator' | 'unavailable';
  } | null;
  runByListing: RunnableListingRef | null;
  runByDropped: { name: string; reason: 'notManager' | 'unavailable' } | null;
  venueListing: AttachableListingRef | null;
  venueListingDropped: boolean;
}

/**
 * Which event a member may start a month of events from, and what of it they
 * may carry over.
 *
 * One helper serves both `GET /events/:slug/batch-template` and
 * `POST /events/batch`, so the preview the page shows and the events the
 * batch writes are decided by the same reads and cannot disagree.
 *
 * The caller must host the event or hold an accepted co-host seat on it, and
 * the new events are hosted by the caller: a co-host who starts from the
 * host's event publishes events of their own. That is why every link the
 * starting event carries is checked again against the caller, as `create`
 * would check it for them.
 *
 * A run by line, a community or a venue link the caller cannot keep is
 * dropped quietly, and the preview names it: the events still make sense
 * without it, and the page tells the host before they publish. A
 * community-only event whose community drops is the one refusal. Publishing
 * it to any other audience would show the events to people the starting
 * event was kept from, and the server never widens who can see an event.
 */
@Injectable()
export class EventBatchTemplateService {
  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    private readonly contentModeration: ContentModerationService,
    private readonly membership: CommunityMembershipService,
    private readonly runByListings: ListingRunByService,
    private readonly listingLookup: ListingLookupService,
  ) {}

  /**
   * The starting event at `slug` as `callerId` may copy it, contract
   * section 3. A missing or cancelled event, one the caller neither hosts nor
   * co-hosts, and one a moderator hid or removed all answer the same 404, so
   * the route never confirms that someone else's event exists. Drafts and
   * past events qualify: a host often starts from last month's event.
   */
  async resolveForCaller(
    slug: string,
    callerId: string,
  ): Promise<ResolvedEventBatchTemplate> {
    const template = await this.events.findOne({ where: { slug } });
    if (!template || template.status === EventStatus.Cancelled) {
      throw eventBatchTemplateNotFound();
    }
    // A pending invite lives in `event_cohost_invites` and is no seat yet, so
    // only an accepted `event_cohosts` row counts.
    const isHost = template.hostId === callerId;
    const isCohost =
      !isHost &&
      (await this.cohosts.exists({
        where: { eventId: template.id, userId: callerId },
      }));
    if (!isHost && !isCohost) throw eventBatchTemplateNotFound();
    const moderation = await this.contentModeration.stateFor(
      EVENT_MODERATION_SUBJECT_TYPE,
      template.id,
    );
    // A taken-down event must not come back as thirty-one copies of itself.
    if (moderation.hidden || moderation.removed) {
      throw eventBatchTemplateNotFound();
    }

    const { runByListing, runByDropped } = await this.resolveRunBy(
      template,
      callerId,
    );
    const { community, communityDropped } = await this.resolveCommunity(
      template,
      callerId,
    );
    if (template.visibility === EventVisibility.Community && !community) {
      throw eventBatchTemplateCommunityOnly(communityDropped?.name ?? null);
    }
    const venueListing = template.listingId
      ? await this.listingLookup.findAttachable(template.listingId)
      : null;
    // The venue text stays when the link drops: the address still reads
    // right on the page, it just stops pointing at a directory entry.
    const venueListingDropped = template.listingId !== null && !venueListing;

    const templateFields = templateCreateInput(template, {
      communitySlug: community ? community.slug : null,
      listingId: venueListing ? venueListing.id : null,
      runByListingId: runByListing ? runByListing.id : null,
    });
    return {
      template,
      templateFields,
      community,
      communityDropped,
      runByListing,
      runByDropped,
      venueListing,
      venueListingDropped,
    };
  }

  /** The preview `GET /events/:slug/batch-template` answers. */
  async getTemplateView(
    slug: string,
    callerId: string,
  ): Promise<EventBatchTemplateView> {
    return toEventBatchTemplateView(
      await this.resolveForCaller(slug, callerId),
    );
  }

  /**
   * Run by, checked against the caller alone: the caller hosts every batch
   * event. A 400 means the business no longer qualifies (paused, closed for
   * good, taken down) and a 403 means the caller does not run it; either one
   * drops the line, named from its stored row. Any other failure is a real
   * fault and propagates.
   */
  private async resolveRunBy(
    template: Event,
    callerId: string,
  ): Promise<
    Pick<ResolvedEventBatchTemplate, 'runByListing' | 'runByDropped'>
  > {
    const runByListingId = template.runByListingId;
    if (!runByListingId) return { runByListing: null, runByDropped: null };
    try {
      const runByListing = await this.runByListings.assertCanRunGatherings(
        runByListingId,
        [callerId],
      );
      return { runByListing, runByDropped: null };
    } catch (failure) {
      const reason =
        failure instanceof ForbiddenException
          ? 'notManager'
          : failure instanceof BadRequestException
            ? 'unavailable'
            : null;
      if (reason === null) throw failure;
      // The row only vanishes if the listing was deleted between the two
      // reads; an empty name still lets the page show the notice.
      const name =
        (await this.runByListings.displayNameOf(runByListingId)) ?? '';
      return { runByListing: null, runByDropped: { name, reason } };
    }
  }

  /**
   * The community, checked as `create` would check the caller posting into
   * it. A 403 means the caller holds no owner or moderator seat; a 404 means
   * the community was archived, or is private and the caller is outside it.
   * A community whose row is gone reads as no community at all.
   */
  private async resolveCommunity(
    template: Event,
    callerId: string,
  ): Promise<
    Pick<ResolvedEventBatchTemplate, 'community' | 'communityDropped'>
  > {
    const noCommunity = { community: null, communityDropped: null };
    if (!template.communityId) return noCommunity;
    const hostingRef = await this.membership.hostingRefById(
      template.communityId,
    );
    if (!hostingRef) return noCommunity;
    try {
      const communityId = await this.membership.assertOwnerOrModBySlug(
        hostingRef.slug,
        callerId,
      );
      return {
        community: {
          id: communityId,
          slug: hostingRef.slug,
          name: hostingRef.name,
        },
        communityDropped: null,
      };
    } catch (failure) {
      const reason =
        failure instanceof ForbiddenException
          ? 'notModerator'
          : failure instanceof NotFoundException
            ? 'unavailable'
            : null;
      if (reason === null) throw failure;
      return {
        community: null,
        communityDropped: { name: hostingRef.name, reason },
      };
    }
  }
}

/**
 * The preview as the page reads it, contract section 4. Every value is what
 * the batch will copy for this caller: the links come from the kept slots,
 * the times are the starting event's read on its own clock, and the cover is
 * a display URL the page shows and never sends back.
 */
export function toEventBatchTemplateView(
  resolved: ResolvedEventBatchTemplate,
): EventBatchTemplateView {
  const { template } = resolved;
  // A legacy event with only its cost text previews with the kind the batch
  // will publish (`seededCostKind`), so the page never has to guess one.
  const costKind = seededCostKind(template.costKind, template.cost);
  const isFree = costKind === 'free';
  return {
    slug: template.slug,
    title: template.title,
    description: template.description,
    timezone: template.timezone,
    startTime: wallClockTimeOf(template.startAt, template.timezone),
    endTime: template.endAt
      ? wallClockTimeOf(template.endAt, template.timezone)
      : null,
    coverImageUrl: toImageUrl(template.coverImageUrl),
    gatheringFamily: template.gatheringFamily,
    eventType: template.eventType,
    formatDetails: template.formatDetails,
    neighbourhood: template.neighbourhood,
    venue: template.venue,
    listingId: resolved.venueListing ? resolved.venueListing.id : null,
    venueListing: resolved.venueListing
      ? { slug: resolved.venueListing.slug, name: resolved.venueListing.name }
      : null,
    isOnline: template.isOnline,
    onlineUrl: template.onlineUrl,
    address: template.address,
    arrivalNotes: template.arrivalNotes,
    capacity: template.capacity,
    language: template.language,
    // A free event carries no amount and no payment details, even a row saved
    // before the free rule nulled them: the detail page's rule, and the one
    // `create` applies to every batch event, so the preview shows what the
    // batch stores.
    cost: isFree ? null : template.cost,
    costKind,
    paymentUrl: isFree ? null : template.paymentUrl,
    paymentInstructions: isFree ? null : template.paymentInstructions,
    accessibility: {
      // Every question slug filled in, as the detail page reads it and as
      // `create` stores it on every batch event.
      answers: normalizeAccessibilityAnswers(template.accessibilityAnswers),
      note: template.accessibilityNote,
    },
    visibility: template.visibility,
    community: resolved.community
      ? { slug: resolved.community.slug, name: resolved.community.name }
      : null,
    communityDropped: resolved.communityDropped,
    runByListing: resolved.runByListing
      ? {
          ref: resolved.runByListing.ref,
          slug: resolved.runByListing.slug,
          name: resolved.runByListing.name,
        }
      : null,
    runByDropped: resolved.runByDropped,
    venueListingDropped: resolved.venueListingDropped,
    themes: template.themes,
    contentNotes: template.contentNotes,
    houseRules: template.houseRules,
    rsvpCutoff: template.rsvpCutoff,
    rsvpQuestions: template.rsvpQuestions,
    customRsvpQuestion: template.customRsvpQuestion,
    allowWaitlist: template.allowWaitlist,
    showAttendeeCount: template.showAttendeeCount,
  };
}

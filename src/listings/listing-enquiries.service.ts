import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MessagingService } from '../messaging/messaging.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { CreateListingEnquiryDto } from './dto/create-listing-enquiry.dto';
import { ListingEnquiry } from './entities/listing-enquiry.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import {
  ListingContactDTO,
  ListingContactUnavailableReason,
  ListingEnquirySentDTO,
} from './listing-enquiry-response';

/** Either the owner is reachable, or here is precisely why not. */
type OwnerReachability =
  | { isReachable: true; ownerId: string }
  | { isReachable: false; reason: ListingContactUnavailableReason };

/**
 * "Message this business" on a directory listing.
 *
 * Every existing route to a business on a listing page leaves the platform: a
 * `tel:` link, a `mailto:`, an Instagram handle. Each of them makes a member
 * hand over a phone number or an email address in order to ask one question,
 * and for somebody who is not out that is not a minor inconvenience, it is the
 * reason the question never gets asked. This service puts the question inside
 * the messaging the platform already has.
 *
 * IT DOES NOT STORE MESSAGES. Delivery goes through
 * `MessagingService.deliverEnquiry`, the cross-domain cold-contact seam housing
 * enquiries, job-application replies, barter proposals and moderator outreach
 * already share. This service writes exactly one row of its own
 * (`ListingEnquiry`), and that row holds no message text (see the entity's
 * docstring).
 *
 * WHAT MESSAGING ENFORCES, AND WHAT THIS DOES ABOUT IT. Three rules matter and
 * none of them is bypassed here:
 *
 *  - A BLOCK in either direction is a hard stop. `deliverEnquiry` throws on it
 *    and `canMessageOwner` reports it in advance, under a reason string that
 *    reads the same in both directions so this endpoint cannot be used to probe
 *    whether a specific person has blocked you.
 *  - MUTES are not a send-time gate anywhere in messaging (they filter
 *    notifications and listings, see `BlockFilterService.isMutedBy`), so
 *    nothing is added or removed for them here. A muted sender's enquiry is
 *    delivered to the thread and the bell stays quiet, which is exactly what a
 *    mute means everywhere else on the platform.
 *  - The CONNECTION RULE is the interesting one. An ordinary DM
 *    (`MessagesService.sendMessage`) requires an accepted connection, and
 *    `MessageRequestsService.messageRequest` turns a cold message into a
 *    connection request rather than delivering it. `deliverEnquiry` deliberately
 *    does not require a connection, and that exception is the platform's own,
 *    predating this work. This service reuses it rather than inventing a second
 *    one, and reports the consequence honestly instead of hiding it:
 *    `replyRequiresConnection` tells the caller that the FIRST message lands but
 *    the thread is then closed to further messages from EITHER side until a
 *    connection is accepted. Whether a listing enquiry deserves a wider
 *    exception than that is a product decision, and it is deliberately not made
 *    here.
 *
 * A LISTING WITH NO OWNER ACCOUNT CANNOT BE MESSAGED, and says so. `suggest`
 * and `friendly` listings do have a non-null `owner_id`, but it belongs to the
 * member who suggested or recommended the place, not to the business (the same
 * distinction `ListingClaimsService.assertClaimable` is built on). Delivering a
 * question about a venue to whoever once recommended it would be worse than not
 * offering the button, so those listings answer `unclaimed` and the flow can
 * point at the claim path instead of opening a thread nobody will ever read.
 */
@Injectable()
export class ListingEnquiriesService {
  /**
   * A directory business is taken down under either the `business` or the
   * `listing` code, both keyed by the listing slug — same pair
   * `DirectoryService` checks on every public read, kept in step deliberately:
   * a listing that is not readable must not be contactable either.
   */
  private static readonly MODERATION_SUBJECT_TYPES = ['business', 'listing'];

  /**
   * Counted caps, on top of the HTTP throttle on the route. The throttle tracks
   * by IP over 60 seconds and is the wrong tool for the shape that actually
   * hurts here: a handful of private messages a day to the same venue, from one
   * account, for a week. That is indistinguishable from harassment and invisible
   * to any short window, so it is counted out of `listing_enquiries` instead
   * (the same three-layer argument `DirectoryService.askQuestion` documents for
   * public questions).
   *
   * Three a day to one business leaves room for a genuine follow-up and a
   * correction without leaving room for a campaign. Twenty across the whole
   * directory is far above any honest day of researching somewhere to go.
   */
  private static readonly MAX_ENQUIRIES_PER_LISTING_PER_DAY = 3;
  private static readonly MAX_ENQUIRIES_PER_DAY = 20;

  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    @InjectRepository(ListingEnquiry)
    private readonly enquiries: Repository<ListingEnquiry>,
    // Read-only: tells a listing parked on the house account (or on an erased
    // or suspended account) apart from one a reachable member runs.
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly messaging: MessagingService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * Whether the caller can write to this listing's business, and what the
   * thread will allow afterwards. A read, so it never writes an enquiry row and
   * never throws for a merely unavailable owner: "you cannot message this
   * listing" is an answer, not an error.
   */
  async getContact(
    slug: string,
    viewerUserId: string,
  ): Promise<ListingContactDTO> {
    const listing = await this.loadLiveOr404(slug);
    const reachability = await this.resolveOwner(listing, viewerUserId);
    if (!reachability.isReachable) {
      return {
        canMessageOwner: false,
        unavailableReason: reachability.reason,
        replyRequiresConnection: false,
        existingConversationId: null,
      };
    }

    const [contactability, previous] = await Promise.all([
      this.messaging.enquiryContactability(viewerUserId, reachability.ownerId),
      this.findLatestEnquiry(listing.id, viewerUserId),
    ]);

    if (!contactability.canDeliver) {
      // `self` is already handled as `own_listing` above, so anything left here
      // is a block. Reported without direction on purpose.
      return {
        canMessageOwner: false,
        unavailableReason: 'unavailable',
        replyRequiresConnection: false,
        existingConversationId: null,
      };
    }

    return {
      canMessageOwner: true,
      unavailableReason: null,
      replyRequiresConnection: contactability.replyRequiresConnection,
      existingConversationId: previous?.conversationId ?? null,
    };
  }

  /**
   * Deliver a member's private enquiry to the listing's owner and record that it
   * happened.
   *
   * ORDERING. The DM is sent FIRST and the `listing_enquiries` row is written
   * after it, on purpose and in that order only. The message is the thing the
   * member asked for and it cannot be rolled back once it is in somebody's
   * inbox, so nothing that could fail is allowed to run after it that would
   * strand a duplicate on a retry. The bookkeeping row failing after a
   * successful send is the narrow, accepted window (it costs the enquirer their
   * "open the conversation" shortcut, nothing more); a send failing after the
   * row was written would have told a member their message was delivered when
   * it was not.
   *
   * No separate notification is raised. `deliverEnquiry` posts a real message,
   * so the owner already gets the ordinary new-message notification and push;
   * a second bell for the same event would double-notify.
   */
  async send(
    slug: string,
    senderUserId: string,
    dto: CreateListingEnquiryDto,
  ): Promise<ListingEnquirySentDTO> {
    const listing = await this.loadLiveOr404(slug);
    const reachability = await this.resolveOwner(listing, senderUserId);
    if (!reachability.isReachable) {
      throw new BadRequestException(
        ListingEnquiriesService.unavailableMessage(reachability.reason),
      );
    }
    const ownerId = reachability.ownerId;

    const contactability = await this.messaging.enquiryContactability(
      senderUserId,
      ownerId,
    );
    if (!contactability.canDeliver) {
      throw new ForbiddenException('You cannot contact this business');
    }

    await this.assertEnquiryQuota(listing.id, senderUserId);

    const { conversationId } = await this.messaging.deliverEnquiry(
      senderUserId,
      ownerId,
      ListingEnquiriesService.composeEnquiryBody(listing.name, dto.body.trim()),
    );

    const saved = await this.enquiries.save(
      this.enquiries.create({
        listingId: listing.id,
        senderId: senderUserId,
        ownerId,
        conversationId,
      }),
    );

    return {
      conversationId,
      enquiryId: saved.id,
      replyRequiresConnection: contactability.replyRequiresConnection,
    };
  }

  /**
   * The context line that lets an owner tell an enquiry from an ordinary DM.
   *
   * A prefix on the message body rather than a new message kind or a structured
   * field, deliberately. `Message.kind` is a rendering contract every messaging
   * client already implements (`user`, `system`, `gif`, `image`) and adding a
   * fifth value to it would mean a schema change plus a client that does not
   * know how to draw it. The body is the one channel that reaches every surface
   * the message shows up on unchanged: the thread, the inbox preview, the push
   * notification and the email digest all render it without knowing anything
   * about listings.
   *
   * The member's own words are left exactly as typed, below the line, so nothing
   * they wrote is reworded or truncated by this.
   */
  private static composeEnquiryBody(listingName: string, body: string): string {
    return `Enquiry about your QueerPulse listing "${listingName}":\n\n${body}`;
  }

  /** Human-readable version of a `ListingContactUnavailableReason`, for the
   *  400 the write path throws. The read path returns the code instead and
   *  lets the frontend write the sentence. */
  private static unavailableMessage(
    reason: ListingContactUnavailableReason,
  ): string {
    switch (reason) {
      case 'unclaimed':
        return (
          'Nobody has claimed this listing yet, so there is no business ' +
          'account to write to. If you run this place, claim the listing and ' +
          'members will be able to reach you here.'
        );
      case 'own_listing':
        return 'You cannot send an enquiry to your own listing';
      case 'no_owner_account':
      case 'unavailable':
      default:
        return 'This listing cannot be messaged through QueerPulse';
    }
  }

  /**
   * Who, if anyone, an enquiry on this listing should reach.
   *
   * `Listing.ownerId` is NOT NULL, so "no owner" is a product state rather than
   * a null, and the cases are exactly the ones
   * `ListingClaimsService.assertClaimable` treats as claimable, read from the
   * other direction: a listing anybody may claim is by definition a listing
   * nobody is answering messages on.
   */
  private async resolveOwner(
    listing: Listing,
    viewerUserId: string,
  ): Promise<OwnerReachability> {
    if (listing.path === 'suggest' || listing.badge === 'friendly') {
      return { isReachable: false, reason: 'unclaimed' };
    }
    if (listing.ownerId === viewerUserId) {
      return { isReachable: false, reason: 'own_listing' };
    }
    const owner = await this.users.findOne({
      where: { id: listing.ownerId },
      select: { id: true, isSystem: true, status: true },
    });
    // No row means the owning account was erased; a system account is the house
    // account seeded content is parked on and has no human reading its inbox;
    // a suspended or banned owner would have the send rejected by messaging's
    // own account-status gate anyway, so refuse before the compose box rather
    // than after the member has written their message.
    if (!owner || owner.isSystem || owner.status !== UserStatus.Active) {
      return { isReachable: false, reason: 'no_owner_account' };
    }
    return { isReachable: true, ownerId: owner.id };
  }

  /** The caller's most recent enquiry on this listing, or null. Backs the
   *  "open the conversation you already started" shortcut. */
  private findLatestEnquiry(
    listingId: string,
    senderId: string,
  ): Promise<ListingEnquiry | null> {
    return this.enquiries.findOne({
      where: { listingId, senderId },
      order: { createdAt: 'DESC' },
    });
  }

  /** The two counted caps described on the constants above. Two indexed COUNTs,
   *  both bounded, run before anything is sent. 429 rather than a silent drop:
   *  a member who has hit a limit is told, because the alternative teaches
   *  people their messages vanish. */
  private async assertEnquiryQuota(
    listingId: string,
    senderId: string,
  ): Promise<void> {
    const since = new Date(Date.now() - ListingEnquiriesService.ONE_DAY_MS);

    const onThisListing = await this.enquiries.count({
      where: { listingId, senderId, createdAt: MoreThan(since) },
    });
    if (
      onThisListing >= ListingEnquiriesService.MAX_ENQUIRIES_PER_LISTING_PER_DAY
    ) {
      throw new HttpException(
        'You have already written to this business today. Give them a chance to reply first.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const sentRecently = await this.enquiries.count({
      where: { senderId, createdAt: MoreThan(since) },
    });
    if (sentRecently >= ListingEnquiriesService.MAX_ENQUIRIES_PER_DAY) {
      throw new HttpException(
        'You have sent a lot of enquiries today. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Mirrors `DirectoryService.loadLiveOr404` exactly, kept as a local copy for
   * the same reason `ListingEditSuggestionsService` and `ListingClaimsService`
   * keep their own `loadOr404`: the directory's is private and this service
   * must not depend on that class's shape. A listing that is not live, is
   * paused by its owner, or is under a moderator takedown is 404 here just as
   * it is on the public detail page, so the contact route can never be used to
   * confirm that a withheld listing exists.
   */
  private async loadLiveOr404(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live, isHiddenByOwner: false },
    });
    if (!listing) {
      throw new NotFoundException('Listing not found');
    }
    const states = await this.contentModeration.statesForAnyType(
      ListingEnquiriesService.MODERATION_SUBJECT_TYPES,
      [slug],
    );
    const state = states.get(slug);
    if (state && (state.hidden || state.removed)) {
      throw new NotFoundException('Listing not found');
    }
    return listing;
  }
}

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
  ListingEnquiryLimitReason,
  ListingEnquirySentDTO,
} from './listing-enquiry-response';

/** Either the owner is reachable, or here is precisely why not. */
type OwnerReachability =
  | { isReachable: true; ownerId: string }
  | { isReachable: false; reason: ListingContactUnavailableReason };

/**
 * Where the caller stands against the counted caps right now.
 *
 * ONE VALUE, TWO CONSUMERS. `getContact` maps it into the DTO so the composer
 * can be closed before anybody types, and `assertEnquiryQuota` turns it into
 * the 429. They must never be two separate counts: a hint that disagrees with
 * enforcement is worse than no hint, because it either invites a member to
 * write a message that will be thrown away or hides a route that was open all
 * along. Deriving both from `evaluateEnquiryQuota` makes disagreement
 * impossible rather than merely unlikely.
 */
type EnquiryQuotaState =
  | { hasReachedLimit: false }
  | {
      hasReachedLimit: true;
      reason: ListingEnquiryLimitReason;
      clearsAt: Date;
    };

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
   *
   * BOTH ARE REPORTED BY `getContact` AS WELL AS ENFORCED BY `send`, out of the
   * one evaluation in `evaluateEnquiryQuota`, so a member is told they cannot
   * write before they type instead of after. The numbers themselves stay off the
   * wire: see `ListingEnquiryLimitReason` for why a remaining count would be the
   * wrong thing to hand a member.
   */
  private static readonly MAX_ENQUIRIES_PER_LISTING_PER_DAY = 3;
  private static readonly MAX_ENQUIRIES_PER_DAY = 20;

  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * How many of the caller's rows inside the window one quota read pulls back.
   *
   * Both caps are evaluated from a SINGLE bounded fetch rather than two COUNTs,
   * and the bound is safe because it is one more than the largest cap:
   *
   *  - Fewer than this many rows come back and the window is COMPLETE, so both
   *    counts and both release times are exact.
   *  - This many come back and the window holds at least `MAX_ENQUIRIES_PER_DAY`
   *    rows, so the directory cap binds on its own and the answer is "blocked"
   *    whatever the per-listing breakdown turns out to be. Truncation can only
   *    ever miss a per-listing cap that is already masked by a directory cap,
   *    so it can never turn a refusal into a permission.
   *
   * Ordering newest-first also makes the release times fall out for free: a cap
   * of N lifts exactly when the Nth-newest counted row ages out, which is always
   * inside this slice.
   */
  private static readonly QUOTA_WINDOW_ROW_LIMIT =
    ListingEnquiriesService.MAX_ENQUIRIES_PER_DAY + 1;

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
        // Not evaluated at all on this path: with nobody to write to, the
        // caller's own quota is not a question, and asking would cost a query
        // on every view of an unclaimed listing.
        ...ListingEnquiriesService.UNCAPPED,
      };
    }

    const [contactability, previous, quota] = await Promise.all([
      this.messaging.enquiryContactability(viewerUserId, reachability.ownerId),
      this.findLatestEnquiry(listing.id, viewerUserId),
      this.evaluateEnquiryQuota(listing.id, viewerUserId),
    ]);

    if (!contactability.canDeliver) {
      // `self` is already handled as `own_listing` above, so anything left here
      // is a block. Reported without direction on purpose.
      return {
        canMessageOwner: false,
        unavailableReason: 'unavailable',
        replyRequiresConnection: false,
        existingConversationId: null,
        ...ListingEnquiriesService.UNCAPPED,
      };
    }

    return {
      canMessageOwner: true,
      unavailableReason: null,
      replyRequiresConnection: contactability.replyRequiresConnection,
      existingConversationId: previous?.conversationId ?? null,
      // Hand-mapped, like everything else on the wire here: there is no global
      // serializer, and `EnquiryQuotaState` is a Date-carrying internal shape
      // that must not be handed to a client as-is.
      ...(quota.hasReachedLimit
        ? {
            hasReachedEnquiryLimit: true,
            enquiryLimitReason: quota.reason,
            enquiryLimitClearsAt: quota.clearsAt.toISOString(),
          }
        : ListingEnquiriesService.UNCAPPED),
    };
  }

  /** The three quota fields when nothing is capped, or when the question does
   *  not arise because the owner is unreachable anyway. */
  private static readonly UNCAPPED = {
    hasReachedEnquiryLimit: false,
    enquiryLimitReason: null,
    enquiryLimitClearsAt: null,
  } as const;

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
    // NULL since `SetNullContentAuthorFksOnUserErasure1794610000000`: the
    // owning account was erased and the entry stayed live. Same outcome the
    // `!owner` branch below already gave for a row that had gone missing, now
    // reachable without a query.
    const ownerId = listing.ownerId;
    if (ownerId === null) {
      return { isReachable: false, reason: 'no_owner_account' };
    }
    const owner = await this.users.findOne({
      where: { id: ownerId },
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

  /**
   * Where the caller stands against the two counted caps described on the
   * constants above. THE ONLY PLACE EITHER CAP IS COUNTED. `getContact` reads it
   * to close the composer in advance and `assertEnquiryQuota` reads it to refuse
   * a send; neither counts anything of its own, so the hint and the enforcement
   * cannot drift apart.
   *
   * ONE QUERY, NOT TWO COUNTS. The caller's rows inside the rolling day are
   * fetched once, newest first and hard-bounded (see `QUOTA_WINDOW_ROW_LIMIT`),
   * and both caps are read off that slice. It replaces the two COUNTs the send
   * path used to run, so this is a query cheaper on the write path and one query
   * on the read path.
   *
   * INDEX. The predicate is `sender_id = ? AND created_at > ?`, ordered by
   * `created_at DESC` and limited, which is exactly
   * `IDX_listing_enquiries_sender_id_created_at` (`CreateListingEnquiries`)
   * front to back: an index range scan of at most 21 rows, with the sort taken
   * from the index rather than performed. No new index is needed and none was
   * added. The per-listing count is filtered in memory out of that same slice
   * rather than through `IDX_listing_enquiries_listing_id_sender_id`, because a
   * second round trip costs more than filtering 21 rows.
   */
  private async evaluateEnquiryQuota(
    listingId: string,
    senderId: string,
  ): Promise<EnquiryQuotaState> {
    const since = new Date(Date.now() - ListingEnquiriesService.ONE_DAY_MS);

    const recentEnquiries = await this.enquiries.find({
      where: { senderId, createdAt: MoreThan(since) },
      select: { id: true, listingId: true, createdAt: true },
      order: { createdAt: 'DESC' },
      take: ListingEnquiriesService.QUOTA_WINDOW_ROW_LIMIT,
    });

    // Both arrays stay newest-first, which is what `clearsAt` wants.
    const onThisListing = recentEnquiries.filter(
      (enquiry) => enquiry.listingId === listingId,
    );

    const isListingCapped =
      onThisListing.length >=
      ListingEnquiriesService.MAX_ENQUIRIES_PER_LISTING_PER_DAY;
    const isDirectoryCapped =
      recentEnquiries.length >= ListingEnquiriesService.MAX_ENQUIRIES_PER_DAY;

    if (!isListingCapped && !isDirectoryCapped) {
      return { hasReachedLimit: false };
    }

    const releaseTimes: number[] = [];
    if (isListingCapped) {
      releaseTimes.push(
        ListingEnquiriesService.clearsAt(
          onThisListing,
          ListingEnquiriesService.MAX_ENQUIRIES_PER_LISTING_PER_DAY,
        ),
      );
    }
    if (isDirectoryCapped) {
      releaseTimes.push(
        ListingEnquiriesService.clearsAt(
          recentEnquiries,
          ListingEnquiriesService.MAX_ENQUIRIES_PER_DAY,
        ),
      );
    }

    return {
      hasReachedLimit: true,
      // The per-listing cap is named first when both bite, because it is the
      // one the send path refuses with first and the two must tell the same
      // story. It is also the more useful sentence: it points the member at a
      // conversation they already have rather than at the whole directory.
      reason: isListingCapped
        ? 'wrote_to_this_business_today'
        : 'wrote_across_directory_today',
      // The LATER of the caps that are actually biting. Promising the earlier
      // one would send a member back to a button that refuses them again.
      clearsAt: new Date(Math.max(...releaseTimes)),
    };
  }

  /**
   * When a cap of `limit` lifts, given the caller's counted rows newest first.
   *
   * The window rolls, so a cap of N stops biting the moment the Nth-newest
   * counted row ages out of its 24 hours: everything older than it has gone
   * too, leaving N-1 rows behind. Callers only reach this with at least `limit`
   * rows in hand.
   */
  private static clearsAt(
    newestFirst: Pick<ListingEnquiry, 'createdAt'>[],
    limit: number,
  ): number {
    const nthNewest = newestFirst[limit - 1];
    // Unreachable given the guards above, and the fallback is a full day out
    // rather than `now`: erring late leaves a member waiting slightly longer
    // than they had to, erring early sends them back to a button that refuses
    // them again.
    if (!nthNewest) {
      return Date.now() + ListingEnquiriesService.ONE_DAY_MS;
    }
    return nthNewest.createdAt.getTime() + ListingEnquiriesService.ONE_DAY_MS;
  }

  /**
   * The counted caps, enforced. 429 rather than a silent drop: a member who has
   * hit a limit is told, because the alternative teaches people their messages
   * vanish.
   *
   * Still runs on every send even though `getContact` already reported the same
   * answer to the client. The read is a courtesy that can be minutes stale by
   * the time somebody finishes typing, and it is trivially skippable by anything
   * that is not the web client, so this is the authority and the hint is never
   * trusted.
   */
  private async assertEnquiryQuota(
    listingId: string,
    senderId: string,
  ): Promise<void> {
    const quota = await this.evaluateEnquiryQuota(listingId, senderId);
    if (!quota.hasReachedLimit) return;
    throw new HttpException(
      ListingEnquiriesService.limitMessage(quota.reason),
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /** The sentence behind each 429. Kept beside the reason codes so a client
   *  that closed its composer on `enquiryLimitReason` and a client that only
   *  ever sees the 429 body are told the same thing. */
  private static limitMessage(reason: ListingEnquiryLimitReason): string {
    return reason === 'wrote_to_this_business_today'
      ? 'You have already written to this business today. Give them a chance to reply first.'
      : 'You have sent a lot of enquiries today. Try again tomorrow.';
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

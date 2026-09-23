import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import {
  loadColdIdentityEnquiryMessages,
  MAX_COLD_ENQUIRIES_PER_DAY,
} from '../identity-contact/identity-enquiry-quota';
import {
  IdentityEnquiryBlockedReason,
  IdentityEnquiryContactability,
  identityBlockedException,
  loadReceivingStaffUserIds,
} from '../messaging/message-requests.service';
import { MessagingService } from '../messaging/messaging.service';
import { User } from '../users/entities/user.entity';
import { CreateListingEnquiryDto } from './dto/create-listing-enquiry.dto';
import { ListingEnquiry } from './entities/listing-enquiry.entity';
import { Listing, ListingStatus } from './entities/listing.entity';
import {
  ListingContactDTO,
  ListingContactUnavailableReason,
  ListingEnquiryLimitReason,
  ListingEnquirySentDTO,
} from './listing-enquiry-response';

/**
 * Either somebody who manages the listing can receive an enquiry from this
 * member, or here is precisely why nobody can. `ownerSnapshot` is the owner
 * of record written onto the enquiry row: the listing's current owner when
 * it has one, null when its co-managers are answering an ownerless listing.
 * `contactability` is messaging's answer that decided it, carried along so
 * neither caller asks messaging the same question twice.
 */
type ListingReachability =
  | {
      isReachable: true;
      listingIdentityId: string;
      ownerSnapshot: string | null;
      contactability: IdentityEnquiryContactability;
    }
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
 * `MessagingService.deliverEnquiryToIdentity` (Task 18), the mailbox form of
 * the cross-domain cold-contact seam housing enquiries, job-application
 * replies, barter proposals and moderator outreach share. The enquiry lands
 * in the LISTING's mailbox, a thread keyed on the member and the listing
 * identity with every staff member seated (the owner and each active
 * co-manager). This service writes
 * exactly one row of its own (`ListingEnquiry`), and that row holds no
 * message text (see the entity's docstring). Its `ownerId` stays the owner
 * at the time, as the record of who owned the listing then, and is null for
 * an ownerless listing its co-managers answer.
 *
 * WHAT MESSAGING ENFORCES, AND WHAT THIS DOES ABOUT IT. Three rules matter and
 * none of them is bypassed here:
 *
 *  - A BLOCK of the listing's identity by the member is a hard stop.
 *    `deliverEnquiryToIdentity` throws on it and `canMessageOwner` reports
 *    it in advance as `unavailable`. A person block between the member and
 *    one staff member does not refuse: that would tell the member the person
 *    works there. The thread seats every staff member and the read-time
 *    mailbox rules leave the blocked one out.
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
 *    one, and reports the consequence honestly instead of hiding it. PRD-340:
 *    the owner may reply to the FIRST message without a connection, and that
 *    reply is what opens the thread to further ordinary messages from either
 *    side, so `followUpAwaitsReply` tells the enquirer exactly that (the thread
 *    stays a one-message enquiry until the owner answers, not until a
 *    connection is accepted). `replyRequiresConnection` is kept for existing
 *    callers.
 *
 * AN UNCLAIMED LISTING CANNOT BE MESSAGED, and says so. `suggest` and
 * `friendly` listings do have a non-null `owner_id`, but it belongs to the
 * member who suggested or recommended the place, not to the business (the same
 * distinction `ListingClaimsService.assertClaimable` is built on). Delivering a
 * question about a venue to whoever once recommended it would be worse than not
 * offering the button, so those listings answer `unclaimed` and the flow can
 * point at the claim path instead of opening a thread nobody will ever read.
 *
 * A CLAIMED LISTING IS REACHABLE WHILE ANYBODY WHO MANAGES IT CAN RECEIVE.
 * Reachability is decided from the listing's staff (`resolveReachability`),
 * the same list persona and company mailboxes are decided from: an owner
 * whose account was erased or is suspended leaves the mailbox working as long
 * as one active co-manager can answer it. Only a listing that nobody
 * reachable manages refuses.
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
   * correction without leaving room for a campaign. Twenty a day is far above
   * any honest day of researching somewhere to go. Task 18 fix round 1: the
   * twenty is ONE ceiling shared with persona and company enquiries
   * (`MAX_COLD_ENQUIRIES_PER_DAY`), so spreading a day across kinds of
   * mailbox cannot double it.
   *
   * BOTH ARE REPORTED BY `getContact` AS WELL AS ENFORCED BY `send`, out of the
   * one evaluation in `evaluateEnquiryQuota`, so a member is told they cannot
   * write before they type instead of after. The numbers themselves stay off the
   * wire: see `ListingEnquiryLimitReason` for why a remaining count would be the
   * wrong thing to hand a member.
   */
  private static readonly MAX_ENQUIRIES_PER_LISTING_PER_DAY = 3;
  private static readonly MAX_ENQUIRIES_PER_DAY = MAX_COLD_ENQUIRIES_PER_DAY;

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
    // Read-only: tells a staff member who can receive an enquiry apart from
    // the house account and from a suspended or deactivated member.
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly messaging: MessagingService,
    private readonly contentModeration: ContentModerationService,
    // Task 18: the listing's own identity, the mailbox an enquiry lands in.
    private readonly identities: IdentitiesService,
  ) {}

  /**
   * Whether the caller can write to this listing's business, and what the
   * thread will allow afterwards. A read, so it never writes an enquiry row and
   * never throws for a listing nobody can currently answer: "you cannot
   * message this listing" is an ordinary answer and returns normally.
   */
  async getContact(
    slug: string,
    viewerUserId: string,
  ): Promise<ListingContactDTO> {
    const listing = await this.loadLiveOr404(slug);
    const reachability = await this.resolveReachability(listing, viewerUserId);
    if (!reachability.isReachable) {
      return {
        canMessageOwner: false,
        unavailableReason: reachability.reason,
        replyRequiresConnection: false,
        followUpAwaitsReply: false,
        existingConversationId: null,
        // Not evaluated at all on this path: with nobody to write to, the
        // caller's own quota is not a question, and asking would cost a query
        // on every view of an unclaimed listing.
        ...ListingEnquiriesService.UNCAPPED,
      };
    }

    const { contactability } = reachability;
    const [previous, quota] = await Promise.all([
      this.findLatestEnquiry(listing.id, viewerUserId),
      this.evaluateEnquiryQuota(listing.id, viewerUserId),
    ]);

    return {
      canMessageOwner: true,
      unavailableReason: null,
      replyRequiresConnection: contactability.replyRequiresConnection,
      followUpAwaitsReply: contactability.followUpAwaitsReply,
      // The mailbox thread first; an older enquiry's thread otherwise, which
      // for an enquiry made before mailboxes may be a personal one.
      existingConversationId:
        contactability.existingConversationId ??
        previous?.conversationId ??
        null,
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
   *  not arise because nobody who manages the listing can receive anyway. */
  private static readonly UNCAPPED = {
    hasReachedEnquiryLimit: false,
    enquiryLimitReason: null,
    enquiryLimitClearsAt: null,
  } as const;

  /**
   * Deliver a member's private enquiry to the listing's mailbox and record
   * that it happened.
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
   * No separate notification is raised. `deliverEnquiryToIdentity` posts a
   * real message, so every reachable staff seat of the listing's mailbox gets
   * the ordinary live frame and push; a second bell for the same event would
   * double-notify.
   */
  async send(
    slug: string,
    senderUserId: string,
    dto: CreateListingEnquiryDto,
  ): Promise<ListingEnquirySentDTO> {
    const listing = await this.loadLiveOr404(slug);
    const reachability = await this.resolveReachability(listing, senderUserId);
    if (!reachability.isReachable) {
      // A block, or nobody reachable behind one, is the same coded 403 the
      // delivery itself throws, so the member reads one answer either way.
      if (reachability.reason === 'unavailable') {
        throw identityBlockedException();
      }
      throw new BadRequestException(
        ListingEnquiriesService.unavailableMessage(reachability.reason),
      );
    }
    const { listingIdentityId, ownerSnapshot, contactability } = reachability;

    await this.assertEnquiryQuota(listing.id, senderUserId);

    const { conversationId } = await this.messaging.deliverEnquiryToIdentity(
      senderUserId,
      listingIdentityId,
      ListingEnquiriesService.composeEnquiryBody(listing.name, dto.body.trim()),
      dto.asIdentityId,
    );

    const saved = await this.enquiries.save(
      this.enquiries.create({
        listingId: listing.id,
        senderId: senderUserId,
        ownerId: ownerSnapshot,
        conversationId,
      }),
    );

    return {
      conversationId,
      enquiryId: saved.id,
      replyRequiresConnection: contactability.replyRequiresConnection,
      followUpAwaitsReply: contactability.followUpAwaitsReply,
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
   * Whether anybody who manages this listing can receive an enquiry from
   * `viewerUserId`, and the listing's mailbox identity when somebody can.
   *
   * UNCLAIMED FIRST. The cases are the ones
   * `ListingClaimsService.assertClaimable` treats as claimable, read from the
   * other direction: a listing anybody may claim is by definition a listing
   * nobody is answering messages on, whoever its `owner_id` names.
   *
   * THEN MESSAGING DECIDES, with the rule persona and company mailboxes use
   * (`MessagingService.identityEnquiryContactability`). The staff are the
   * owner when there is one plus every active co-manager
   * (`IdentitiesService.staffUserIds`, which also seats the thread), and the
   * enquiry can go through while one of them is both able to receive (an
   * active, non-system account) and not blocked with the member either way.
   * An owner whose account was erased or is suspended therefore leaves the
   * mailbox working as long as one active co-manager can answer. A member on
   * the staff list is told `own_listing`, owner and co-manager alike.
   *
   * Refusals keep the codes the frontend already reads; see
   * `unreachableReason`.
   */
  private async resolveReachability(
    listing: Listing,
    viewerUserId: string,
  ): Promise<ListingReachability> {
    if (listing.path === 'suggest' || listing.badge === 'friendly') {
      return { isReachable: false, reason: 'unclaimed' };
    }
    if (listing.ownerId === viewerUserId) {
      return { isReachable: false, reason: 'own_listing' };
    }
    const listingIdentity = await this.identities.ensureIdentityFor(
      IdentityKind.Listing,
      listing.id,
    );
    const contactability = await this.messaging.identityEnquiryContactability(
      viewerUserId,
      listingIdentity.id,
    );
    if (!contactability.canDeliver) {
      return {
        isReachable: false,
        reason: await this.unreachableReason(
          contactability.blockedReason,
          listingIdentity.id,
        ),
      };
    }
    return {
      isReachable: true,
      listingIdentityId: listingIdentity.id,
      ownerSnapshot: listing.ownerId,
      contactability,
    };
  }

  /**
   * Messaging's refusal, in the listing's own reason codes.
   *
   *  - `IDENTITY_IS_YOUR_OWN` is a co-manager writing to their own listing.
   *  - `IDENTITY_HAS_NO_STAFF` is an ownerless listing with no co-manager.
   *  - `blocked` covers both "blocked from everybody who could receive" and
   *    "nobody could receive at all". Only the first is about this member,
   *    so the staff are read once more to tell them apart: with no staff
   *    account able to receive, the listing is unanswerable for everybody
   *    and says `no_owner_account`, as it did before co-managers; otherwise
   *    it is `unavailable`, which never says which way a block runs.
   *
   * `no_owner_account` is the wire code for "nobody who manages this listing
   * can receive messages". The name predates co-managers and is kept because
   * the frontend keys its copy off it.
   */
  private async unreachableReason(
    blockedReason: IdentityEnquiryBlockedReason | null,
    listingIdentityId: string,
  ): Promise<ListingContactUnavailableReason> {
    switch (blockedReason) {
      case 'IDENTITY_IS_YOUR_OWN':
        return 'own_listing';
      case 'IDENTITY_HAS_NO_STAFF':
        return 'no_owner_account';
      case 'blocked':
        return (await this.hasReceivingStaff(listingIdentityId))
          ? 'unavailable'
          : 'no_owner_account';
      default:
        return 'unavailable';
    }
  }

  /** True when any staff member of the listing's mailbox has an account that
   *  can receive, blocks aside. Runs only on a refusal, through the one rule
   *  messaging applies (`loadReceivingStaffUserIds`). */
  private async hasReceivingStaff(listingIdentityId: string): Promise<boolean> {
    const staffUserIds = await this.identities.staffUserIds(listingIdentityId);
    const receivingStaffUserIds = await loadReceivingStaffUserIds(
      this.users,
      staffUserIds,
    );
    return receivingStaffUserIds.length > 0;
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
   * ONE READ OF THIS TABLE, NOT TWO COUNTS. The caller's rows inside the
   * rolling day are fetched once, newest first and hard-bounded (see
   * `QUOTA_WINDOW_ROW_LIMIT`), and both caps are read off that slice. Task 18
   * fix round 1: a second bounded read, run alongside, brings in the caller's
   * persona and company cold messages (`COLD_IDENTITY_ENQUIRY_MESSAGES_SQL`),
   * which count toward the shared daily ceiling and never toward the
   * per-listing cap.
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

    const [recentEnquiries, identityEnquiryMessages] = await Promise.all([
      this.enquiries.find({
        where: { senderId, createdAt: MoreThan(since) },
        select: { id: true, listingId: true, createdAt: true },
        order: { createdAt: 'DESC' },
        take: ListingEnquiriesService.QUOTA_WINDOW_ROW_LIMIT,
      }),
      // Task 18 fix round 1: the member's persona and company cold messages
      // in the same window, the same bounded read `IdentityContactService`
      // counts, so the daily ceiling is one number across every kind.
      loadColdIdentityEnquiryMessages(this.enquiries, senderId, since),
    ]);
    // Every cold enquiry of every kind, newest first. Each read is bounded
    // at one more than the ceiling, so the ceiling-th newest of the merge
    // lies inside both slices and its release time is exact.
    const coldEnquiries = [
      ...recentEnquiries.map((enquiry) => ({ createdAt: enquiry.createdAt })),
      ...identityEnquiryMessages.map((message) => ({
        createdAt: message.createdAt,
      })),
    ].sort(
      (first, second) => second.createdAt.getTime() - first.createdAt.getTime(),
    );

    // Both arrays stay newest-first, which is what `clearsAt` wants.
    const onThisListing = recentEnquiries.filter(
      (enquiry) => enquiry.listingId === listingId,
    );

    const isListingCapped =
      onThisListing.length >=
      ListingEnquiriesService.MAX_ENQUIRIES_PER_LISTING_PER_DAY;
    const isDirectoryCapped =
      coldEnquiries.length >= ListingEnquiriesService.MAX_ENQUIRIES_PER_DAY;

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
          coldEnquiries,
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

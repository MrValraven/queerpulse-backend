import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { CompanyReview } from '../companies/entities/company-review.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ConsentRecord } from '../consent/entities/consent-record.entity';
import { EventMatchEntry } from '../go-together/entities/event-match-entry.entity';
import { FriendMatchProfile } from '../go-together/entities/friend-match-profile.entity';
import { MatchAvoidance } from '../go-together/entities/match-avoidance.entity';
import { MatchFeedback } from '../go-together/entities/match-feedback.entity';
import { MatchGroupFeedback } from '../go-together/entities/match-group-feedback.entity';
import { GovernanceProposal } from '../governance/entities/governance-proposal.entity';
import { GovernanceVote } from '../governance/entities/governance-vote.entity';
import { HousingReview } from '../housing-reviews/entities/housing-review.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { ListingReview } from '../listings/entities/listing-review.entity';
import { Listing } from '../listings/entities/listing.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { MagazineStorySubmission } from '../magazine/entities/magazine-story-submission.entity';
import { MyCardsService } from '../membership-cards/my-cards.service';
import { staleMentionExcerptIds } from '../mentions/mention-stale-excerpts';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { visibleThroughMailboxSeatRules } from '../notifications/notification-mailbox-block';
import { ACTOR_PAYLOAD_KEY } from '../notifications/notification-response';
import { ProfileNowHistory } from '../profiles/entities/profile-now-history.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { Message } from '../messaging/entities/message.entity';
import { toBareKey } from '../storage/bare-key';
import { StorageService } from '../storage/storage.service';
import { PersonaImageKeysService } from '../storage/persona-image-keys.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { DataExportContribution } from './data-export-contributor';
import {
  FlatmateLikesExportContributor,
  HiddenMembersExportContributor,
  HousingSavedSearchesExportContributor,
  MutesExportContributor,
  NotificationPreferencesExportContributor,
  PolicyStatusExportContributor,
  PushDevicesExportContributor,
  SessionsExportContributor,
} from './data-export-contributors-account';
import {
  BlocksExportContributor,
  CoopJoinRequestsExportContributor,
  FlatmateProfileExportContributor,
  GroupJoinRequestsExportContributor,
  HousingViewingsExportContributor,
  PolicyAcceptancesExportContributor,
  ReportsFiledExportContributor,
} from './data-export-contributors-safety';
import { MORE_EXPORT_CONTRIBUTORS } from './data-export-contributors-more';
import {
  ExportMediaContribution,
  MEDIA_EXPORT_MAX_TOTAL_BYTES,
  planExportMedia,
  uploadKindForStorageKey,
} from './export-media';

/**
 * The export contributions for the domains the original monolithic export
 * builder silently missed (subprofiles, listings, housing, saved,
 * notifications, consent). Each is registered under `DATA_EXPORT_CONTRIBUTORS`
 * in `AccountModule` and only runs when its `category` is requested. All read
 * only the member's OWN rows and map to a stable, self-describing shape — no
 * raw entity is echoed to the wire.
 */

@Injectable()
export class SubprofilesExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'subprofiles';

  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.subprofiles.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((subprofile) => ({
      id: subprofile.id,
      kind: subprofile.kind,
      slug: subprofile.slug,
      handle: subprofile.handle,
      displayName: subprofile.displayName,
      tagline: subprofile.tagline,
      bio: subprofile.bio,
      status: subprofile.status,
      linkVisibility: subprofile.linkVisibility,
      createdAt: subprofile.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class ListingsExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'listings';

  constructor(
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
  ) {}

  /**
   * The listings the member owns and the places they suggested. A suggestion
   * is held by the platform (or later by whoever claims it), so it carries the
   * member on `suggestedByUserId` alone; each row's `relationship` says which
   * of the two ties it to the member. A row that matches both is reported as
   * `owner`, the stronger tie.
   */
  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.listings.find({
      where: [{ ownerId: userId }, { suggestedByUserId: userId }],
      order: { createdAt: 'ASC' },
    });
    return rows.map((listing) => ({
      id: listing.id,
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
      status: listing.status,
      relationship: listing.ownerId === userId ? 'owner' : 'suggested',
      createdAt: listing.createdAt.toISOString(),
    }));
  }
}

/**
 * `housing` -> `housing`: the housing listings the member owns. The same
 * category also writes `flatmateProfile`, `viewings`, `groupJoinRequests` and
 * `coopJoinRequests` (ENG-495, data-export-contributors-safety.ts), so one
 * Housing checkbox takes everything the member holds in the housing domain.
 */
@Injectable()
export class HousingExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'housing';

  constructor(
    @InjectRepository(HousingListing)
    private readonly housingListings: Repository<HousingListing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    // `withDeleted` (ENG-466): a listing the member deleted is a soft-deleted
    // row that is still theirs, so it belongs in their export. Deleting it
    // cleared its address and coordinates, and none of those are exported.
    const rows = await this.housingListings.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
      withDeleted: true,
    });
    return rows.map((housingListing) => ({
      id: housingListing.id,
      slug: housingListing.slug,
      title: housingListing.title,
      city: housingListing.city,
      rentEuros: housingListing.rentEuros,
      status: housingListing.status,
      createdAt: housingListing.createdAt.toISOString(),
      deletedAt: housingListing.deletedAt
        ? housingListing.deletedAt.toISOString()
        : null,
    }));
  }
}

@Injectable()
export class SavedExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'saved';

  constructor(
    @InjectRepository(SavedItem)
    private readonly savedItems: Repository<SavedItem>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.savedItems.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((savedItem) => ({
      id: savedItem.id,
      subjectType: savedItem.subjectType,
      subjectId: savedItem.subjectId,
      title: savedItem.title,
      href: savedItem.href,
      savedAt: savedItem.createdAt.toISOString(),
    }));
  }
}

/** The payload with its `excerpt` emptied, when it carries one. */
function withBlankExcerpt(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return payload && 'excerpt' in payload
    ? { ...payload, excerpt: '' }
    : payload;
}

/**
 * The export keeps the member's own record and leaves out frozen copies of
 * other people's words that no in-app surface ever showed the member. Each
 * entry names the payload keys of one notification type that hold free text
 * written by somebody else, copied at send time, which the bell drops
 * (`PAYLOAD_ALLOWLIST` in `notification-response.ts`) and no other screen
 * serves from the row:
 *  - `excerpt` on the reply and new-post types: 140 characters of the reply
 *    or post body (`mention-notification.service.ts` `notifyParentReply`,
 *    `notifyThreadReply`, `notifyPostReply`, fed by `ForumPostsService.reply`
 *    and `CommunityPostsService`; `CommunityPostsService.notifyRosterOfPost`
 *    for the roster fan-out). The post itself stays readable where it lives.
 *  - `body` on `EventAnnouncement`: the host's announcement
 *    (`EventAnnouncementsService`), shown in full on the event page.
 *
 * `Mention` is left off on purpose: the mentions inbox shows its excerpt
 * while the source is fresh, so the export keeps it and blanks it when stale,
 * as the inbox does. Text a moderator, reviewer or staff member wrote TO the
 * member (a decline reason, a decision reason, a review note, a moderation
 * note) is the member's own record and is never listed here. A new type that
 * copies someone else's text into its payload adds one line.
 */
export const EXPORT_WITHHELD_TEXT_KEYS: Partial<
  Record<NotificationType, readonly string[]>
> = {
  [NotificationType.CommunityReply]: ['excerpt'],
  [NotificationType.ForumReply]: ['excerpt'],
  [NotificationType.ForumThreadReply]: ['excerpt'],
  [NotificationType.CommunityNewPost]: ['excerpt'],
  [NotificationType.CommunityAnnouncement]: ['excerpt'],
  [NotificationType.EventAnnouncement]: ['body'],
};

/**
 * Types whose `actorId` the export keeps although the bell row never names
 * the actor. `ACTOR_PAYLOAD_KEY` describes what the bell displays; the member
 * can be shown a person elsewhere, and on these types the actor is part of
 * the member's own record:
 *  - `CommunityInviteReceived`: the invite is addressed to the member, the
 *    My invites page names the inviter (`CommunityInvitesService`, the
 *    `invitedByUserId` it resolves for each listed invite), and no other
 *    export section records received invites.
 *  - `CommunityOwnershipTransferred`: the member is a party to the transfer,
 *    so the person who made it is part of their own record, as is the other
 *    party in `counterpartId`, which the export keeps on the same ground as
 *    `IntroductionMade.addresseeId`.
 */
export const EXPORT_KEPT_ACTOR_TYPES: ReadonlySet<NotificationType> = new Set([
  NotificationType.CommunityInviteReceived,
  NotificationType.CommunityOwnershipTransferred,
]);

/**
 * Every payload key the export leaves out for a type. `actorId` goes on
 * every type whose bell row never names its actor (`ACTOR_PAYLOAD_KEY` holds
 * no `actorId` entry for it), so the archive names nobody the bell keeps
 * unnamed, such as the platform admin behind a `CommunityRoleChanged`. A type
 * that does name its actor keeps the id, which is who the member was shown,
 * and so does a type in `EXPORT_KEPT_ACTOR_TYPES`.
 */
export function exportWithheldKeysOf(type: NotificationType): string[] {
  const isActorKept =
    ACTOR_PAYLOAD_KEY[type] === 'actorId' || EXPORT_KEPT_ACTOR_TYPES.has(type);
  return [
    ...(EXPORT_WITHHELD_TEXT_KEYS[type] ?? []),
    ...(isActorKept ? [] : ['actorId']),
  ];
}

/**
 * The payload as exported: the stale-excerpt blank applied, then every
 * withheld key removed. Keys are only ever removed, so a masked or anonymous
 * row that was written without an identifier never gains one. A payload with
 * nothing to change travels as stored.
 */
function exportedPayloadOf(
  notification: Notification,
  isExcerptStale: boolean,
): Record<string, unknown> {
  const payload = isExcerptStale
    ? withBlankExcerpt(notification.payload)
    : notification.payload;
  if (!payload) return payload;
  const presentWithheldKeys = exportWithheldKeysOf(notification.type).filter(
    (key) => key in payload,
  );
  if (!presentWithheldKeys.length) return payload;
  const exportedPayload = { ...payload };
  for (const key of presentWithheldKeys) delete exportedPayload[key];
  return exportedPayload;
}

@Injectable()
export class NotificationsExportContributor implements DataExportContribution {
  readonly category = 'notifications';
  readonly archiveKey = 'notifications';

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly dataSource: DataSource,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    // Task 13g: the raw `payload` goes out verbatim, a mention's excerpt
    // included, so a row naming a business mailbox thread this member is now
    // blocked out of is left out, as the bell and the mentions inbox leave
    // it out (`visibleThroughMailboxSeatRules`). Task 14a: a thread of a
    // business this member has left is left out the same way.
    const rows = await this.notifications.find({
      where: { userId, payload: visibleThroughMailboxSeatRules(userId) },
      order: { createdAt: 'ASC' },
    });
    // ENG-411: a mention's `excerpt` is a copy of someone else's words taken
    // at mention time. Once the source is deleted, deleted for everyone,
    // edited, taken down or in a thread the member can no longer read, the
    // export blanks it exactly as the mentions inbox does, through the same
    // check. Every other type leaves out the keys `exportWithheldKeysOf`
    // names: other people's words the member was never shown, and the
    // `actorId` of types whose bell never names the actor (outside
    // `EXPORT_KEPT_ACTOR_TYPES`). The rest of the payload travels as stored.
    //
    // PRD-403: the bell also hides a row whose actor is blocked either way
    // (`visibleThroughActorBlocks`). The export leaves that filter off on
    // purpose, because the archive is the member's own record of what they
    // were sent.
    const staleExcerptIds = await staleMentionExcerptIds(rows, this.dataSource);
    return rows.map((notification) => ({
      id: notification.id,
      type: notification.type,
      payload: exportedPayloadOf(
        notification,
        staleExcerptIds.has(notification.id),
      ),
      read: notification.read,
      createdAt: notification.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class ConsentExportContributor implements DataExportContribution {
  readonly category = 'consent';
  readonly archiveKey = 'consent';

  constructor(
    @InjectRepository(ConsentRecord)
    private readonly consentRecords: Repository<ConsentRecord>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.consentRecords.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((consentRecord) => ({
      id: consentRecord.id,
      analytics: consentRecord.analytics,
      monitoring: consentRecord.monitoring,
      policyVersion: consentRecord.policyVersion,
      source: consentRecord.source,
      action: consentRecord.action,
      createdAt: consentRecord.createdAt.toISOString(),
    }));
  }
}

/**
 * Membership cards (spec §K.3) are personal data: a card ties a member to a
 * community and carries a serial that proves that membership at a door.
 * Delegates to `MyCardsService.forUser` rather than re-querying the tables
 * directly, so the archive's shape (status resolution against the
 * programme/community, holder name from `Profile`) always matches exactly
 * what the member sees on `GET /me/cards`.
 */
@Injectable()
export class MembershipCardsExportContributor implements DataExportContribution {
  readonly category = 'membershipCards';
  readonly archiveKey = 'membershipCards';

  constructor(private readonly myCards: MyCardsService) {}

  async buildContribution(userId: string): Promise<unknown> {
    return this.myCards.forUser(userId);
  }
}

/**
 * `magazine` — the member's own writing for the magazine.
 *
 * This is the category the Art. 20 review called out by name: a member could
 * take their forum posts and their DMs, but not a single word of the magazine
 * work they wrote. So the BODY travels, in both representations the desk keeps
 * — the legacy `body` text and the block editor's `blocks` — because an export
 * that carries an article's title and word count but not its paragraphs is not
 * portability, it is a receipt.
 *
 * Three sources, merged with a `type` discriminator the way `buildPosts` merges
 * threads and replies:
 *
 *  - `article`     everything bylined to this member, DRAFTS INCLUDED. An
 *                  article points at `magazine_author`, not at `users`, so the
 *                  member's author row is resolved first; a member who never
 *                  wrote for the magazine has none and this is empty.
 *  - `submission`  writing they sent in through the open story-submission door,
 *                  whatever the desk decided about it.
 *  - `piece`       desk assignments where THEY are the writer. Rows where they
 *                  are only the editor are left out: that is commissioning
 *                  metadata about somebody else's piece.
 */
@Injectable()
export class MagazineExportContributor implements DataExportContribution {
  readonly category = 'magazine';
  readonly archiveKey = 'magazine';

  constructor(
    @InjectRepository(MagazineAuthor)
    private readonly magazineAuthors: Repository<MagazineAuthor>,
    @InjectRepository(MagazineArticle)
    private readonly magazineArticles: Repository<MagazineArticle>,
    @InjectRepository(MagazineStorySubmission)
    private readonly storySubmissions: Repository<MagazineStorySubmission>,
    @InjectRepository(MagazinePiece)
    private readonly magazinePieces: Repository<MagazinePiece>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const author = await this.magazineAuthors.findOne({ where: { userId } });
    const [articles, submissions, pieces] = await Promise.all([
      author
        ? this.magazineArticles.find({
            where: { authorId: author.id },
            order: { createdAt: 'ASC' },
          })
        : Promise.resolve([]),
      this.storySubmissions.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.magazinePieces.find({
        where: { writerId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...articles.map((article) => ({
        type: 'article' as const,
        id: article.id,
        slug: article.slug,
        title: article.title,
        dek: article.dek,
        standfirst: article.standfirst,
        kicker: article.kicker,
        section: article.section,
        locale: article.locale,
        tags: article.tags,
        contentNotes: article.contentNotes,
        readMinutes: article.readMinutes,
        // Both body representations travel. `blocks` is what the block editor
        // writes; `body` is the older plain-text field. Which one holds the
        // words depends on when the piece was written, so exporting only one
        // would silently lose a whole generation of articles.
        body: article.body,
        blocks: article.blocks,
        lifecycle: article.lifecycle,
        isPublished: article.publishedAt !== null,
        publishedAt: article.publishedAt
          ? article.publishedAt.toISOString()
          : null,
        issueId: article.issueId,
        createdAt: article.createdAt.toISOString(),
        updatedAt: article.updatedAt.toISOString(),
      })),
      ...submissions.map((submission) => ({
        type: 'submission' as const,
        id: submission.id,
        format: submission.format,
        workingTitle: submission.workingTitle,
        pitch: submission.pitch,
        deck: submission.deck,
        body: submission.body,
        status: submission.status,
        decision: submission.decision,
        decisionNote: submission.decisionNote,
        createdAt: submission.createdAt.toISOString(),
      })),
      ...pieces.map((piece) => ({
        type: 'piece' as const,
        id: piece.id,
        format: piece.format,
        title: piece.title,
        section: piece.section,
        kind: piece.kind,
        stage: piece.stage,
        byline: piece.byline,
        contentsBlurb: piece.contentsBlurb,
        wordTarget: piece.wordTarget,
        dueOn: piece.dueOn,
        issueId: piece.issueId,
        articleId: piece.articleId,
        // `writerId === editorId` is the desk's "I write this one" — worth
        // surfacing so the member can tell a self-written piece from a
        // commission without holding the desk's rules in their head.
        isSelfCommissioned: piece.writerId === piece.editorId,
        createdAt: piece.createdAt.toISOString(),
        updatedAt: piece.updatedAt.toISOString(),
      })),
    ];
  }
}

/**
 * `communities` — the communities this member OWNS, plus everything they wrote
 * inside any community.
 *
 * Communities they merely belong to are not exported here: a community is a
 * shared thing, and its roster, rules and purpose are the community's data
 * rather than one member's. What IS theirs is the community they run (they
 * wrote its purpose, its rules, its welcome message) and every post and reply
 * they authored anywhere.
 *
 * Soft-deleted posts are INCLUDED, carrying their `deletedAt`. `deleted_at`
 * here is a plain column rather than a `@DeleteDateColumn`, and a post can be
 * removed by a moderator as well as by its author — so dropping them would
 * quietly withhold the member's own words from them precisely in the case they
 * are most likely to want the record.
 */
@Injectable()
export class CommunitiesExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communities';

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly communityPostReplies: Repository<CommunityPostReply>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [owned, posts, replies] = await Promise.all([
      this.communities.find({
        where: { ownerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.communityPosts.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.communityPostReplies.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...owned.map((community) => ({
        type: 'ownedCommunity' as const,
        id: community.id,
        ref: community.ref,
        slug: community.slug,
        name: community.name,
        tagline: community.tagline,
        nowReading: community.nowReading,
        purpose: community.purpose,
        whoFor: community.whoFor,
        communityType: community.type,
        accessTier: community.accessTier,
        rules: community.rules,
        welcomeMessage: community.welcomeMessage,
        tags: community.tags,
        city: community.city,
        area: community.area,
        isOnline: community.isOnline,
        isPubliclyListed: community.isPubliclyListed,
        createdAt: community.createdAt.toISOString(),
        archivedAt: community.archivedAt
          ? community.archivedAt.toISOString()
          : null,
      })),
      ...posts.map((post) => ({
        type: 'post' as const,
        id: post.id,
        communityId: post.communityId,
        kind: post.kind,
        body: post.body,
        image: post.image,
        pinned: post.pinned,
        createdAt: post.createdAt.toISOString(),
        editedAt: post.editedAt ? post.editedAt.toISOString() : null,
        deletedAt: post.deletedAt ? post.deletedAt.toISOString() : null,
      })),
      ...replies.map((reply) => ({
        type: 'reply' as const,
        id: reply.id,
        postId: reply.postId,
        text: reply.text,
        createdAt: reply.createdAt.toISOString(),
        editedAt: reply.editedAt ? reply.editedAt.toISOString() : null,
        deletedAt: reply.deletedAt ? reply.deletedAt.toISOString() : null,
      })),
    ];
  }
}

/**
 * `volunteering` — the member's signups and what became of them.
 *
 * Each row carries the opportunity's org/role/causes alongside the signup, for
 * the same reason the `events` category inlines an event's title: an archive of
 * opaque uuids is not something a person can read. One extra query for the
 * opportunities rather than N, guarded for the never-signed-up case.
 */
@Injectable()
export class VolunteeringExportContributor implements DataExportContribution {
  readonly category = 'volunteering';
  readonly archiveKey = 'volunteering';

  constructor(
    @InjectRepository(VolunteerSignup)
    private readonly volunteerSignups: Repository<VolunteerSignup>,
    @InjectRepository(VolunteerOpportunity)
    private readonly volunteerOpportunities: Repository<VolunteerOpportunity>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const signups = await this.volunteerSignups.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    const opportunityIds = signups.map((signup) => signup.opportunityId);
    const opportunities = opportunityIds.length
      ? await this.volunteerOpportunities.find({
          where: { id: In(opportunityIds) },
        })
      : [];
    const opportunityById = new Map(
      opportunities.map((opportunity) => [opportunity.id, opportunity]),
    );
    return signups.map((signup) => {
      const opportunity = opportunityById.get(signup.opportunityId);
      return {
        id: signup.id,
        opportunityId: signup.opportunityId,
        org: opportunity?.org ?? null,
        role: opportunity?.role ?? null,
        causes: opportunity?.causes ?? null,
        location: opportunity?.location ?? null,
        note: signup.note,
        status: signup.status,
        signedUpAt: signup.createdAt.toISOString(),
        decidedAt: signup.decidedAt ? signup.decidedAt.toISOString() : null,
      };
    });
  }
}

/**
 * `governance` — how the member took part in running the place.
 *
 * Their VOTES, each carrying the proposal's title and window so the record
 * reads on its own, plus the proposals they PUT FORWARD (a proposal's title and
 * description are the member's own writing, and until now they had no way to
 * take them). Nothing about how anyone ELSE voted: a ballot is that member's
 * personal data, not this one's.
 */
@Injectable()
export class GovernanceExportContributor implements DataExportContribution {
  readonly category = 'governance';
  readonly archiveKey = 'governance';

  constructor(
    @InjectRepository(GovernanceVote)
    private readonly governanceVotes: Repository<GovernanceVote>,
    @InjectRepository(GovernanceProposal)
    private readonly governanceProposals: Repository<GovernanceProposal>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [votes, authored] = await Promise.all([
      this.governanceVotes.find({
        where: { memberId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.governanceProposals.find({
        where: { proposedByMemberId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const proposalIds = votes.map((vote) => vote.proposalId);
    const votedProposals = proposalIds.length
      ? await this.governanceProposals.find({ where: { id: In(proposalIds) } })
      : [];
    const proposalById = new Map(
      votedProposals.map((proposal) => [proposal.id, proposal]),
    );
    return [
      ...votes.map((vote) => {
        const proposal = proposalById.get(vote.proposalId);
        return {
          type: 'vote' as const,
          id: vote.id,
          proposalId: vote.proposalId,
          proposalTitle: proposal?.title ?? null,
          proposalType: proposal?.type ?? null,
          proposalStatus: proposal?.status ?? null,
          choice: vote.choice,
          votedAt: vote.createdAt.toISOString(),
        };
      }),
      ...authored.map((proposal) => ({
        type: 'proposal' as const,
        id: proposal.id,
        proposalType: proposal.type,
        title: proposal.title,
        description: proposal.description,
        status: proposal.status,
        opensAt: proposal.opensAt.toISOString(),
        closesAt: proposal.closesAt.toISOString(),
        createdAt: proposal.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `reviews` — the reviews the member WROTE.
 *
 * Three review tables exist and a user authors all three: business-directory
 * listings (`listing_reviews.reviewer_id`), employers
 * (`company_reviews.author_id`) and housing viewings
 * (`housing_reviews.author_id`). Reviews written ABOUT the member are somebody
 * else's statement and belong in that person's export, so nothing here is
 * keyed on being the subject.
 *
 * `ownerReplyText` on a listing review is included because it is the reply to
 * THIS member's review and is already shown to them on the listing page; the
 * replying owner is identified only by the listing, which is public.
 */
@Injectable()
export class ReviewsExportContributor implements DataExportContribution {
  readonly category = 'reviews';
  readonly archiveKey = 'reviews';

  constructor(
    @InjectRepository(ListingReview)
    private readonly listingReviews: Repository<ListingReview>,
    @InjectRepository(CompanyReview)
    private readonly companyReviews: Repository<CompanyReview>,
    @InjectRepository(HousingReview)
    private readonly housingReviews: Repository<HousingReview>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [listing, company, housing] = await Promise.all([
      this.listingReviews.find({
        where: { reviewerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.companyReviews.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.housingReviews.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...listing.map((review) => ({
        type: 'listingReview' as const,
        id: review.id,
        listingId: review.listingId,
        byline: review.byline,
        stars: review.stars,
        text: review.text,
        photo: review.photo,
        helpful: review.helpful,
        ownerReplyText: review.ownerReplyText,
        ownerRepliedAt: review.ownerRepliedAt
          ? review.ownerRepliedAt.toISOString()
          : null,
        createdAt: review.createdAt.toISOString(),
        editedAt: review.editedAt ? review.editedAt.toISOString() : null,
      })),
      ...company.map((review) => ({
        type: 'companyReview' as const,
        id: review.id,
        companyId: review.companyId,
        title: review.title,
        byline: review.byline,
        stars: review.stars,
        body: review.body,
        createdAt: review.createdAt.toISOString(),
      })),
      ...housing.map((review) => ({
        type: 'housingReview' as const,
        id: review.id,
        listingId: review.listingId,
        viewingId: review.viewingId,
        authorRole: review.authorRole,
        rating: review.rating,
        text: review.text,
        submittedAt: review.submittedAt.toISOString(),
        createdAt: review.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `nowHistory`: the retired "Now" statuses behind the profile card
 * (`profile_now_history`). `AccountExportService.buildProfile` already ships
 * the CURRENT status as `profile.now`, but the rows this member replaced it
 * with are their own personal data too, and owner-only by construction (see
 * the entity's docstring: no endpoint returns these to anyone but the member
 * they belong to), so they were missing from the archive entirely rather than
 * merely folded into another key.
 */
@Injectable()
export class ProfileNowHistoryExportContributor implements DataExportContribution {
  readonly category = 'nowHistory';
  readonly archiveKey = 'nowHistory';

  constructor(
    @InjectRepository(ProfileNowHistory)
    private readonly nowHistory: Repository<ProfileNowHistory>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.nowHistory.find({
      where: { userId },
      order: { endedAt: 'ASC' },
    });
    return rows.map((entry) => ({
      id: entry.id,
      text: entry.text,
      startedAt: entry.startedAt.toISOString(),
      endedAt: entry.endedAt.toISOString(),
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

/**
 * `goTogether`: the member's Go together questionnaire, the opt-ins they
 * made, the "meet again" verdicts they gave about other people, their
 * answers about each group as a whole, and their private "Not for me"
 * avoidances.
 *
 * Only the member's own rows go into the export: the answers and verdicts
 * this member gave themselves. A "meet again" verdict is one member's
 * private read of another, so a row where this member is only the subject
 * (`rateeId`) stays in the rater's own export.
 */
@Injectable()
export class GoTogetherExportContributor implements DataExportContribution {
  readonly category = 'goTogether';
  readonly archiveKey = 'go-together';

  constructor(
    @InjectRepository(FriendMatchProfile)
    private readonly profiles: Repository<FriendMatchProfile>,
    @InjectRepository(EventMatchEntry)
    private readonly entries: Repository<EventMatchEntry>,
    @InjectRepository(MatchFeedback)
    private readonly feedback: Repository<MatchFeedback>,
    @InjectRepository(MatchGroupFeedback)
    private readonly groupFeedback: Repository<MatchGroupFeedback>,
    @InjectRepository(MatchAvoidance)
    private readonly avoidances: Repository<MatchAvoidance>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [profile, entries, given, groupAnswers, avoided] = await Promise.all([
      this.profiles.findOne({ where: { userId } }),
      this.entries.find({ where: { userId }, order: { createdAt: 'ASC' } }),
      this.feedback.find({
        where: { raterId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.groupFeedback.find({
        where: { raterId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.avoidances.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return {
      questionnaire: profile
        ? {
            answers: profile.answers,
            questionnaireVersion: profile.questionnaireVersion,
            consentedAt: profile.consentedAt.toISOString(),
            updatedAt: profile.updatedAt.toISOString(),
          }
        : null,
      optIns: entries.map((entry) => ({
        eventId: entry.eventId,
        status: entry.status,
        pairStatus: entry.pairStatus,
        lens: entry.lens,
        lensConsentedAt: entry.lensConsentedAt?.toISOString() ?? null,
        hostAnswers: entry.hostAnswers,
        groupId: entry.groupId,
        checkedInAt: entry.checkedInAt?.toISOString() ?? null,
        leftEventAt: entry.leftEventAt?.toISOString() ?? null,
        createdAt: entry.createdAt.toISOString(),
      })),
      meetAgainAnswersGiven: given.map((row) => ({
        groupId: row.groupId,
        aboutUserId: row.rateeId,
        verdict: row.verdict,
        updatedAt: row.updatedAt.toISOString(),
      })),
      groupAnswersGiven: groupAnswers.map((row) => ({
        groupId: row.groupId,
        clicked: row.clicked,
        goAgain: row.goAgain,
        updatedAt: row.updatedAt.toISOString(),
      })),
      notForMe: avoided.map((row) => ({
        userId: row.avoidedUserId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * `media` — the member's uploaded FILES.
 *
 * This contribution deliberately carries no bytes. It lists what the bucket
 * holds for this member (key, upload kind, size, last-modified) and leaves the
 * download to stream the actual objects into the zip under `media/` — see
 * `export-media.ts` for the full reasoning, and
 * `AccountController.appendEntries` for the streaming pass.
 *
 * A storage failure here is recorded, not thrown: the rest of the member's Art.
 * 20 archive is still theirs to take, and a failed export job would deny them
 * all of it over a bucket outage.
 */
@Injectable()
export class MediaExportContributor implements DataExportContribution {
  readonly category = 'media';
  readonly archiveKey = 'media';

  private readonly logger = new Logger(MediaExportContributor.name);

  constructor(
    private readonly storage: StorageService,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    // T17: images the member uploaded to an unlinked persona live under
    // persona-scoped keys no prefix listing reaches.
    private readonly personaImageKeys: PersonaImageKeysService,
  ) {}

  async buildContribution(userId: string): Promise<ExportMediaContribution> {
    try {
      const objects = [
        ...(await this.storage.listUserObjects(userId)),
        ...(await this.personaImageKeys.listObjectsUploadedBy(userId)),
      ];
      const messageIdByStorageKey = await this.messageIdsForStorageKeys(
        userId,
        objects.map((object) => object.key),
      );
      return planExportMedia(objects, messageIdByStorageKey);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Export media listing failed for user ${userId}: ${reason}`,
      );
      return {
        objectCount: 0,
        totalBytes: 0,
        includedBytes: 0,
        capBytes: MEDIA_EXPORT_MAX_TOTAL_BYTES,
        files: [],
        skippedOverCap: [],
        listingError: reason,
      };
    }
  }

  /**
   * PRD-370: which of the member's own live messages carries each
   * `message-image` / `message-document` object, in ONE query. Matches the
   * stored `attachment.url` against both spellings of each key (as listed and
   * bare), then keys the result by the bare key `planExportMedia` looks up.
   * Tombstones are excluded by the default soft-delete filter, matching the
   * archive's `messages`, so a `messageId` always names a row the member can
   * find there.
   */
  private async messageIdsForStorageKeys(
    userId: string,
    storageKeys: string[],
  ): Promise<Map<string, string>> {
    const candidateKeys = new Set<string>();
    for (const storageKey of storageKeys) {
      const uploadKind = uploadKindForStorageKey(toBareKey(storageKey));
      if (uploadKind === 'message-image' || uploadKind === 'message-document') {
        candidateKeys.add(storageKey);
        candidateKeys.add(toBareKey(storageKey));
      }
    }
    if (candidateKeys.size === 0) {
      return new Map();
    }
    const rows = await this.messages
      .createQueryBuilder('message')
      .select('message.id', 'id')
      .addSelect(`message.attachment ->> 'url'`, 'storageKey')
      .where('message.sender_id = :userId', { userId })
      .andWhere(`message.attachment ->> 'url' = ANY(:candidateKeys)`, {
        candidateKeys: [...candidateKeys],
      })
      .getRawMany<{ id: string; storageKey: string }>();
    return new Map(rows.map((row) => [toBareKey(row.storageKey), row.id]));
  }
}

/** Every newer-domain contributor, in archive order. */
export const NEW_DOMAIN_EXPORT_CONTRIBUTORS = [
  SubprofilesExportContributor,
  ListingsExportContributor,
  HousingExportContributor,
  // ENG-495: the rest of the `housing` category and the member-held safety,
  // consent and account-settings tables (see data-export-contributors-safety.ts
  // and data-export-contributors-account.ts).
  FlatmateProfileExportContributor,
  HousingViewingsExportContributor,
  GroupJoinRequestsExportContributor,
  CoopJoinRequestsExportContributor,
  FlatmateLikesExportContributor,
  HousingSavedSearchesExportContributor,
  SavedExportContributor,
  NotificationsExportContributor,
  PushDevicesExportContributor,
  NotificationPreferencesExportContributor,
  ConsentExportContributor,
  PolicyAcceptancesExportContributor,
  PolicyStatusExportContributor,
  BlocksExportContributor,
  MutesExportContributor,
  HiddenMembersExportContributor,
  ReportsFiledExportContributor,
  SessionsExportContributor,
  MembershipCardsExportContributor,
  MagazineExportContributor,
  CommunitiesExportContributor,
  VolunteeringExportContributor,
  GovernanceExportContributor,
  ReviewsExportContributor,
  ProfileNowHistoryExportContributor,
  GoTogetherExportContributor,
  // ENG-495b: the member-held tables the entity audit found still missing
  // (settings, profile sections, requests, votes, reactions and follows), see
  // data-export-contributors-more.ts.
  ...MORE_EXPORT_CONTRIBUTORS,
  MediaExportContributor,
] as const;

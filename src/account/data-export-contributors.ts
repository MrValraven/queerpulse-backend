import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CompanyReview } from '../companies/entities/company-review.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ConsentRecord } from '../consent/entities/consent-record.entity';
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
import { Notification } from '../notifications/entities/notification.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageService } from '../storage/storage.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { DataExportContribution } from './data-export-contributor';
import {
  ExportMediaContribution,
  MEDIA_EXPORT_MAX_TOTAL_BYTES,
  planExportMedia,
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

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.listings.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((listing) => ({
      id: listing.id,
      ref: listing.ref,
      slug: listing.slug,
      name: listing.name,
      status: listing.status,
      createdAt: listing.createdAt.toISOString(),
    }));
  }
}

@Injectable()
export class HousingExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'housing';

  constructor(
    @InjectRepository(HousingListing)
    private readonly housingListings: Repository<HousingListing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.housingListings.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((housingListing) => ({
      id: housingListing.id,
      slug: housingListing.slug,
      title: housingListing.title,
      city: housingListing.city,
      rentEuros: housingListing.rentEuros,
      status: housingListing.status,
      createdAt: housingListing.createdAt.toISOString(),
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

@Injectable()
export class NotificationsExportContributor implements DataExportContribution {
  readonly category = 'notifications';
  readonly archiveKey = 'notifications';

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.notifications.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((notification) => ({
      id: notification.id,
      type: notification.type,
      payload: notification.payload,
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
 * Each row carries the opportunity's org/role/cause alongside the signup, for
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
        cause: opportunity?.cause ?? null,
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

  constructor(private readonly storage: StorageService) {}

  async buildContribution(userId: string): Promise<ExportMediaContribution> {
    try {
      const objects = await this.storage.listUserObjects(userId);
      return planExportMedia(objects);
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
}

/** Every newer-domain contributor, in archive order. */
export const NEW_DOMAIN_EXPORT_CONTRIBUTORS = [
  SubprofilesExportContributor,
  ListingsExportContributor,
  HousingExportContributor,
  SavedExportContributor,
  NotificationsExportContributor,
  ConsentExportContributor,
  MembershipCardsExportContributor,
  MagazineExportContributor,
  CommunitiesExportContributor,
  VolunteeringExportContributor,
  GovernanceExportContributor,
  ReviewsExportContributor,
  MediaExportContributor,
] as const;

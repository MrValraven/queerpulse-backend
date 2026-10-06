import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository } from 'typeorm';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { DeletionRequest } from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';
import { Affiliation } from '../affiliation/entities/affiliation.entity';
import { Ambassador } from '../ambassadors/entities/ambassador.entity';
import { BarterListing } from '../barter/entities/barter-listing.entity';
import { BarterProposal } from '../barter/entities/barter-proposal.entity';
import { ChangemakerNomination } from '../changemakers/entities/changemaker-nomination.entity';
import { WatchProgress } from '../cinema/entities/watch-progress.entity';
import { CollectionItem } from '../collections/entities/collection-item.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CommunityInvite } from '../communities/entities/community-invite.entity';
import { CommunityJoinRequest } from '../communities/entities/community-join-request.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityOwnerReviewRequest } from '../communities/entities/community-owner-review-request.entity';
import { CommunityPostEdit } from '../communities/entities/community-post-edit.entity';
import { CommunityPostReaction } from '../communities/entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from '../communities/entities/community-post-reply-edit.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunityResource } from '../communities/entities/community-resource.entity';
import { CommunitySpaceRequest } from '../communities/entities/community-space-request.entity';
import { CommunityTagRequest } from '../communities/entities/community-tag-request.entity';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { Company } from '../companies/entities/company.entity';
import { ConnectionNote } from '../connections/entities/connection-note.entity';
import { CommissionInterest } from '../culture/entities/commission-interest.entity';
import { Draft } from '../drafts/entities/draft.entity';
import { EventAnnouncement } from '../events/entities/event-announcement.entity';
import { EventBookmark } from '../events/entities/event-bookmark.entity';
import { EventCohostInvite } from '../events/entities/event-cohost-invite.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { EventLineupEntry } from '../events/entities/event-lineup-entry.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { EventSeries } from '../events/entities/event-series.entity';
import { MemberEventReminderPreferences } from '../events/entities/member-event-reminder-preferences.entity';
import { FeedSourceMute } from '../feed/entities/feed-source-mute.entity';
import { ForumPollOption } from '../forum/entities/forum-poll-option.entity';
import { ForumPollVote } from '../forum/entities/forum-poll-vote.entity';
import { ForumPoll } from '../forum/entities/forum-poll.entity';
import { ForumPostEdit } from '../forum/entities/forum-post-edit.entity';
import { ForumPostVote } from '../forum/entities/forum-post-vote.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThreadSubscription } from '../forum/entities/forum-thread-subscription.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { GovernanceProposalCosignature } from '../governance/entities/governance-proposal-cosignature.entity';
import { HandleHistory } from '../handles/entities/handle-history.entity';
import { Handle } from '../handles/entities/handle.entity';
import { GroupListing } from '../housing-groups/entities/group-listing.entity';
import { IdentityStaffPreference } from '../identities/entities/identity-staff-preference.entity';
import { IntakeSubmission } from '../intakes/entities/intake-submission.entity';
import { JobApplication } from '../jobs/entities/job-application.entity';
import { Job } from '../jobs/entities/job.entity';
import { LandlordIntroRequest } from '../landlords/entities/landlord-intro-request.entity';
import { LandlordRecommendation } from '../landlords/entities/landlord-recommendation.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { ListingDraft } from '../listing-drafts/entities/listing-draft.entity';
import { ListingClaim } from '../listings/entities/listing-claim.entity';
import { ListingCoManager } from '../listings/entities/listing-co-manager.entity';
import { ListingEditSuggestion } from '../listings/entities/listing-edit-suggestion.entity';
import { ListingEnquiry } from '../listings/entities/listing-enquiry.entity';
import { ListingOwnerOffer } from '../listings/entities/listing-owner-offer.entity';
import { ListingPublicQuestion } from '../listings/entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from '../listings/entities/listing-review-helpful-vote.entity';
import { MagazineArticleComment } from '../magazine/entities/magazine-article-comment.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { MagazinePayment } from '../magazine/entities/magazine-payment.entity';
import { MagazinePieceMessage } from '../magazine/entities/magazine-piece-message.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { MagazinePitch } from '../magazine/entities/magazine-pitch.entity';
import { MagazineReaderComment } from '../magazine/entities/magazine-reader-comment.entity';
import { MagazineWriterApplication } from '../magazine/entities/magazine-writer-application.entity';
import { MediaCrop } from '../media-crops/entities/media-crop.entity';
import { MemberSuggestionDismissal } from '../member-suggestions/entities/member-suggestion-dismissal.entity';
import { MembershipCardScan } from '../membership-cards/entities/membership-card-scan.entity';
import { MembershipCard } from '../membership-cards/entities/membership-card.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { GroupInvite } from '../messaging/entities/group-invite.entity';
import { MessageHide } from '../messaging/entities/message-hide.entity';
import { MessageReaction } from '../messaging/entities/message-reaction.entity';
import { MessageStar } from '../messaging/entities/message-star.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { Partner } from '../partners/entities/partner.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { BoardPostResponse } from '../profiles/entities/board-post-response.entity';
import { BoardPost } from '../profiles/entities/board-post.entity';
import { GroupMembership } from '../profiles/entities/group-membership.entity';
import { ProfileFeaturedCommunity } from '../profiles/entities/profile-featured-community.entity';
import { ProfileLastActive } from '../profiles/entities/profile-last-active.entity';
import { Shaping } from '../profiles/entities/shaping.entity';
import { Skill } from '../profiles/entities/skill.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { ReadingGroupProposal } from '../reading-group-proposals/entities/reading-group-proposal.entity';
import { RecognitionAward } from '../recognition/entities/recognition-award.entity';
import { RecognitionLedgerEntry } from '../recognition/entities/recognition-ledger-entry.entity';
import { RecognitionPerkClaim } from '../recognition/entities/recognition-perk-claim.entity';
import { ResourceGuideRating } from '../resources/entities/resource-guide-rating.entity';
import { ResourceSuggestion } from '../resources/entities/resource-suggestion.entity';
import { RoadmapIdea } from '../roadmap/entities/roadmap-idea.entity';
import { RoadmapItemComment } from '../roadmap/entities/roadmap-item-comment.entity';
import { RoadmapVote } from '../roadmap/entities/roadmap-vote.entity';
import { SafeSpaceFlag } from '../safe-space-nominations/entities/safe-space-flag.entity';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { SavedListEntry } from '../saved/entities/saved-list-entry.entity';
import { SavedList } from '../saved/entities/saved-list.entity';
import { SubprofileAffiliation } from '../subprofiles/entities/subprofile-affiliation.entity';
import { SubprofileEndorsement } from '../subprofiles/entities/subprofile-endorsement.entity';
import { SubprofileFeed } from '../subprofiles/entities/subprofile-feed.entity';
import { SubprofileFollower } from '../subprofiles/entities/subprofile-follower.entity';
import { SubprofileInvite } from '../subprofiles/entities/subprofile-invite.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { MemberVerification } from '../verification/entities/member-verification.entity';
import { VerificationEvent } from '../verification/entities/verification-event.entity';
import { VolunteerOpportunityTeam } from '../volunteering/entities/volunteer-opportunity-team.entity';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { DataExportContribution } from './data-export-contributor';

/**
 * ENG-495b: the member-held tables the Art. 20 archive still skipped after
 * ENG-495, found by auditing every entity with a column that points at a
 * user. Settings the member chose, profile sections they filled in, the
 * requests and submissions they sent, the quiet choices they made (votes,
 * reactions, follows, dismissals) and the writing they did outside the
 * domains the older contributors cover.
 *
 * Same idiom as `data-export-contributors-safety.ts` and
 * `data-export-contributors-account.ts`: one archive key per class, riding on
 * an existing request category, registered through
 * `NEW_DOMAIN_EXPORT_CONTRIBUTORS`. A key that merges several tables tags each
 * row with a `type`, the way `posts` merges threads and replies, and each
 * table's rows arrive oldest first.
 *
 * What stays out, on every class: credentials and tokens (invite codes,
 * resume tokens, share tokens), internal scores and signals, the notes staff
 * or moderators keep for themselves, and anyone else's words. Another member
 * appears by id alone. Text a reviewer wrote TO the member (a decline reason,
 * an appeal decision) is part of the member's own record and travels, the rule
 * `EXPORT_WITHHELD_TEXT_KEYS` in `data-export-contributors.ts` states.
 */

/** A nullable timestamp as an ISO string, or null. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// `profile`
// ---------------------------------------------------------------------------

/**
 * `profile` -> `preferences`: the member's safety, privacy and visibility
 * switches (`member_preferences`), as one object. Null when the member never
 * changed one, which means every switch is on its default.
 */
@Injectable()
export class MemberPreferencesExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'preferences';

  constructor(
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const preferences = await this.memberPreferences.findOne({
      where: { userId },
    });
    if (!preferences) return null;
    return {
      outAtWork: preferences.outAtWork,
      transSupport: preferences.transSupport,
      safeOnly: preferences.safeOnly,
      skills: preferences.skills,
      focusAreas: preferences.focusAreas,
      publicProfileEnabled: preferences.publicProfileEnabled,
      loginAlertsEnabled: preferences.loginAlertsEnabled,
      hidePushPreviews: preferences.hidePushPreviews,
      hideDatingContent: preferences.hideDatingContent,
      hideMentalHealthContent: preferences.hideMentalHealthContent,
      hideSexualityIdentityContent: preferences.hideSexualityIdentityContent,
      hideFromSuggestions: preferences.hideFromSuggestions,
      groupAddPolicy: preferences.groupAddPolicy,
      shareReadReceipts: preferences.shareReadReceipts,
      shareTyping: preferences.shareTyping,
      sharePresence: preferences.sharePresence,
      whoCanMessage: preferences.whoCanMessage,
      language: preferences.language,
      updatedAt: preferences.updatedAt.toISOString(),
    };
  }
}

/**
 * `profile` -> `profileSections`: the profile sections kept outside the
 * `profiles` row. Skills, social links, work items, the "what shaped me"
 * entries, featured communities, profile groups, the crops the member chose
 * for their images, their ambassador role and their last-active signal with
 * its hide switch.
 *
 * The ambassador row travels as its focus area and dates. The grant and
 * revoke reasons are notes staff wrote for themselves.
 */
@Injectable()
export class ProfileSectionsExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'profileSections';

  constructor(
    @InjectRepository(Skill)
    private readonly skills: Repository<Skill>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(Shaping)
    private readonly shapings: Repository<Shaping>,
    @InjectRepository(ProfileFeaturedCommunity)
    private readonly featuredCommunities: Repository<ProfileFeaturedCommunity>,
    @InjectRepository(GroupMembership)
    private readonly groupMemberships: Repository<GroupMembership>,
    @InjectRepository(MediaCrop)
    private readonly mediaCrops: Repository<MediaCrop>,
    @InjectRepository(Ambassador)
    private readonly ambassadors: Repository<Ambassador>,
    @InjectRepository(ProfileLastActive)
    private readonly lastActive: Repository<ProfileLastActive>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [
      skills,
      socialLinks,
      workItems,
      shapings,
      featuredCommunities,
      groups,
      crops,
      ambassadorRoles,
      lastActive,
    ] = await Promise.all([
      this.skills.find({ where: { userId }, ...byCreatedAt }),
      this.socialLinks.find({ where: { userId }, ...byCreatedAt }),
      this.workItems.find({ where: { userId }, ...byCreatedAt }),
      this.shapings.find({ where: { userId }, ...byCreatedAt }),
      this.featuredCommunities.find({ where: { userId }, ...byCreatedAt }),
      this.groupMemberships.find({ where: { userId }, ...byCreatedAt }),
      this.mediaCrops.find({ where: { ownerId: userId }, ...byCreatedAt }),
      this.ambassadors.find({
        where: { userId },
        order: { grantedAt: 'ASC' },
      }),
      this.lastActive.findOne({ where: { userId } }),
    ]);
    return [
      ...skills.map((skill) => ({
        type: 'skill' as const,
        id: skill.id,
        name: skill.name,
        meta: skill.meta,
        position: skill.position,
        createdAt: skill.createdAt.toISOString(),
      })),
      ...socialLinks.map((link) => ({
        type: 'socialLink' as const,
        id: link.id,
        platform: link.platform,
        urlOrHandle: link.urlOrHandle,
        position: link.position,
        createdAt: link.createdAt.toISOString(),
      })),
      ...workItems.map((item) => ({
        type: 'workItem' as const,
        id: item.id,
        workCategory: item.category,
        title: item.title,
        year: item.year,
        imageUrl: item.imageUrl,
        links: item.links,
        position: item.position,
        createdAt: item.createdAt.toISOString(),
      })),
      ...shapings.map((shaping) => ({
        type: 'shaping' as const,
        id: shaping.id,
        shapingKind: shaping.kind,
        title: shaping.title,
        note: shaping.note,
        createdAt: shaping.createdAt.toISOString(),
      })),
      ...featuredCommunities.map((featured) => ({
        type: 'featuredCommunity' as const,
        id: featured.id,
        communityId: featured.communityId,
        position: featured.position,
        createdAt: featured.createdAt.toISOString(),
      })),
      ...groups.map((membership) => ({
        type: 'group' as const,
        id: membership.id,
        groupId: membership.groupId,
        role: membership.role,
        createdAt: membership.createdAt.toISOString(),
      })),
      ...crops.map((crop) => ({
        type: 'imageCrop' as const,
        storageKey: crop.storageKey,
        crop: crop.crop,
        createdAt: crop.createdAt.toISOString(),
        updatedAt: crop.updatedAt.toISOString(),
      })),
      ...ambassadorRoles.map((ambassador) => ({
        type: 'ambassadorRole' as const,
        id: ambassador.id,
        focusArea: ambassador.focusArea,
        grantedAt: ambassador.grantedAt.toISOString(),
        revokedAt: isoOrNull(ambassador.revokedAt),
      })),
      ...(lastActive
        ? [
            {
              type: 'lastActive' as const,
              lastActiveMonth: lastActive.lastActiveMonth,
              isHidden: lastActive.isHidden,
            },
          ]
        : []),
    ];
  }
}

/**
 * `profile` -> `handles`: the member's current @handle and the handles they
 * released, with when each one can be claimed again.
 */
@Injectable()
export class HandlesExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'handles';

  constructor(
    @InjectRepository(Handle)
    private readonly handles: Repository<Handle>,
    @InjectRepository(HandleHistory)
    private readonly handleHistory: Repository<HandleHistory>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [current, released] = await Promise.all([
      this.handles.find({ where: { userId }, order: { createdAt: 'ASC' } }),
      this.handleHistory.find({
        where: { previousOwnerUserId: userId },
        order: { releasedAt: 'ASC' },
      }),
    ]);
    return [
      ...current.map((handle) => ({
        type: 'current' as const,
        name: handle.name,
        createdAt: handle.createdAt.toISOString(),
      })),
      ...released.map((handle) => ({
        type: 'released' as const,
        name: handle.name,
        releasedAt: handle.releasedAt.toISOString(),
        reclaimableAt: handle.reclaimableAt.toISOString(),
        isForwarding: handle.isForwarding,
      })),
    ];
  }
}

/**
 * `profile` -> `board`: the asks and offers the member pinned to their
 * profile board, and the responses they left on other members' boards. A
 * response somebody else left on this member's board stays in that person's
 * archive.
 */
@Injectable()
export class BoardExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'board';

  constructor(
    @InjectRepository(BoardPost)
    private readonly boardPosts: Repository<BoardPost>,
    @InjectRepository(BoardPostResponse)
    private readonly boardResponses: Repository<BoardPostResponse>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [posts, responses] = await Promise.all([
      this.boardPosts.find({ where: { userId }, order: { createdAt: 'ASC' } }),
      this.boardResponses.find({
        where: { responderId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...posts.map((post) => ({
        type: 'post' as const,
        id: post.id,
        boardKind: post.kind,
        title: post.title,
        slug: post.slug,
        status: post.status,
        tags: post.tags,
        closedNote: post.closedNote,
        closedAt: isoOrNull(post.closedAt),
        expiresAt: post.expiresAt.toISOString(),
        renewedAt: isoOrNull(post.renewedAt),
        renewCount: post.renewCount,
        createdAt: post.createdAt.toISOString(),
      })),
      ...responses.map((response) => ({
        type: 'response' as const,
        id: response.id,
        postId: response.postId,
        responseKind: response.kind,
        note: response.note,
        createdAt: response.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `profile` -> `verification`: the member's verification levels, the
 * verification requests they filed, and each change to their level. A
 * request travels with the fields `toVerificationRequestDTO` already shows
 * the member, the reviewer's decision reason included. A level change
 * (`verification_events`) travels as what changed and when, with the type of
 * the request behind it; its reason, its signals and the acting staff member
 * stay out, as do the evidence reference and the provider reference.
 */
@Injectable()
export class VerificationExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'verification';

  constructor(
    @InjectRepository(MemberVerification)
    private readonly memberVerifications: Repository<MemberVerification>,
    @InjectRepository(VerificationRequest)
    private readonly verificationRequests: Repository<VerificationRequest>,
    @InjectRepository(VerificationEvent)
    private readonly verificationEvents: Repository<VerificationEvent>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [levels, requests, events] = await Promise.all([
      this.memberVerifications.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.verificationRequests.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.verificationEvents.find({
        select: {
          id: true,
          requestId: true,
          action: true,
          fromLevel: true,
          toLevel: true,
          createdAt: true,
        },
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const requestTypeById = new Map(
      requests.map((request) => [request.id, request.type]),
    );
    return [
      ...levels.map((verification) => ({
        type: 'level' as const,
        id: verification.id,
        verificationType: verification.type,
        level: verification.level,
        method: verification.method,
        provider: verification.provider,
        grantedBy: verification.grantedBy,
        verifiedAt: isoOrNull(verification.verifiedAt),
        createdAt: verification.createdAt.toISOString(),
        updatedAt: verification.updatedAt.toISOString(),
      })),
      ...requests.map((request) => ({
        type: 'request' as const,
        id: request.id,
        verificationType: request.type,
        requestedLevel: request.requestedLevel,
        status: request.status,
        context: request.context,
        decisionReason: request.decisionReason,
        isAppeal: request.isAppeal,
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
      })),
      ...events.map((event) => ({
        type: 'levelChange' as const,
        id: event.id,
        action: event.action,
        fromLevel: event.fromLevel,
        level: event.toLevel,
        verificationType: event.requestId
          ? (requestTypeById.get(event.requestId) ?? null)
          : null,
        createdAt: event.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `profile` -> `joinApplication`: the application the member sent before they
 * had an account, found through the invite its approval minted and the member
 * redeemed. Their name, email, city and message, where they heard about the
 * platform, the Terms revision and age attestation they gave, and how it was
 * decided. The mutual member's email is another person's data, and the status
 * token hash, the reviewer, and the decline and approval keys stay out. Null
 * when the member joined without an application.
 */
@Injectable()
export class JoinApplicationExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'joinApplication';

  constructor(
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const application = await this.joinRequests
      .createQueryBuilder('joinRequest')
      .innerJoin(Invite, 'invite', 'joinRequest.inviteId = invite.id')
      .where('invite.acceptedBy = :userId', { userId })
      .orderBy('joinRequest.createdAt', 'DESC')
      .getOne();
    if (!application) return null;
    return {
      id: application.id,
      name: application.name,
      email: application.email,
      city: application.city,
      message: application.message,
      heardFrom: application.heardFrom,
      termsVersion: application.termsVersion,
      ageAttestedAt: application.ageAttestedAt.toISOString(),
      status: application.status,
      createdAt: application.createdAt.toISOString(),
      reviewedAt: isoOrNull(application.reviewedAt),
    };
  }
}

/**
 * `profile` -> `staffRoles`: the staff roles the member holds and when each
 * was granted. The person who granted a role stays out.
 */
@Injectable()
export class StaffRolesExportContributor implements DataExportContribution {
  readonly category = 'profile';
  readonly archiveKey = 'staffRoles';

  constructor(
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.staffRoles.find({
      select: { id: true, role: true, grantedAt: true },
      where: { userId },
      order: { grantedAt: 'ASC' },
    });
    return rows.map((staffRole) => ({
      id: staffRole.id,
      role: staffRole.role,
      grantedAt: staffRole.grantedAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `messages`
// ---------------------------------------------------------------------------

/**
 * `messages` -> `messageActivity`: the member's reactions and stars, the
 * messages they hid for themselves, the group chat invites they sent and
 * received (the other person by id), and, for a business mailbox they answer
 * from, whether they allow their name on the replies they send.
 */
@Injectable()
export class MessageActivityExportContributor implements DataExportContribution {
  readonly category = 'messages';
  readonly archiveKey = 'messageActivity';

  constructor(
    @InjectRepository(MessageReaction)
    private readonly messageReactions: Repository<MessageReaction>,
    @InjectRepository(MessageStar)
    private readonly messageStars: Repository<MessageStar>,
    @InjectRepository(MessageHide)
    private readonly messageHides: Repository<MessageHide>,
    @InjectRepository(GroupInvite)
    private readonly groupInvites: Repository<GroupInvite>,
    @InjectRepository(IdentityStaffPreference)
    private readonly staffPreferences: Repository<IdentityStaffPreference>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [reactions, stars, hides, invites, namingPreferences] =
      await Promise.all([
        // `message_reactions` has no timestamp, so its rows keep table order.
        this.messageReactions.find({ where: { userId } }),
        this.messageStars.find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.messageHides.find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.groupInvites.find({
          where: [{ inviterId: userId }, { inviteeId: userId }],
          order: { createdAt: 'ASC' },
        }),
        this.staffPreferences.find({ where: { userId } }),
      ]);
    return [
      ...reactions.map((reaction) => ({
        type: 'reaction' as const,
        messageId: reaction.messageId,
        key: reaction.key,
      })),
      ...stars.map((star) => ({
        type: 'star' as const,
        messageId: star.messageId,
        createdAt: star.createdAt.toISOString(),
      })),
      ...hides.map((hide) => ({
        type: 'hiddenForMe' as const,
        messageId: hide.messageId,
        createdAt: hide.createdAt.toISOString(),
      })),
      ...invites.map((invite) => {
        const isSent = invite.inviterId === userId;
        return {
          type: 'groupInvite' as const,
          direction: isSent ? ('sent' as const) : ('received' as const),
          conversationId: invite.conversationId,
          counterpartyId: isSent ? invite.inviteeId : invite.inviterId,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
          respondedAt: isoOrNull(invite.respondedAt),
        };
      }),
      ...namingPreferences.map((preference) => ({
        type: 'mailboxNaming' as const,
        identityId: preference.identityId,
        shouldAllowNaming: preference.shouldAllowNaming,
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `forumPosts`
// ---------------------------------------------------------------------------

/**
 * `forumPosts` -> `forumActivity`: the member's votes on replies and polls,
 * the threads they follow, the earlier versions of their own posts, the
 * threads they co-wrote, and the polls they attached to their own threads
 * (with each option's text and tally).
 *
 * An edit row travels only when the member edited their own post, so a
 * moderator's export never carries the earlier words of somebody else's post.
 * Edits and polls are read through a join on the post or thread author, so
 * no query carries an unbounded list of ids.
 */
@Injectable()
export class ForumActivityExportContributor implements DataExportContribution {
  readonly category = 'forumPosts';
  readonly archiveKey = 'forumActivity';

  constructor(
    @InjectRepository(ForumPostVote)
    private readonly postVotes: Repository<ForumPostVote>,
    @InjectRepository(ForumPollVote)
    private readonly pollVotes: Repository<ForumPollVote>,
    @InjectRepository(ForumThreadSubscription)
    private readonly subscriptions: Repository<ForumThreadSubscription>,
    @InjectRepository(ForumPostEdit)
    private readonly postEdits: Repository<ForumPostEdit>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
    @InjectRepository(ForumPoll)
    private readonly forumPolls: Repository<ForumPoll>,
    @InjectRepository(ForumPollOption)
    private readonly pollOptions: Repository<ForumPollOption>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [
      postVotes,
      pollVotes,
      subscriptions,
      edits,
      coAuthored,
      polls,
      options,
    ] = await Promise.all([
      this.postVotes.find({ where: { userId }, order: { createdAt: 'ASC' } }),
      this.pollVotes.find({ where: { userId }, order: { createdAt: 'ASC' } }),
      this.subscriptions.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.postEdits
        .createQueryBuilder('edit')
        .innerJoin(ForumPost, 'post', 'edit.postId = post.id')
        .where('edit.editorId = :userId', { userId })
        .andWhere('post.authorId = :userId', { userId })
        .orderBy('edit.createdAt', 'ASC')
        .getMany(),
      this.forumThreads.find({
        where: { coAuthorId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.forumPolls
        .createQueryBuilder('poll')
        .innerJoin(ForumThread, 'thread', 'poll.threadId = thread.id')
        .where('thread.authorId = :userId', { userId })
        .orderBy('poll.createdAt', 'ASC')
        .getMany(),
      this.pollOptions
        .createQueryBuilder('pollOption')
        .innerJoin(ForumPoll, 'poll', 'pollOption.pollId = poll.id')
        .innerJoin(ForumThread, 'thread', 'poll.threadId = thread.id')
        .where('thread.authorId = :userId', { userId })
        .orderBy('pollOption.position', 'ASC')
        .getMany(),
    ]);
    return [
      ...postVotes.map((vote) => ({
        type: 'postVote' as const,
        postId: vote.postId,
        value: vote.value,
        createdAt: vote.createdAt.toISOString(),
      })),
      ...pollVotes.map((vote) => ({
        type: 'pollVote' as const,
        pollId: vote.pollId,
        optionId: vote.optionId,
        createdAt: vote.createdAt.toISOString(),
      })),
      ...subscriptions.map((subscription) => ({
        type: 'subscription' as const,
        threadId: subscription.threadId,
        isFollowing: subscription.isFollowing,
        lastReadAt: isoOrNull(subscription.lastReadAt),
        createdAt: subscription.createdAt.toISOString(),
      })),
      ...edits.map((edit) => ({
        type: 'edit' as const,
        id: edit.id,
        postId: edit.postId,
        previousTitle: edit.previousTitle,
        previousBody: edit.previousBody,
        editedAt: edit.createdAt.toISOString(),
      })),
      ...coAuthored.map((thread) => ({
        type: 'coAuthoredThread' as const,
        id: thread.id,
        slug: thread.slug,
        title: thread.title,
        forumCategory: thread.category,
        createdAt: thread.createdAt.toISOString(),
      })),
      ...polls.map((poll) => ({
        type: 'poll' as const,
        id: poll.id,
        threadId: poll.threadId,
        allowMultiple: poll.allowMultiple,
        closesAt: isoOrNull(poll.closesAt),
        options: options
          .filter((option) => option.pollId === poll.id)
          .map((option) => ({
            label: option.label,
            position: option.position,
            voteCount: option.voteCount,
          })),
        createdAt: poll.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `communities`
// ---------------------------------------------------------------------------

/**
 * `communities` -> `communityMemberships`: every community the member
 * belongs to, with their role, their notification level, the rules revision
 * they accepted and when they joined. The roster itself is the community's
 * data and stays out; this is the member's own row on it.
 */
@Injectable()
export class CommunityMembershipsExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityMemberships';

  constructor(
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.communityMembers.find({
      where: { userId },
      order: { joinedAt: 'ASC' },
    });
    return rows.map((membership) => ({
      id: membership.id,
      communityId: membership.communityId,
      role: membership.role,
      notificationLevel: membership.notificationLevel,
      rulesAcceptedAt: isoOrNull(membership.rulesAcceptedAt),
      rulesVersionAccepted: membership.rulesVersionAccepted,
      welcomeSeenAt: isoOrNull(membership.welcomeSeenAt),
      joinedAt: membership.joinedAt.toISOString(),
    }));
  }
}

/**
 * `communities` -> `communityActivity`: the member's reactions to community
 * posts, the community invites they sent and received (the other person by
 * id), the resources they added to a community, and the earlier versions of
 * their own posts and replies. As with `forumActivity`, an edit row travels
 * only when the member edited their own words, read through a join on the
 * post or reply author.
 */
@Injectable()
export class CommunityActivityExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityActivity';

  constructor(
    @InjectRepository(CommunityPostReaction)
    private readonly postReactions: Repository<CommunityPostReaction>,
    @InjectRepository(CommunityInvite)
    private readonly communityInvites: Repository<CommunityInvite>,
    @InjectRepository(CommunityResource)
    private readonly communityResources: Repository<CommunityResource>,
    @InjectRepository(CommunityPostEdit)
    private readonly postEdits: Repository<CommunityPostEdit>,
    @InjectRepository(CommunityPostReplyEdit)
    private readonly replyEdits: Repository<CommunityPostReplyEdit>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [reactions, invites, resources, postEdits, replyEdits] =
      await Promise.all([
        this.postReactions.find({
          where: { userId },
          order: { createdAt: 'ASC' },
        }),
        this.communityInvites.find({
          where: [{ invitedByUserId: userId }, { invitedUserId: userId }],
          order: { createdAt: 'ASC' },
        }),
        this.communityResources.find({
          where: { createdByUserId: userId },
          order: { createdAt: 'ASC' },
        }),
        this.postEdits
          .createQueryBuilder('edit')
          .innerJoin(CommunityPost, 'post', 'edit.postId = post.id')
          .where('edit.editorId = :userId', { userId })
          .andWhere('post.authorId = :userId', { userId })
          .orderBy('edit.createdAt', 'ASC')
          .getMany(),
        this.replyEdits
          .createQueryBuilder('edit')
          .innerJoin(CommunityPostReply, 'reply', 'edit.replyId = reply.id')
          .where('edit.editorId = :userId', { userId })
          .andWhere('reply.authorId = :userId', { userId })
          .orderBy('edit.createdAt', 'ASC')
          .getMany(),
      ]);
    return [
      ...reactions.map((reaction) => ({
        type: 'reaction' as const,
        postId: reaction.postId,
        key: reaction.key,
        createdAt: reaction.createdAt.toISOString(),
      })),
      ...invites.map((invite) => {
        const isSent = invite.invitedByUserId === userId;
        return {
          type: 'invite' as const,
          direction: isSent ? ('sent' as const) : ('received' as const),
          communityId: invite.communityId,
          counterpartyId: isSent
            ? invite.invitedUserId
            : invite.invitedByUserId,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
          respondedAt: isoOrNull(invite.respondedAt),
          expiresAt: invite.expiresAt.toISOString(),
        };
      }),
      ...resources.map((resource) => ({
        type: 'resource' as const,
        id: resource.id,
        communityId: resource.communityId,
        title: resource.title,
        url: resource.url,
        note: resource.note,
        resourceKind: resource.kind,
        createdAt: resource.createdAt.toISOString(),
        updatedAt: resource.updatedAt.toISOString(),
      })),
      ...postEdits.map((edit) => ({
        type: 'postEdit' as const,
        id: edit.id,
        postId: edit.postId,
        previousBody: edit.previousBody,
        editedAt: edit.createdAt.toISOString(),
      })),
      ...replyEdits.map((edit) => ({
        type: 'replyEdit' as const,
        id: edit.id,
        replyId: edit.replyId,
        previousText: edit.previousText,
        editedAt: edit.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `communities` -> `communityRequests`: what the member asked of a community
 * or of the platform team. Requests to join (with the reviewer's decline
 * reason, which exists to reach the applicant; the moderators' internal note
 * stays out), requests to switch spaces on, new tag requests, flags that an
 * owner has gone quiet, and reading group proposals.
 */
@Injectable()
export class CommunityRequestsExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'communityRequests';

  constructor(
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    @InjectRepository(CommunitySpaceRequest)
    private readonly spaceRequests: Repository<CommunitySpaceRequest>,
    @InjectRepository(CommunityTagRequest)
    private readonly tagRequests: Repository<CommunityTagRequest>,
    @InjectRepository(CommunityOwnerReviewRequest)
    private readonly ownerReviewRequests: Repository<CommunityOwnerReviewRequest>,
    @InjectRepository(ReadingGroupProposal)
    private readonly readingGroupProposals: Repository<ReadingGroupProposal>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [joins, spaces, tags, ownerReviews, readingGroups] =
      await Promise.all([
        this.joinRequests.find({ where: { userId }, ...byCreatedAt }),
        this.spaceRequests.find({
          where: { requestedByUserId: userId },
          ...byCreatedAt,
        }),
        this.tagRequests.find({
          where: { requestedByUserId: userId },
          ...byCreatedAt,
        }),
        this.ownerReviewRequests.find({
          where: { requestedByUserId: userId },
          ...byCreatedAt,
        }),
        this.readingGroupProposals.find({
          where: { memberId: userId },
          ...byCreatedAt,
        }),
      ]);
    return [
      ...joins.map((request) => ({
        type: 'joinRequest' as const,
        id: request.id,
        communityId: request.communityId,
        note: request.note,
        involvement: request.involvement,
        status: request.status,
        declineKind: request.declineKind,
        declineReason: request.declineReason,
        reapplyAfter: isoOrNull(request.reapplyAfter),
        createdAt: request.createdAt.toISOString(),
      })),
      ...spaces.map((request) => ({
        type: 'spaceRequest' as const,
        id: request.id,
        communityId: request.communityId,
        note: request.note,
        status: request.status,
        declineReason: request.declineReason,
        createdAt: request.createdAt.toISOString(),
        decidedAt: isoOrNull(request.decidedAt),
      })),
      ...tags.map((request) => ({
        type: 'tagRequest' as const,
        id: request.id,
        communityId: request.communityId,
        label: request.label,
        note: request.note,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        resolvedAt: isoOrNull(request.resolvedAt),
      })),
      ...ownerReviews.map((request) => ({
        type: 'ownerReviewRequest' as const,
        id: request.id,
        communityId: request.communityId,
        reason: request.reason,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        resolvedAt: isoOrNull(request.resolvedAt),
      })),
      ...readingGroups.map((proposal) => ({
        type: 'readingGroupProposal' as const,
        id: proposal.id,
        clubName: proposal.clubName,
        book: proposal.book,
        why: proposal.why,
        format: proposal.format,
        maxPeople: proposal.maxPeople,
        status: proposal.status,
        createdCommunitySlug: proposal.createdCommunitySlug,
        createdAt: proposal.createdAt.toISOString(),
        decidedAt: isoOrNull(proposal.decidedAt),
      })),
    ];
  }
}

/**
 * `communities` -> `feedPreferences`: the communities and threads the member
 * turned down in their feed, and the topics they follow.
 */
@Injectable()
export class FeedPreferencesExportContributor implements DataExportContribution {
  readonly category = 'communities';
  readonly archiveKey = 'feedPreferences';

  constructor(
    @InjectRepository(FeedSourceMute)
    private readonly feedSourceMutes: Repository<FeedSourceMute>,
    @InjectRepository(TopicFollow)
    private readonly topicFollows: Repository<TopicFollow>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [mutes, follows] = await Promise.all([
      this.feedSourceMutes.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.topicFollows.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...mutes.map((mute) => ({
        type: 'mute' as const,
        id: mute.id,
        sourceKind: mute.sourceKind,
        sourceId: mute.sourceId,
        createdAt: mute.createdAt.toISOString(),
      })),
      ...follows.map((follow) => ({
        type: 'topicFollow' as const,
        id: follow.id,
        topicSlug: follow.topicSlug,
        createdAt: follow.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `events`
// ---------------------------------------------------------------------------

/**
 * `events` -> `eventPreferences`: the member's event settings (reminder lead
 * time, the default visibility of events they create, event emails), as one
 * object. Null when the member never changed one.
 */
@Injectable()
export class EventPreferencesExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'eventPreferences';

  constructor(
    @InjectRepository(MemberEventReminderPreferences)
    private readonly eventPreferences: Repository<MemberEventReminderPreferences>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const preferences = await this.eventPreferences.findOne({
      where: { userId },
    });
    if (!preferences) return null;
    return {
      leadMinutes: preferences.leadMinutes,
      defaultEventVisibility: preferences.defaultEventVisibility,
      eventEmailsEnabled: preferences.eventEmailsEnabled,
      createdAt: preferences.createdAt.toISOString(),
      updatedAt: preferences.updatedAt.toISOString(),
    };
  }
}

/**
 * `events` -> `eventParticipation`: everything the member did around events
 * beyond the RSVP status the `events` key records.
 *
 *  - `rsvpDetails`   what they told the host with each RSVP: guests, access
 *                    and dietary needs, pronouns and their custom answer.
 *  - `bookmark`, `cohost`, `lineup`   events they bookmarked, co-host, or
 *                    appear on the lineup of.
 *  - `invite`, `cohostInvite`   invites they sent and received, the other
 *                    person by id. A received co-host invite leaves out the
 *                    inviter's message, which stays in the inviter's archive.
 *  - `announcement`, `photo`, `series`   announcements they sent as a host,
 *                    captions of photos they uploaded, and the recurring
 *                    series they run.
 */
@Injectable()
export class EventParticipationExportContributor implements DataExportContribution {
  readonly category = 'events';
  readonly archiveKey = 'eventParticipation';

  constructor(
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(EventBookmark)
    private readonly bookmarks: Repository<EventBookmark>,
    @InjectRepository(EventCohost)
    private readonly cohosts: Repository<EventCohost>,
    @InjectRepository(EventLineupEntry)
    private readonly lineupEntries: Repository<EventLineupEntry>,
    @InjectRepository(EventInvite)
    private readonly eventInvites: Repository<EventInvite>,
    @InjectRepository(EventCohostInvite)
    private readonly cohostInvites: Repository<EventCohostInvite>,
    @InjectRepository(EventAnnouncement)
    private readonly announcements: Repository<EventAnnouncement>,
    @InjectRepository(EventPhoto)
    private readonly photos: Repository<EventPhoto>,
    @InjectRepository(EventSeries)
    private readonly series: Repository<EventSeries>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [
      rsvps,
      bookmarks,
      cohosts,
      lineup,
      invites,
      cohostInvites,
      announcements,
      photos,
      series,
    ] = await Promise.all([
      this.rsvps.find({ where: { userId }, ...byCreatedAt }),
      this.bookmarks.find({ where: { userId }, ...byCreatedAt }),
      this.cohosts.find({ where: { userId }, ...byCreatedAt }),
      this.lineupEntries.find({ where: { userId }, ...byCreatedAt }),
      this.eventInvites.find({
        where: [{ inviterId: userId }, { inviteeId: userId }],
        ...byCreatedAt,
      }),
      this.cohostInvites.find({
        where: [{ inviterId: userId }, { inviteeId: userId }],
        ...byCreatedAt,
      }),
      this.announcements.find({ where: { authorId: userId }, ...byCreatedAt }),
      this.photos.find({ where: { uploaderId: userId }, ...byCreatedAt }),
      this.series.find({ where: { hostId: userId }, ...byCreatedAt }),
    ]);
    return [
      ...rsvps.map((rsvp) => ({
        type: 'rsvpDetails' as const,
        eventId: rsvp.eventId,
        guestCount: rsvp.guestCount,
        accessNeeds: rsvp.accessNeeds,
        dietaryNeeds: rsvp.dietaryNeeds,
        pronouns: rsvp.pronouns,
        customAnswer: rsvp.customAnswer,
        detailsVisibility: rsvp.visibility,
        checkedInAt: isoOrNull(rsvp.checkedInAt),
        removedByHostAt: isoOrNull(rsvp.removedByHostAt),
        updatedAt: rsvp.updatedAt.toISOString(),
      })),
      ...bookmarks.map((bookmark) => ({
        type: 'bookmark' as const,
        eventId: bookmark.eventId,
        createdAt: bookmark.createdAt.toISOString(),
      })),
      ...cohosts.map((cohost) => ({
        type: 'cohost' as const,
        eventId: cohost.eventId,
        createdAt: cohost.createdAt.toISOString(),
      })),
      ...lineup.map((entry) => ({
        type: 'lineup' as const,
        eventId: entry.eventId,
        role: entry.role,
        createdAt: entry.createdAt.toISOString(),
      })),
      ...invites.map((invite) => {
        const isSent = invite.inviterId === userId;
        return {
          type: 'invite' as const,
          direction: isSent ? ('sent' as const) : ('received' as const),
          eventId: invite.eventId,
          counterpartyId: isSent ? invite.inviteeId : invite.inviterId,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
        };
      }),
      ...cohostInvites.map((invite) => {
        const isSent = invite.inviterId === userId;
        return {
          type: 'cohostInvite' as const,
          direction: isSent ? ('sent' as const) : ('received' as const),
          eventId: invite.eventId,
          counterpartyId: isSent ? invite.inviteeId : invite.inviterId,
          role: invite.role,
          commitment: invite.commitment,
          message: isSent ? invite.message : null,
          replyByDate: isoOrNull(invite.replyByDate),
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
        };
      }),
      ...announcements.map((announcement) => ({
        type: 'announcement' as const,
        id: announcement.id,
        eventId: announcement.eventId,
        body: announcement.body,
        recipientCount: announcement.recipientCount,
        createdAt: announcement.createdAt.toISOString(),
      })),
      ...photos.map((photo) => ({
        type: 'photo' as const,
        id: photo.id,
        eventId: photo.eventId,
        storageKey: photo.storageKey,
        caption: photo.caption,
        createdAt: photo.createdAt.toISOString(),
      })),
      ...series.map((eventSeries) => ({
        type: 'series' as const,
        id: eventSeries.id,
        cadence: eventSeries.cadence,
        endType: eventSeries.endType,
        endCount: eventSeries.endCount,
        endUntil: isoOrNull(eventSeries.endUntil),
        occurrenceCount: eventSeries.occurrenceCount,
        createdAt: eventSeries.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `connections`
// ---------------------------------------------------------------------------

/**
 * `connections` -> `connectionNotes`: the private notes the member keeps on
 * their connections.
 */
@Injectable()
export class ConnectionNotesExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'connectionNotes';

  constructor(
    @InjectRepository(ConnectionNote)
    private readonly connectionNotes: Repository<ConnectionNote>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.connectionNotes.find({
      where: { authorId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((note) => ({
      id: note.id,
      connectionId: note.connectionId,
      body: note.body,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
    }));
  }
}

/**
 * `connections` -> `suggestionDismissals`: the members the member asked to
 * stop being suggested to them.
 */
@Injectable()
export class SuggestionDismissalsExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'suggestionDismissals';

  constructor(
    @InjectRepository(MemberSuggestionDismissal)
    private readonly dismissals: Repository<MemberSuggestionDismissal>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.dismissals.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((dismissal) => ({
      id: dismissal.id,
      dismissedUserId: dismissal.dismissedUserId,
      createdAt: dismissal.createdAt.toISOString(),
    }));
  }
}

/**
 * `connections` -> `invitesSent`: the platform invites the member sent, with
 * their note and vouch. The invite code is a credential and the invitee's
 * email is the invitee's own data, so both stay out; a used invite names the
 * member who joined by id.
 */
@Injectable()
export class InvitesSentExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'invitesSent';

  constructor(
    @InjectRepository(Invite)
    private readonly invites: Repository<Invite>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.invites.find({
      where: { inviterId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((invite) => ({
      id: invite.id,
      note: invite.note,
      vouch: invite.vouch,
      personal: invite.personal,
      status: invite.status,
      acceptedByUserId: invite.acceptedBy,
      usedAt: isoOrNull(invite.usedAt),
      expiresAt: isoOrNull(invite.expiresAt),
      createdAt: invite.createdAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `activityLog`
// ---------------------------------------------------------------------------

/**
 * `activityLog` -> `accountRequests`: the times the member deactivated their
 * account, the deletion requests they made, and the data-rights requests they
 * filed (scope, their own words, deadline and when it was answered). The
 * operator's outcome note and identity stay out.
 */
@Injectable()
export class AccountRequestsExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'accountRequests';

  constructor(
    @InjectRepository(AccountDeactivation)
    private readonly deactivations: Repository<AccountDeactivation>,
    @InjectRepository(DeletionRequest)
    private readonly deletionRequests: Repository<DeletionRequest>,
    @InjectRepository(DsarRequest)
    private readonly dsarRequests: Repository<DsarRequest>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [deactivations, deletions, dataRequests] = await Promise.all([
      this.deactivations.find({
        where: { userId },
        order: { deactivatedAt: 'ASC' },
      }),
      this.deletionRequests.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.dsarRequests.find({
        where: { userId },
        order: { submittedAt: 'ASC' },
      }),
    ]);
    return [
      ...deactivations.map((deactivation) => ({
        type: 'deactivation' as const,
        id: deactivation.id,
        deactivatedAt: deactivation.deactivatedAt.toISOString(),
        reactivatedAt: isoOrNull(deactivation.reactivatedAt),
      })),
      ...deletions.map((request) => ({
        type: 'deletionRequest' as const,
        id: request.id,
        status: request.status,
        reason: request.reason,
        scheduledFor: request.scheduledFor.toISOString(),
        processedAt: isoOrNull(request.processedAt),
        createdAt: request.createdAt.toISOString(),
      })),
      ...dataRequests.map((request) => ({
        type: 'dataRequest' as const,
        id: request.id,
        reference: request.reference,
        article: request.article,
        scopes: request.scopes,
        details: request.details,
        context: request.context,
        status: request.status,
        submittedAt: request.submittedAt.toISOString(),
        dueBy: request.dueBy.toISOString(),
        respondedAt: isoOrNull(request.respondedAt),
      })),
    ];
  }
}

/**
 * `activityLog` -> `recognition`: the badges the member earned (with whether
 * they hid each from their profile), the perks they claimed, and every entry
 * in their XP ledger.
 */
@Injectable()
export class RecognitionExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'recognition';

  constructor(
    @InjectRepository(RecognitionAward)
    private readonly awards: Repository<RecognitionAward>,
    @InjectRepository(RecognitionPerkClaim)
    private readonly perkClaims: Repository<RecognitionPerkClaim>,
    @InjectRepository(RecognitionLedgerEntry)
    private readonly ledgerEntries: Repository<RecognitionLedgerEntry>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [awards, perkClaims, ledgerEntries] = await Promise.all([
      this.awards.find({ where: { userId }, order: { awardedAt: 'ASC' } }),
      this.perkClaims.find({ where: { userId }, order: { claimedAt: 'ASC' } }),
      this.ledgerEntries.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...awards.map((award) => ({
        type: 'award' as const,
        id: award.id,
        badgeKey: award.badgeKey,
        context: award.context,
        hiddenFromProfile: award.hiddenFromProfile,
        awardedAt: award.awardedAt.toISOString(),
      })),
      ...perkClaims.map((claim) => ({
        type: 'perkClaim' as const,
        id: claim.id,
        perkKey: claim.perkKey,
        claimedAt: claim.claimedAt.toISOString(),
      })),
      ...ledgerEntries.map((entry) => ({
        type: 'ledgerEntry' as const,
        id: entry.id,
        description: entry.description,
        xp: entry.xp,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `activityLog` -> `watchHistory`: how far the member got into each cinema
 * title, and when a watch counted as a view.
 */
@Injectable()
export class WatchHistoryExportContributor implements DataExportContribution {
  readonly category = 'activityLog';
  readonly archiveKey = 'watchHistory';

  constructor(
    @InjectRepository(WatchProgress)
    private readonly watchProgress: Repository<WatchProgress>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    // The table keeps one row per title and no creation time, so the rows
    // are ordered by when the member last watched.
    const rows = await this.watchProgress.find({
      where: { userId },
      order: { updatedAt: 'ASC' },
    });
    return rows.map((progress) => ({
      id: progress.id,
      titleId: progress.titleId,
      positionSeconds: progress.positionSeconds,
      viewCountedAt: isoOrNull(progress.viewCountedAt),
      updatedAt: progress.updatedAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `saved`
// ---------------------------------------------------------------------------

/**
 * `saved` -> `savedLists`: the lists the member sorted their saved items
 * into, each with the saved item ids it holds (they match `saved`). A shared
 * list says it is shared; its share token is a credential and stays out.
 */
@Injectable()
export class SavedListsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'savedLists';

  constructor(
    @InjectRepository(SavedList)
    private readonly savedLists: Repository<SavedList>,
    @InjectRepository(SavedListEntry)
    private readonly savedListEntries: Repository<SavedListEntry>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const lists = await this.savedLists.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    const listIds = lists.map((list) => list.id);
    const entries = listIds.length
      ? await this.savedListEntries.find({
          where: { listId: In(listIds) },
          order: { createdAt: 'ASC' },
        })
      : [];
    const savedItemIdsByList = new Map<string, string[]>();
    for (const entry of entries) {
      const savedItemIds = savedItemIdsByList.get(entry.listId) ?? [];
      savedItemIds.push(entry.savedItemId);
      savedItemIdsByList.set(entry.listId, savedItemIds);
    }
    return lists.map((list) => ({
      id: list.id,
      name: list.name,
      isDefault: list.isDefault,
      isShared: list.shareToken !== null,
      sharedAt: isoOrNull(list.sharedAt),
      savedItemIds: savedItemIdsByList.get(list.id) ?? [],
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
    }));
  }
}

/**
 * `saved` -> `collections`: the collections the member made, each with the
 * things they put in it.
 */
@Injectable()
export class CollectionsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'collections';

  constructor(
    @InjectRepository(Collection)
    private readonly collections: Repository<Collection>,
    @InjectRepository(CollectionItem)
    private readonly collectionItems: Repository<CollectionItem>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const collections = await this.collections.find({
      where: { ownerId: userId },
      order: { createdAt: 'ASC' },
    });
    const collectionIds = collections.map((collection) => collection.id);
    const items = collectionIds.length
      ? await this.collectionItems.find({
          where: { collectionId: In(collectionIds) },
          order: { createdAt: 'ASC' },
        })
      : [];
    return collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      emoji: collection.emoji,
      cover: collection.cover,
      items: items
        .filter((item) => item.collectionId === collection.id)
        .map((item) => ({
          subjectKind: item.subjectKind,
          subjectId: item.subjectId,
          addedAt: item.createdAt.toISOString(),
        })),
      createdAt: collection.createdAt.toISOString(),
      updatedAt: collection.updatedAt.toISOString(),
    }));
  }
}

/**
 * `saved` -> `drafts`: the member's unfinished writing (applications,
 * pitches, posts, replies), each with the content saved so far.
 */
@Injectable()
export class DraftsExportContributor implements DataExportContribution {
  readonly category = 'saved';
  readonly archiveKey = 'drafts';

  constructor(
    @InjectRepository(Draft)
    private readonly drafts: Repository<Draft>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.drafts.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((draft) => ({
      id: draft.id,
      kind: draft.kind,
      payload: draft.payload,
      meta: draft.meta,
      version: draft.version,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `housing`
// ---------------------------------------------------------------------------

/**
 * `housing` -> `groupListings`: the listings the member posted to a housing
 * group, with where each stands. The risk score, its reasons, the hide flag
 * and the reviewer's decision are the moderators' working record and stay
 * out.
 */
@Injectable()
export class GroupListingsExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'groupListings';

  constructor(
    @InjectRepository(GroupListing)
    private readonly groupListings: Repository<GroupListing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.groupListings.find({
      where: { postedByUserId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((listing) => ({
      id: listing.id,
      groupId: listing.groupId,
      title: listing.title,
      description: listing.description,
      neighbourhood: listing.neighbourhood,
      priceEuros: listing.priceEuros,
      accessibilityInfo: listing.accessibilityInfo,
      status: listing.status,
      decidedAt: isoOrNull(listing.decidedAt),
      createdAt: listing.createdAt.toISOString(),
      updatedAt: listing.updatedAt.toISOString(),
    }));
  }
}

/**
 * `housing` -> `landlords`: the introductions to a landlord the member asked
 * for (with the name, note and contact email they gave, and the reason staff
 * sent them with the decision) and the landlords they submitted to the
 * directory.
 */
@Injectable()
export class LandlordsExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'landlords';

  constructor(
    @InjectRepository(LandlordIntroRequest)
    private readonly introRequests: Repository<LandlordIntroRequest>,
    @InjectRepository(Landlord)
    private readonly landlords: Repository<Landlord>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [introRequests, submitted] = await Promise.all([
      this.introRequests.find({
        where: { userId },
        order: { createdAt: 'ASC' },
      }),
      this.landlords.find({
        where: { submittedByUserId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...introRequests.map((request) => ({
        type: 'introRequest' as const,
        id: request.id,
        landlordId: request.landlordId,
        name: request.name,
        note: request.note,
        contactEmail: request.contactEmail,
        status: request.status,
        decisionReason: request.decisionReason,
        createdAt: request.createdAt.toISOString(),
        decidedAt: isoOrNull(request.decidedAt),
      })),
      ...submitted.map((landlord) => ({
        type: 'submission' as const,
        id: landlord.id,
        slug: landlord.slug,
        status: landlord.status,
        createdAt: landlord.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `reviews`
// ---------------------------------------------------------------------------

/**
 * `reviews` -> `landlordRecommendations`: the landlord recommendations the
 * member wrote. The landlord's published reply travels with each one, as a
 * listing owner's reply does in `reviews`: it answers this member and is
 * already public.
 */
@Injectable()
export class LandlordRecommendationsExportContributor implements DataExportContribution {
  readonly category = 'reviews';
  readonly archiveKey = 'landlordRecommendations';

  constructor(
    @InjectRepository(LandlordRecommendation)
    private readonly recommendations: Repository<LandlordRecommendation>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.recommendations.find({
      where: { authorUserId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((recommendation) => ({
      id: recommendation.id,
      landlordId: recommendation.landlordId,
      stars: recommendation.stars,
      text: recommendation.text,
      tenancyStartedOn: recommendation.tenancyStartedOn,
      tenancyEndedOn: recommendation.tenancyEndedOn,
      attestedAt: isoOrNull(recommendation.attestedAt),
      landlordReplyText: recommendation.landlordReplyText,
      landlordReplyPublishedAt: isoOrNull(
        recommendation.landlordReplyPublishedAt,
      ),
      createdAt: recommendation.createdAt.toISOString(),
    }));
  }
}

/**
 * `reviews` -> `resourceFeedback`: how the member rated resource guides, and
 * the resources they suggested for the directory, with the reviewer's
 * decision note `toMyResourceSuggestionDTO` already shows them.
 */
@Injectable()
export class ResourceFeedbackExportContributor implements DataExportContribution {
  readonly category = 'reviews';
  readonly archiveKey = 'resourceFeedback';

  constructor(
    @InjectRepository(ResourceGuideRating)
    private readonly guideRatings: Repository<ResourceGuideRating>,
    @InjectRepository(ResourceSuggestion)
    private readonly resourceSuggestions: Repository<ResourceSuggestion>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [ratings, suggestions] = await Promise.all([
      this.guideRatings.find({
        where: { memberId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.resourceSuggestions.find({
        where: { memberId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...ratings.map((rating) => ({
        type: 'guideRating' as const,
        id: rating.id,
        contentKey: rating.contentKey,
        value: rating.value,
        createdAt: rating.createdAt.toISOString(),
        updatedAt: rating.updatedAt.toISOString(),
      })),
      ...suggestions.map((suggestion) => ({
        type: 'resourceSuggestion' as const,
        id: suggestion.id,
        resourceCategory: suggestion.category,
        name: suggestion.name,
        description: suggestion.description,
        phone: suggestion.phone,
        email: suggestion.email,
        website: suggestion.website,
        status: suggestion.status,
        createdListingId: suggestion.createdListingId,
        decisionNote: suggestion.decisionNote,
        createdAt: suggestion.createdAt.toISOString(),
        decidedAt: isoOrNull(suggestion.decidedAt),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `listings`
// ---------------------------------------------------------------------------

/**
 * `listings` -> `listingActivity`: what the member did around directory
 * listings beyond owning them. Ownership claims, edit suggestions, offers to
 * take a listing over (with the note staff addressed to them, which
 * `listForMember` already shows), co-manager seats they hold and co-manager
 * invites they sent (the invitee by id), enquiries, the public questions they
 * asked (with the answer they got), the answers they gave to public questions
 * (the asker stays out), helpful votes on reviews, and their unfinished
 * listing drafts. The draft's resume token is a credential and stays out.
 *
 * `listing_questions` is left out on purpose: its `askedBy` is the moderator
 * who asked, so reading by that column would put submitters' answers from a
 * staff channel into a moderator's archive.
 */
@Injectable()
export class ListingActivityExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'listingActivity';

  constructor(
    @InjectRepository(ListingClaim)
    private readonly claims: Repository<ListingClaim>,
    @InjectRepository(ListingEditSuggestion)
    private readonly editSuggestions: Repository<ListingEditSuggestion>,
    @InjectRepository(ListingOwnerOffer)
    private readonly ownerOffers: Repository<ListingOwnerOffer>,
    @InjectRepository(ListingCoManager)
    private readonly coManagers: Repository<ListingCoManager>,
    @InjectRepository(ListingEnquiry)
    private readonly enquiries: Repository<ListingEnquiry>,
    @InjectRepository(ListingPublicQuestion)
    private readonly publicQuestions: Repository<ListingPublicQuestion>,
    @InjectRepository(ListingReviewHelpfulVote)
    private readonly helpfulVotes: Repository<ListingReviewHelpfulVote>,
    @InjectRepository(ListingDraft)
    private readonly listingDrafts: Repository<ListingDraft>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [
      claims,
      editSuggestions,
      ownerOffers,
      coManagers,
      enquiries,
      publicQuestions,
      answeredQuestions,
      helpfulVotes,
      drafts,
    ] = await Promise.all([
      this.claims.find({ where: { claimantId: userId }, ...byCreatedAt }),
      this.editSuggestions.find({
        where: { suggestedByUserId: userId },
        ...byCreatedAt,
      }),
      this.ownerOffers.find({ where: { offereeId: userId }, ...byCreatedAt }),
      this.coManagers.find({
        where: [{ userId }, { invitedByUserId: userId }],
        ...byCreatedAt,
      }),
      this.enquiries.find({ where: { senderId: userId }, ...byCreatedAt }),
      this.publicQuestions.find({ where: { askerId: userId }, ...byCreatedAt }),
      this.publicQuestions.find({
        where: { answeredById: userId },
        ...byCreatedAt,
      }),
      this.helpfulVotes.find({ where: { voterId: userId }, ...byCreatedAt }),
      this.listingDrafts.find({ where: { userId }, ...byCreatedAt }),
    ]);
    return [
      ...claims.map((claim) => ({
        type: 'claim' as const,
        id: claim.id,
        listingId: claim.listingId,
        note: claim.note,
        status: claim.status,
        createdAt: claim.createdAt.toISOString(),
        reviewedAt: isoOrNull(claim.reviewedAt),
      })),
      ...editSuggestions.map((suggestion) => ({
        type: 'editSuggestion' as const,
        id: suggestion.id,
        listingId: suggestion.listingId,
        field: suggestion.field,
        message: suggestion.message,
        proposedValue: suggestion.proposedValue,
        status: suggestion.status,
        createdAt: suggestion.createdAt.toISOString(),
        resolvedAt: isoOrNull(suggestion.resolvedAt),
      })),
      ...ownerOffers.map((offer) => ({
        type: 'ownerOffer' as const,
        id: offer.id,
        listingId: offer.listingId,
        note: offer.note,
        status: offer.status,
        offeredAt: offer.offeredAt.toISOString(),
        respondedAt: isoOrNull(offer.respondedAt),
      })),
      ...coManagers.map((seat) =>
        seat.userId === userId
          ? {
              type: 'coManager' as const,
              id: seat.id,
              listingId: seat.listingId,
              status: seat.status,
              invitedAt: seat.invitedAt.toISOString(),
              acceptedAt: isoOrNull(seat.acceptedAt),
              endedAt: isoOrNull(seat.endedAt),
            }
          : {
              type: 'coManagerInviteSent' as const,
              id: seat.id,
              listingId: seat.listingId,
              inviteeId: seat.userId,
              status: seat.status,
              invitedAt: seat.invitedAt.toISOString(),
            },
      ),
      ...enquiries.map((enquiry) => ({
        type: 'enquiry' as const,
        id: enquiry.id,
        listingId: enquiry.listingId,
        conversationId: enquiry.conversationId,
        createdAt: enquiry.createdAt.toISOString(),
      })),
      ...publicQuestions.map((question) => ({
        type: 'publicQuestion' as const,
        id: question.id,
        listingId: question.listingId,
        askerName: question.askerName,
        body: question.body,
        answer: question.answer,
        isAnsweredByModerator: question.isAnsweredByModerator,
        answeredAt: isoOrNull(question.answeredAt),
        createdAt: question.createdAt.toISOString(),
      })),
      ...answeredQuestions.map((question) => ({
        type: 'publicAnswer' as const,
        questionId: question.id,
        listingId: question.listingId,
        answer: question.answer,
        answeredAt: isoOrNull(question.answeredAt),
      })),
      ...helpfulVotes.map((vote) => ({
        type: 'helpfulVote' as const,
        reviewId: vote.reviewId,
        createdAt: vote.createdAt.toISOString(),
      })),
      ...drafts.map((draft) => ({
        type: 'draft' as const,
        id: draft.id,
        payload: draft.payload,
        createdAt: draft.createdAt.toISOString(),
        updatedAt: draft.updatedAt.toISOString(),
      })),
    ];
  }
}

/**
 * `listings` -> `safeSpaces`: the places the member nominated as safe
 * spaces (with the decision reason `toSafeSpaceNominationResponse` already
 * shows the nominator), the flags they raised against a safe-space badge, and
 * the vouches they gave. The reviewers' identities, assignment notes and flag
 * resolution notes stay out.
 */
@Injectable()
export class SafeSpacesExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'safeSpaces';

  constructor(
    @InjectRepository(SafeSpaceNomination)
    private readonly nominations: Repository<SafeSpaceNomination>,
    @InjectRepository(SafeSpaceFlag)
    private readonly flags: Repository<SafeSpaceFlag>,
    @InjectRepository(SafeSpaceMemberVouch)
    private readonly vouches: Repository<SafeSpaceMemberVouch>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [nominations, flags, vouches] = await Promise.all([
      this.nominations.find({
        where: { nominatorId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.flags.find({
        where: { flaggerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.vouches.find({
        where: { voucherId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...nominations.map((nomination) => ({
        type: 'nomination' as const,
        id: nomination.id,
        placeName: nomination.placeName,
        address: nomination.address,
        placeType: nomination.placeType,
        listingRef: nomination.listingRef,
        reason: nomination.reason,
        status: nomination.status,
        listingId: nomination.listingId,
        awardedTier: nomination.awardedTier,
        decisionReason: nomination.decisionReason,
        createdAt: nomination.createdAt.toISOString(),
        decidedAt: isoOrNull(nomination.decidedAt),
      })),
      ...flags.map((flag) => ({
        type: 'flag' as const,
        id: flag.id,
        listingId: flag.listingId,
        reasonCode: flag.reasonCode,
        detail: flag.detail,
        resolution: flag.resolution,
        withdrawnAt: isoOrNull(flag.withdrawnAt),
        resolvedAt: isoOrNull(flag.resolvedAt),
        createdAt: flag.createdAt.toISOString(),
      })),
      ...vouches.map((vouch) => ({
        type: 'vouch' as const,
        id: vouch.id,
        listingId: vouch.listingId,
        note: vouch.note,
        relationship: vouch.relationship,
        anonymous: vouch.anonymous,
        withdrawnAt: isoOrNull(vouch.withdrawnAt),
        createdAt: vouch.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `listings` -> `barter`: the barter listings the member posted and the
 * proposals they made on other members' listings.
 */
@Injectable()
export class BarterExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'barter';

  constructor(
    @InjectRepository(BarterListing)
    private readonly barterListings: Repository<BarterListing>,
    @InjectRepository(BarterProposal)
    private readonly barterProposals: Repository<BarterProposal>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [listings, proposals] = await Promise.all([
      this.barterListings.find({
        where: { ownerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.barterProposals.find({
        where: { proposerId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...listings.map((listing) => ({
        type: 'listing' as const,
        id: listing.id,
        barterCategory: listing.category,
        mode: listing.mode,
        offer: listing.offer,
        want: listing.want,
        offerDetail: listing.offerDetail,
        wantDetail: listing.wantDetail,
        tags: listing.tags,
        status: listing.status,
        createdAt: listing.createdAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
      })),
      ...proposals.map((proposal) => ({
        type: 'proposal' as const,
        id: proposal.id,
        listingId: proposal.listingId,
        message: proposal.message,
        status: proposal.status,
        decidedAt: isoOrNull(proposal.decidedAt),
        createdAt: proposal.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `listings` -> `work`: the member's working life on the platform. The
 * companies they own, the company teams they sit on, the employer they
 * declared, the partner organisations they applied for or maintain, the jobs
 * they posted and the job applications they sent (with their answers and
 * cover note). A partner's review note is the staff's and stays out.
 */
@Injectable()
export class WorkExportContributor implements DataExportContribution {
  readonly category = 'listings';
  readonly archiveKey = 'work';

  constructor(
    @InjectRepository(Company)
    private readonly companies: Repository<Company>,
    @InjectRepository(CompanyTeamMember)
    private readonly companyTeamMembers: Repository<CompanyTeamMember>,
    @InjectRepository(Affiliation)
    private readonly affiliations: Repository<Affiliation>,
    @InjectRepository(Partner)
    private readonly partners: Repository<Partner>,
    @InjectRepository(Job)
    private readonly jobs: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly jobApplications: Repository<JobApplication>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [companies, teams, affiliations, partners, jobs, applications] =
      await Promise.all([
        this.companies.find({ where: { ownerId: userId }, ...byCreatedAt }),
        this.companyTeamMembers.find({ where: { userId }, ...byCreatedAt }),
        this.affiliations.find({ where: { userId }, ...byCreatedAt }),
        this.partners.find({
          where: [{ submittedById: userId }, { ownerUserId: userId }],
          ...byCreatedAt,
        }),
        this.jobs.find({ where: { posterId: userId }, ...byCreatedAt }),
        this.jobApplications.find({
          where: { applicantId: userId },
          ...byCreatedAt,
        }),
      ]);
    return [
      ...companies.map((company) => ({
        type: 'company' as const,
        id: company.id,
        slug: company.slug,
        name: company.nameText,
        tagline: company.tagline,
        about: company.about,
        queerRun: company.queerRun,
        queerLed: company.queerLed,
        createdAt: company.createdAt.toISOString(),
        updatedAt: company.updatedAt.toISOString(),
      })),
      ...teams.map((team) => ({
        type: 'companyTeam' as const,
        id: team.id,
        companyId: team.companyId,
        createdAt: team.createdAt.toISOString(),
      })),
      ...affiliations.map((affiliation) => ({
        type: 'affiliation' as const,
        id: affiliation.id,
        companyId: affiliation.companyId,
        role: affiliation.role,
        status: affiliation.status,
        createdAt: affiliation.createdAt.toISOString(),
      })),
      ...partners.map((partner) => ({
        type: 'partner' as const,
        id: partner.id,
        slug: partner.slug,
        name: partner.name,
        status: partner.status,
        relationship:
          partner.ownerUserId === userId
            ? ('maintainer' as const)
            : ('applicant' as const),
        decidedAt: isoOrNull(partner.decidedAt),
        createdAt: partner.createdAt.toISOString(),
      })),
      ...jobs.map((job) => ({
        type: 'jobPosted' as const,
        id: job.id,
        slug: job.slug,
        companyId: job.companyId,
        title: job.title,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
      })),
      ...applications.map((application) => ({
        type: 'jobApplication' as const,
        id: application.id,
        jobId: application.jobId,
        answers: application.answers,
        coverNote: application.coverNote,
        status: application.status,
        createdAt: application.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `magazine`
// ---------------------------------------------------------------------------

/**
 * `magazine` -> `magazineContributions`: the member's magazine writing
 * beyond their bylined articles. Comments they left under articles, their
 * comments in the editorial margin, their messages on a desk piece, the
 * pitches and writer applications they sent (an application with the review
 * note `toWriterApplicationDTO` addresses to the applicant), and the
 * articles they translated. The desk's pass notes on a pitch stay out.
 */
@Injectable()
export class MagazineContributionsExportContributor implements DataExportContribution {
  readonly category = 'magazine';
  readonly archiveKey = 'magazineContributions';

  constructor(
    @InjectRepository(MagazineReaderComment)
    private readonly readerComments: Repository<MagazineReaderComment>,
    @InjectRepository(MagazineArticleComment)
    private readonly editorialComments: Repository<MagazineArticleComment>,
    @InjectRepository(MagazinePieceMessage)
    private readonly pieceMessages: Repository<MagazinePieceMessage>,
    @InjectRepository(MagazinePitch)
    private readonly pitches: Repository<MagazinePitch>,
    @InjectRepository(MagazineWriterApplication)
    private readonly writerApplications: Repository<MagazineWriterApplication>,
    @InjectRepository(MagazineAuthor)
    private readonly magazineAuthors: Repository<MagazineAuthor>,
    @InjectRepository(MagazineArticle)
    private readonly magazineArticles: Repository<MagazineArticle>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [
      readerComments,
      editorialComments,
      pieceMessages,
      pitches,
      applications,
      author,
    ] = await Promise.all([
      this.readerComments.find({ where: { authorId: userId }, ...byCreatedAt }),
      this.editorialComments.find({
        where: { authorId: userId },
        ...byCreatedAt,
      }),
      this.pieceMessages.find({ where: { authorId: userId }, ...byCreatedAt }),
      this.pitches.find({ where: { submitterId: userId }, ...byCreatedAt }),
      this.writerApplications.find({ where: { userId }, ...byCreatedAt }),
      this.magazineAuthors.findOne({ where: { userId } }),
    ]);
    // A translation points at the translator's `magazine_author` row, so a
    // member who never wrote for the magazine has none and no translations.
    const translations = author
      ? await this.magazineArticles.find({
          where: { translatorAuthorId: author.id },
          ...byCreatedAt,
        })
      : [];
    return [
      ...readerComments.map((comment) => ({
        type: 'readerComment' as const,
        id: comment.id,
        articleId: comment.articleId,
        parentId: comment.parentId,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        editedAt: isoOrNull(comment.editedAt),
        deletedAt: isoOrNull(comment.deletedAt),
      })),
      ...editorialComments.map((comment) => ({
        type: 'editorialComment' as const,
        id: comment.id,
        articleId: comment.articleId,
        blockId: comment.blockId,
        parentId: comment.parentId,
        body: comment.body,
        resolved: comment.resolved,
        createdAt: comment.createdAt.toISOString(),
      })),
      ...pieceMessages.map((message) => ({
        type: 'pieceMessage' as const,
        id: message.id,
        pieceId: message.pieceId,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
      ...pitches.map((pitch) => ({
        type: 'pitch' as const,
        id: pitch.id,
        title: pitch.title,
        note: pitch.note,
        tags: pitch.tags,
        suggestFormat: pitch.suggestFormat,
        status: pitch.status,
        issueId: pitch.issueId,
        returnedAt: isoOrNull(pitch.returnedAt),
        createdAt: pitch.createdAt.toISOString(),
      })),
      ...applications.map((application) => ({
        type: 'writerApplication' as const,
        id: application.id,
        pitchNote: application.pitchNote,
        sampleText: application.sampleText,
        sampleLink: application.sampleLink,
        status: application.status,
        reviewNote: application.reviewNote,
        createdAt: application.createdAt.toISOString(),
        reviewedAt: isoOrNull(application.reviewedAt),
      })),
      ...translations.map((article) => ({
        type: 'translation' as const,
        id: article.id,
        slug: article.slug,
        title: article.title,
        locale: article.locale,
        translationOfArticleId: article.translationOfArticleId,
        lifecycle: article.lifecycle,
        publishedAt: isoOrNull(article.publishedAt),
        createdAt: article.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * `magazine` -> `magazinePayments`: the money side of each desk piece the
 * member wrote. The agreed fee and expenses, the currency, the member's own
 * invoice reference, the payment terms and where the payment stands. The
 * desk's free-text fee and expense notes stay out: they are the desk's
 * working record and can name other staff.
 */
@Injectable()
export class MagazinePaymentsExportContributor implements DataExportContribution {
  readonly category = 'magazine';
  readonly archiveKey = 'magazinePayments';

  constructor(
    @InjectRepository(MagazinePayment)
    private readonly payments: Repository<MagazinePayment>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.payments
      .createQueryBuilder('payment')
      .innerJoin(MagazinePiece, 'piece', 'payment.pieceId = piece.id')
      .where('piece.writerId = :userId', { userId })
      .orderBy('payment.createdAt', 'ASC')
      .getMany();
    return rows.map((payment) => ({
      id: payment.id,
      pieceId: payment.pieceId,
      currency: payment.currency,
      feeAmount: payment.feeAmount,
      expensesAmount: payment.expensesAmount,
      invoice: payment.invoice,
      filedOn: payment.filedOn,
      terms: payment.terms,
      dueOn: payment.dueOn,
      status: payment.status,
      paidOn: payment.paidOn,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `governance`
// ---------------------------------------------------------------------------

/**
 * `governance` -> `governanceActivity`: the member's other ways of shaping
 * the platform. The proposals they co-signed, the roadmap ideas they
 * submitted, their roadmap comments and votes, the changemakers they
 * nominated, and the forms they sent the team (grants, incubator,
 * governance concerns, culture submissions).
 *
 * A nomination names a nominee who is a member by id. For somebody off the
 * platform it keeps the name the member typed; the nominee's contact details
 * are that person's data and stay out.
 */
@Injectable()
export class GovernanceActivityExportContributor implements DataExportContribution {
  readonly category = 'governance';
  readonly archiveKey = 'governanceActivity';

  constructor(
    @InjectRepository(GovernanceProposalCosignature)
    private readonly cosignatures: Repository<GovernanceProposalCosignature>,
    @InjectRepository(RoadmapIdea)
    private readonly roadmapIdeas: Repository<RoadmapIdea>,
    @InjectRepository(RoadmapItemComment)
    private readonly roadmapComments: Repository<RoadmapItemComment>,
    @InjectRepository(RoadmapVote)
    private readonly roadmapVotes: Repository<RoadmapVote>,
    @InjectRepository(ChangemakerNomination)
    private readonly nominations: Repository<ChangemakerNomination>,
    @InjectRepository(IntakeSubmission)
    private readonly intakeSubmissions: Repository<IntakeSubmission>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [cosignatures, ideas, comments, votes, nominations, submissions] =
      await Promise.all([
        this.cosignatures.find({ where: { memberId: userId }, ...byCreatedAt }),
        this.roadmapIdeas.find({
          where: { submittedById: userId },
          ...byCreatedAt,
        }),
        this.roadmapComments.find({
          where: { authorId: userId },
          ...byCreatedAt,
        }),
        this.roadmapVotes.find({ where: { memberId: userId }, ...byCreatedAt }),
        this.nominations.find({
          where: { nominatorId: userId },
          ...byCreatedAt,
        }),
        this.intakeSubmissions.find({
          where: { submitterId: userId },
          ...byCreatedAt,
        }),
      ]);
    return [
      ...cosignatures.map((cosignature) => ({
        type: 'cosignature' as const,
        id: cosignature.id,
        proposalId: cosignature.proposalId,
        createdAt: cosignature.createdAt.toISOString(),
      })),
      ...ideas.map((idea) => ({
        type: 'roadmapIdea' as const,
        id: idea.id,
        text: idea.text,
        ideaCategory: idea.category,
        status: idea.status,
        createdAt: idea.createdAt.toISOString(),
      })),
      ...comments.map((comment) => ({
        type: 'roadmapComment' as const,
        id: comment.id,
        itemId: comment.itemId,
        body: comment.body,
        hidden: comment.hidden,
        createdAt: comment.createdAt.toISOString(),
      })),
      ...votes.map((vote) => ({
        type: 'roadmapVote' as const,
        id: vote.id,
        targetType: vote.targetType,
        targetId: vote.targetId,
        createdAt: vote.createdAt.toISOString(),
      })),
      ...nominations.map((nomination) => ({
        type: 'changemakerNomination' as const,
        id: nomination.id,
        nomineeUserId: nomination.nomineeUserId,
        nomineeName: nomination.nomineeUserId ? null : nomination.nomineeName,
        reason: nomination.reason,
        status: nomination.status,
        createdAt: nomination.createdAt.toISOString(),
        reviewedAt: isoOrNull(nomination.reviewedAt),
      })),
      ...submissions.map((submission) => ({
        type: 'formSubmission' as const,
        id: submission.id,
        kind: submission.kind,
        payload: submission.payload,
        status: submission.status,
        createdAt: submission.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `reports`
// ---------------------------------------------------------------------------

/**
 * `reports` -> `appeals`: the appeals the member filed against a moderation
 * decision, in the shape `toMemberAppealDTO` already shows them: their
 * argument, where the appeal stands and the decision they received. The
 * severity and the response deadline are the moderators' queue fields and
 * stay out.
 */
@Injectable()
export class AppealsExportContributor implements DataExportContribution {
  readonly category = 'reports';
  readonly archiveKey = 'appeals';

  constructor(
    @InjectRepository(Appeal)
    private readonly appeals: Repository<Appeal>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.appeals.find({
      where: { appellantId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((appeal) => ({
      id: appeal.id,
      community: appeal.community,
      argument: appeal.argument,
      status: appeal.status,
      decision: appeal.decision,
      createdAt: appeal.createdAt.toISOString(),
      decidedAt: isoOrNull(appeal.decidedAt),
    }));
  }
}

// ---------------------------------------------------------------------------
// `membershipCards`
// ---------------------------------------------------------------------------

/**
 * `membershipCards` -> `cardScans`: each time one of the member's cards was
 * checked at a door, with the event and the result. The host who scanned it
 * stays out.
 */
@Injectable()
export class CardScansExportContributor implements DataExportContribution {
  readonly category = 'membershipCards';
  readonly archiveKey = 'cardScans';

  constructor(
    @InjectRepository(MembershipCard)
    private readonly membershipCards: Repository<MembershipCard>,
    @InjectRepository(MembershipCardScan)
    private readonly cardScans: Repository<MembershipCardScan>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const cards = await this.membershipCards.find({
      select: { id: true },
      where: { userId },
    });
    const cardIds = cards.map((card) => card.id);
    if (!cardIds.length) return [];
    const rows = await this.cardScans.find({
      where: { cardId: In(cardIds) },
      order: { scannedAt: 'ASC' },
    });
    return rows.map((scan) => ({
      id: scan.id,
      cardId: scan.cardId,
      eventId: scan.eventId,
      result: scan.result,
      scannedAt: scan.scannedAt.toISOString(),
    }));
  }
}

// ---------------------------------------------------------------------------
// `volunteering`
// ---------------------------------------------------------------------------

/**
 * `volunteering` -> `volunteeringRoles`: the volunteer roles the member
 * posted, the opportunity teams they sit on, and the Commission Board
 * projects they expressed interest in (with their message).
 */
@Injectable()
export class VolunteeringRolesExportContributor implements DataExportContribution {
  readonly category = 'volunteering';
  readonly archiveKey = 'volunteeringRoles';

  constructor(
    @InjectRepository(VolunteerOpportunity)
    private readonly opportunities: Repository<VolunteerOpportunity>,
    @InjectRepository(VolunteerOpportunityTeam)
    private readonly opportunityTeams: Repository<VolunteerOpportunityTeam>,
    @InjectRepository(CommissionInterest)
    private readonly commissionInterests: Repository<CommissionInterest>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const byCreatedAt = { order: { createdAt: 'ASC' as const } };
    const [posted, teams, interests] = await Promise.all([
      this.opportunities.find({ where: { posterId: userId }, ...byCreatedAt }),
      this.opportunityTeams.find({ where: { userId }, ...byCreatedAt }),
      this.commissionInterests.find({
        where: { memberId: userId },
        ...byCreatedAt,
      }),
    ]);
    return [
      ...posted.map((opportunity) => ({
        type: 'posted' as const,
        id: opportunity.id,
        slug: opportunity.slug,
        org: opportunity.org,
        role: opportunity.role,
        status: opportunity.status,
        createdAt: opportunity.createdAt.toISOString(),
      })),
      ...teams.map((team) => ({
        type: 'team' as const,
        id: team.id,
        opportunityId: team.opportunityId,
        createdAt: team.createdAt.toISOString(),
      })),
      ...interests.map((interest) => ({
        type: 'commissionInterest' as const,
        id: interest.id,
        commissionTitle: interest.commissionTitle,
        commissionCategory: interest.commissionCategory,
        recipientName: interest.recipientName,
        message: interest.message,
        createdAt: interest.createdAt.toISOString(),
      })),
    ];
  }
}

// ---------------------------------------------------------------------------
// `subprofiles`
// ---------------------------------------------------------------------------

/**
 * `subprofiles` -> `personaActivity`: the member's ties to personas beyond
 * the ones they created. Shared personas they co-own, the endorsements they
 * gave, the personas they follow, and the co-owner invites they sent and
 * received (the other person by id).
 */
@Injectable()
export class PersonaActivityExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'personaActivity';

  constructor(
    @InjectRepository(SubprofileMember)
    private readonly subprofileMembers: Repository<SubprofileMember>,
    @InjectRepository(SubprofileEndorsement)
    private readonly endorsements: Repository<SubprofileEndorsement>,
    @InjectRepository(SubprofileFollower)
    private readonly followers: Repository<SubprofileFollower>,
    @InjectRepository(SubprofileInvite)
    private readonly subprofileInvites: Repository<SubprofileInvite>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [coOwned, endorsements, follows, invites] = await Promise.all([
      this.subprofileMembers.find({
        where: { userId },
        order: { joinedAt: 'ASC' },
      }),
      this.endorsements.find({
        where: { endorserId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.followers.find({
        where: { followerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.subprofileInvites.find({
        where: [{ invitedByUserId: userId }, { invitedUserId: userId }],
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...coOwned.map((membership) => ({
        type: 'coOwner' as const,
        id: membership.id,
        subprofileId: membership.subprofileId,
        position: membership.position,
        joinedAt: membership.joinedAt.toISOString(),
      })),
      ...endorsements.map((endorsement) => ({
        type: 'endorsement' as const,
        id: endorsement.id,
        subprofileId: endorsement.subprofileId,
        note: endorsement.note,
        withdrawnAt: isoOrNull(endorsement.withdrawnAt),
        createdAt: endorsement.createdAt.toISOString(),
      })),
      ...follows.map((follow) => ({
        type: 'follow' as const,
        id: follow.id,
        subprofileId: follow.subprofileId,
        createdAt: follow.createdAt.toISOString(),
      })),
      ...invites.map((invite) => {
        const isSent = invite.invitedByUserId === userId;
        return {
          type: 'invite' as const,
          direction: isSent ? ('sent' as const) : ('received' as const),
          subprofileId: invite.subprofileId,
          counterpartyId: isSent
            ? invite.invitedUserId
            : invite.invitedByUserId,
          status: invite.status,
          createdAt: invite.createdAt.toISOString(),
          respondedAt: isoOrNull(invite.respondedAt),
        };
      }),
    ];
  }
}

/**
 * `subprofiles` -> `personaContent`: what is on the personas the member
 * created or co-owns. The items in each section, the social links, the
 * events and communities the persona lists, and the podcast feeds connected
 * to it (the feed URL and settings; the episodes staged from a feed are the
 * podcast's public listing, not the member's data, and the ones they chose to
 * publish are already here as items). Read through a join on the persona's
 * creator and its co-owner seats, so only personas the member holds
 * contribute.
 */
@Injectable()
export class PersonaContentExportContributor implements DataExportContribution {
  readonly category = 'subprofiles';
  readonly archiveKey = 'personaContent';

  constructor(
    @InjectRepository(SubprofileItem)
    private readonly subprofileItems: Repository<SubprofileItem>,
    @InjectRepository(SubprofileSocialLink)
    private readonly subprofileSocialLinks: Repository<SubprofileSocialLink>,
    @InjectRepository(SubprofileAffiliation)
    private readonly subprofileAffiliations: Repository<SubprofileAffiliation>,
    @InjectRepository(SubprofileFeed)
    private readonly subprofileFeeds: Repository<SubprofileFeed>,
  ) {}

  /** Rows of a persona-keyed table for the personas this member holds. */
  private heldPersonaRows<Entity extends ObjectLiteral>(
    repository: Repository<Entity>,
    alias: string,
    userId: string,
  ): Promise<Entity[]> {
    return repository
      .createQueryBuilder(alias)
      .innerJoin(
        Subprofile,
        'subprofile',
        `${alias}.subprofileId = subprofile.id`,
      )
      .leftJoin(
        SubprofileMember,
        'coOwner',
        'coOwner.subprofileId = subprofile.id AND coOwner.userId = :userId',
        { userId },
      )
      .where('(subprofile.userId = :userId OR coOwner.id IS NOT NULL)', {
        userId,
      })
      .orderBy(`${alias}.createdAt`, 'ASC')
      .getMany();
  }

  async buildContribution(userId: string): Promise<unknown> {
    const [items, socialLinks, affiliations, feeds] = await Promise.all([
      this.heldPersonaRows(this.subprofileItems, 'item', userId),
      this.heldPersonaRows(this.subprofileSocialLinks, 'socialLink', userId),
      this.heldPersonaRows(this.subprofileAffiliations, 'affiliation', userId),
      this.heldPersonaRows(this.subprofileFeeds, 'feed', userId),
    ]);
    return [
      ...items.map((item) => ({
        type: 'item' as const,
        id: item.id,
        subprofileId: item.subprofileId,
        section: item.section,
        title: item.title,
        subtitle: item.subtitle,
        description: item.description,
        url: item.url,
        imageUrl: item.imageUrl,
        date: item.date,
        meta: item.meta,
        tags: item.tags,
        collaborators: item.collaborators,
        isFeatured: item.isFeatured,
        position: item.position,
        venue: item.venue,
        doors: item.doors,
        ticketUrl: item.ticketUrl,
        gigState: item.gigState,
        medium: item.medium,
        dimensions: item.dimensions,
        edition: item.edition,
        workState: item.workState,
        structured: item.structured,
        createdAt: item.createdAt.toISOString(),
      })),
      ...socialLinks.map((link) => ({
        type: 'socialLink' as const,
        id: link.id,
        subprofileId: link.subprofileId,
        platform: link.platform,
        urlOrHandle: link.urlOrHandle,
        position: link.position,
        createdAt: link.createdAt.toISOString(),
      })),
      ...affiliations.map((affiliation) => ({
        type: 'affiliation' as const,
        id: affiliation.id,
        subprofileId: affiliation.subprofileId,
        targetType: affiliation.targetType,
        targetSlug: affiliation.targetSlug,
        role: affiliation.role,
        position: affiliation.position,
        createdAt: affiliation.createdAt.toISOString(),
      })),
      ...feeds.map((feed) => ({
        type: 'podcastFeed' as const,
        id: feed.id,
        subprofileId: feed.subprofileId,
        feedUrl: feed.feedUrl,
        section: feed.section,
        title: feed.title,
        author: feed.author,
        imageUrl: feed.imageKey,
        autoPublish: feed.autoPublish,
        connectedByYou: feed.createdById === userId,
        lastSyncedAt: feed.lastSyncedAt
          ? feed.lastSyncedAt.toISOString()
          : null,
        createdAt: feed.createdAt.toISOString(),
      })),
    ];
  }
}

/**
 * Every ENG-495b contributor, in archive order. Spread into
 * `NEW_DOMAIN_EXPORT_CONTRIBUTORS`, and each `archiveKey` appears in
 * `EXPORT_CSV_CATEGORIES` in this same order.
 */
export const MORE_EXPORT_CONTRIBUTORS = [
  MemberPreferencesExportContributor,
  ProfileSectionsExportContributor,
  HandlesExportContributor,
  BoardExportContributor,
  VerificationExportContributor,
  JoinApplicationExportContributor,
  StaffRolesExportContributor,
  MessageActivityExportContributor,
  ForumActivityExportContributor,
  CommunityMembershipsExportContributor,
  CommunityActivityExportContributor,
  CommunityRequestsExportContributor,
  FeedPreferencesExportContributor,
  EventPreferencesExportContributor,
  EventParticipationExportContributor,
  ConnectionNotesExportContributor,
  SuggestionDismissalsExportContributor,
  InvitesSentExportContributor,
  AccountRequestsExportContributor,
  RecognitionExportContributor,
  WatchHistoryExportContributor,
  SavedListsExportContributor,
  CollectionsExportContributor,
  DraftsExportContributor,
  GroupListingsExportContributor,
  LandlordsExportContributor,
  LandlordRecommendationsExportContributor,
  ResourceFeedbackExportContributor,
  ListingActivityExportContributor,
  SafeSpacesExportContributor,
  BarterExportContributor,
  WorkExportContributor,
  MagazineContributionsExportContributor,
  MagazinePaymentsExportContributor,
  GovernanceActivityExportContributor,
  AppealsExportContributor,
  CardScansExportContributor,
  VolunteeringRolesExportContributor,
  PersonaActivityExportContributor,
  PersonaContentExportContributor,
] as const;

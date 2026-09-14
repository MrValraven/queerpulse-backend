import type { EntityTarget, ObjectLiteral } from 'typeorm';
import type { FeatureKey } from '../launchedFeatures';
import { Community } from '../communities/entities/community.entity';
import { ReadingGroupProposal } from '../reading-group-proposals/entities/reading-group-proposal.entity';
import { ChangemakerNomination } from '../changemakers/entities/changemaker-nomination.entity';
import { Company } from '../companies/entities/company.entity';
import { Job } from '../jobs/entities/job.entity';
import { Partner } from '../partners/entities/partner.entity';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { BarterListing } from '../barter/entities/barter-listing.entity';
import { Event } from '../events/entities/event.entity';
import { Connection } from '../connections/entities/connection.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { Listing } from '../listings/entities/listing.entity';
import { CoopJoinRequest } from '../housing/entities/coop-join-request.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { FlatmateProfile } from '../flatmate-profiles/entities/flatmate-profile.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { LandlordRecommendation } from '../landlords/entities/landlord-recommendation.entity';
import { MagazineStorySubmission } from '../magazine/entities/magazine-story-submission.entity';
import { ResourceSuggestion } from '../resources/entities/resource-suggestion.entity';
import { CommissionInterest } from '../culture/entities/commission-interest.entity';
import { GovernanceVote } from '../governance/entities/governance-vote.entity';
import { GovernanceProposalCosignature } from '../governance/entities/governance-proposal-cosignature.entity';
import { RoadmapIdea } from '../roadmap/entities/roadmap-idea.entity';

/**
 * How a feature's usage "depth" is measured.
 *
 * `rows` counts deliberate creations: rows with `created_at < cutoff`, summed
 * across the listed entities. `reach-only` names a feature that has no rows to
 * count (a read surface) and states why, so the absence of an `entities` list
 * reads as a decision rather than an oversight.
 */
export type DepthSpec =
  | {
      kind: 'rows';
      /** Counted with `created_at < cutoff`, summed across entities. */
      entities: EntityTarget<ObjectLiteral>[];
    }
  | { kind: 'reach-only'; reason: string };

/**
 * Maps every launched feature key to the entities that measure its depth.
 *
 * Typed as a full `Record<FeatureKey, DepthSpec>` rather than a `Partial`, so
 * adding a key to `launchedFeatures` without a depth definition fails the
 * build. A `Partial` would compile and silently report zero, which reads
 * identically to a dead feature.
 *
 * THE TEST FOR EVERY ENTRY: can a member create this row. Depth exists to
 * answer "did a member arrive and deliberately create something", so an
 * entity is eligible only when a route reachable by an ordinary member (no
 * `@Roles` or `@StaffRoles` gate above `ActiveMemberGuard`/`NotRestrictedGuard`)
 * can insert it. An entity created solely through an admin- or staff-gated
 * controller counts staff activity rather than member activity, and inverts the
 * signal this panel exists to give: a "browsed but empty" reading is supposed
 * to mean people arrived and created nothing, which is meaningless if what is
 * being counted is a staff action nobody but staff can take. When a feature's
 * headline entity is staff-only, look for a sibling entity members DO create
 * (a join request, a vote, a suggestion, a submission) and count that
 * instead. When a feature has no member-authored entity at all, mark it
 * `reach-only` with a reason, the same treatment `feed` gets.
 */
export const FEATURE_DEPTH: Record<FeatureKey, DepthSpec> = {
  communities: { kind: 'rows', entities: [Community] },
  community: {
    kind: 'rows',
    entities: [ReadingGroupProposal, ChangemakerNomination],
  },
  companies: { kind: 'rows', entities: [Company] },
  jobs: { kind: 'rows', entities: [Job] },
  partners: { kind: 'rows', entities: [Partner] },
  volunteering: {
    kind: 'rows',
    entities: [VolunteerOpportunity, VolunteerSignup],
  },
  barter: { kind: 'rows', entities: [BarterListing] },
  events: { kind: 'rows', entities: [Event] },
  connections: { kind: 'rows', entities: [Connection] },
  // Conversations only. The platform promises end-to-end encrypted direct
  // messages, and a running total of how many private messages exist is a
  // statistic about private communication that is not worth having.
  messaging: { kind: 'rows', entities: [Conversation] },
  forum: { kind: 'rows', entities: [ForumThread, ForumPost] },
  feed: {
    kind: 'reach-only',
    reason: 'The feed is a read surface and creates nothing.',
  },
  listings: { kind: 'rows', entities: [Listing] },
  // `HousingCoop` is excluded: it is created only through
  // `AdminHousingController` (`@Roles(Admin)`) and `seed.ts`, never by a
  // member route. `CoopJoinRequest` (`HousingController.submitJoinRequest`,
  // reachable with no staff role) is the member-authored row.
  housing: { kind: 'rows', entities: [CoopJoinRequest] },
  housingListings: { kind: 'rows', entities: [HousingListing] },
  flatmateProfiles: { kind: 'rows', entities: [FlatmateProfile] },
  landlords: { kind: 'rows', entities: [Landlord, LandlordRecommendation] },
  // `MagazinePiece` is excluded: `MagazinePieceService.createPiece` is only
  // ever called from `AdminMagazinePiecesController`, gated by
  // `@StaffRoles('magazine_editor')`, even for a self-written piece.
  // `MagazineStorySubmission` (`MagazineController.createSubmission`, plain
  // `ActiveMemberGuard`) is the member's own pitch.
  magazine: { kind: 'rows', entities: [MagazineStorySubmission] },
  // `Resource` is excluded: every create route for it sits behind
  // `AdminResourcesController` / `AdminResourceListingsController`, both
  // gated by `@StaffRoles('resource_curator')`. `ResourceSuggestion`
  // (`ResourcesController.suggest`, plain `ActiveMemberGuard`) is what a
  // member actually creates.
  resources: { kind: 'rows', entities: [ResourceSuggestion] },
  // No member-authored row exists for content. `Topic` is a curated taxonomy
  // with no create route at all. `TopicPost` is not a member action aimed at
  // this feature either: it is materialized by `TopicPostLinkService.linkThread`
  // as a side effect of `ForumThreadsService.create`, only when the member's
  // tags happen to overlap a curated topic they neither chose nor targeted.
  // Counting it here would double-count the same forum thread that is
  // already counted as `forum` depth.
  content: {
    kind: 'reach-only',
    reason:
      'Topics are a curated taxonomy with no member create route, and topic posts are derived from forum threads that are already counted as forum depth.',
  },
  culture: { kind: 'rows', entities: [CommissionInterest] },
  // `GovernanceProposal` is excluded: `GovernanceController`'s `proposals`
  // route carries its own method-level `@UseGuards(RolesGuard)
  // @Roles(Admin)` on top of the class's `ActiveMemberGuard`, so only an
  // admin can create one. `GovernanceVote` and `GovernanceProposalCosignature`
  // (`proposals/:id/vote` and `proposals/:id/cosign`, plain
  // `NotRestrictedGuard`) are what a member creates.
  governance: {
    kind: 'rows',
    entities: [GovernanceVote, GovernanceProposalCosignature],
  },
  roadmap: { kind: 'rows', entities: [RoadmapIdea] },
  // `CinemaTitle` is excluded: it is created only through
  // `AdminTitlesController`, gated by `@Roles(Moderator, Admin)` and
  // `@StaffRoles('editorial')`. There is no member-authored sibling row to
  // fall back to (`WatchProgress` is a per-member watch record, exactly the
  // shape this feature refuses to report; see the module comment above), so
  // cinema is reach-only rather than reporting a staff count as member depth.
  cinema: {
    kind: 'reach-only',
    reason:
      'Titles are published by editorial staff only; no member route creates a CinemaTitle, and WatchProgress is excluded on the same privacy grounds as messaging.',
  },
};

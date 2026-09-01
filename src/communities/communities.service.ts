import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { isUniqueViolation } from '../common/db-errors';
import { countCommunityTagFacets } from './community-tag-facets';
import { escapeLikeTerm } from '../common/like-escape';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { ConnectionsService } from '../connections/connections.service';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { MemberLookup, MemberRef, toMemberRef } from '../common/member-ref';
import {
  DEFAULT_LIST_LIMIT,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MediaCropService } from '../media-crops/media-crops.service';
import { knownCommunityTags } from './community-tags';
import { knownLanguages } from '../profiles/languages';
import { toStoredPlainTextOrNull } from './community-plain-text';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
// Entity-only import (no provider, no module edge), so this stays a plain
// table join in `myCommunities` and creates no dependency cycle with
// MembershipCardsModule, which already depends on this module.
import {
  CardIssuerType,
  CommunityCard,
} from '../membership-cards/entities/community-card.entity';
import {
  CommunityCardDTO,
  CommunityDetailDTO,
  CommunityJoinRequestDTO,
  CommunityBrowseFacetCounts,
  CommunityStats,
  JoinRequestApplicantContext,
  JoinResultDTO,
  MemberRoleDTO,
  MyCommunityDTO,
  RosterEntryDTO,
  toCommunityCard,
  toCommunityDetail,
  toJoinRequestDTO,
  toRosterEntry,
} from './community-response';
import {
  ACCOUNT_REMOVED,
  AccountRemovedEvent,
} from '../ban-evasion/ban-evasion.events';
import { RemovalKind } from '../ban-evasion/entities/removed-account-signal.entity';
import {
  banExpiryFromDays,
  resolveRuleSnapshot,
} from './community-bans-response';
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import { COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS } from './community-ban-ratification-window';
import {
  CommunityRemovalOutcomeDTO,
  toCommunityRemovalOutcomeDTO,
} from './community-ban-ratifications-response';
import {
  COMMUNITY_BAN_AUDIT_ACTION,
  COMMUNITY_REMOVAL_AUDIT_ACTION,
} from './community-governance-log.service';
import { CommunityBan } from './entities/community-ban.entity';
import { CommunityBanRatification } from './entities/community-ban-ratification.entity';
import {
  CommunityJoinRequest,
  CommunityJoinRequestDeclineKind,
  CommunityJoinRequestInvolvement,
  JoinRequestStatus,
} from './entities/community-join-request.entity';
import { CommunityTagRequest } from './entities/community-tag-request.entity';
import { CreateCommunityTagRequestDto } from './dto/create-community-tag-request.dto';
import { ListJoinRequestsQuery } from './dto/list-join-requests.query';
import {
  CommunityTagRequestResponseDTO,
  toCommunityTagRequestResponse,
} from './community-tag-request-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import {
  CommunityMemberJoinedEvent,
  CommunityMemberLeftEvent,
  COMMUNITY_MEMBER_JOINED,
  COMMUNITY_MEMBER_LEFT,
} from './community.events';
import { CommunityPost } from './entities/community-post.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import {
  AccessTier,
  Community,
  CommunityFrozenReason,
  CommunityType,
} from './entities/community.entity';

// Comma-separated query param -> trimmed, non-empty values. Mirrors
// `ProfilesService`'s file-local helper of the same name/shape.
function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_STATS: CommunityStats = {
  memberCount: 0,
  activeThisWeek: 0,
  postsThisWeek: 0,
};

// `suggestedCommunities` caps its result the same way `relatedCommunities`
// caps at 4 — a short shelf, not a browse list.
const SUGGESTED_COMMUNITIES_LIMIT = 6;

const DAY_MS = 24 * 60 * 60 * 1000;

// How long a declined applicant waits before they may apply again, one wait
// per kind of "no" (see `CommunityJoinRequestDeclineKind`).
//
// `not_now` is a timing answer, so the wait is short: a month is long enough
// that whatever made this a bad moment (a full intake, a pause before an
// event) has plausibly moved on, and short enough that the invitation to come
// back is a real one.
const REAPPLY_WAIT_DAYS_NOT_NOW = 30;
// `not_a_fit` is an answer about fit, so the wait is half a year: reapplying
// should mean something has genuinely changed rather than the applicant
// simply trying the door again. It is still a wait, never a permanent bar. A
// permanent bar is a ban (`community_bans`), which is a different decision.
const REAPPLY_WAIT_DAYS_NOT_A_FIT = 180;

// Cap on the free-text roster search term, so a pathological ILIKE pattern
// cannot be handed to Postgres. Matches `ListCommunitiesQuery.q`'s own limit.
const ROSTER_SEARCH_MAX_LENGTH = 200;

// Postgres unique-violation SQLSTATE. TypeORM surfaces it either directly on
// the QueryFailedError or on the wrapped driverError depending on the path.
// Mirrors `EventsService`'s identical helper (file-local there too, not
// shared/exported — kept consistent with that precedent).
export interface CreateCommunityInput {
  name: string;
  purpose: string;
  type: CommunityType;
  whoFor: string;
  accessTier: AccessTier;
  rosterVisible: boolean;
  features: string[];
  rules: string[];
  tagline: string;
  tags?: string[]; // curated ids from COMMUNITY_TAGS; defaults to [] when omitted
  coverImageUrl?: string | null; // storage key / https URL / '' to clear
  avatarImageUrl?: string | null; // same convention as coverImageUrl
  welcomeMessage?: string | null; // plain text, sanitized on write
  city?: string | null; // plain text, sanitized on write
  area?: string | null; // plain text, sanitized on write
  isOnline?: boolean; // defaults to false when omitted
  languages?: string[]; // codes from LANGUAGE_CODES; defaults to [] when omitted
  // Owner-level opt-in to a signed-out teaser. Only ever true while
  // `accessTier` is `public` or `request`; see `assertPublicListingAllowed`.
  isPubliclyListed?: boolean;
  handle: string; // desired slug
  // Member slugs -> sent a CommunityInviteReceived notification carrying
  // `proposedRole: 'mod'`. NOT a roster add: nobody is made a moderator
  // without consent (see `resolveInvitees`).
  stewards?: string[];
  // Member slugs -> sent a CommunityInviteReceived notification, never
  // force-added to the roster (see `resolveInvitees`)
  invites?: string[];
}

// `handle` only ever applies at creation time (spec: "handle ignored on
// patch"). `stewards`/`invites` are creation-time invitations with no
// PATCH-time re-send semantics either. All three are omitted from the input
// type AND from `UpdateCommunityDto`, so sending one is a 400 that names the
// field rather than a silent drop the client reads as success (BE-COM-22).
export type UpdateCommunityInput = Partial<
  Omit<CreateCommunityInput, 'handle' | 'stewards' | 'invites'>
>;

export type CommunityListFilter = 'discover' | 'mine';

// 'active' used to be left out because ranking by liveliness meant an
// aggregate join/subquery across `community_posts` evaluated for the WHOLE
// filtered set before pagination, with no index to make it cheap. The
// denormalized counter that comment asked for now exists:
// `communities.active_this_week`, refreshed hourly by
// `CommunityActivityCounterService` and indexed
// (`IDX_communities_active_this_week`), so the sort is a plain indexed
// ORDER BY and the frontend can stop draining every page of the directory to
// the browser to compute it.
export type CommunityListSort = 'newest' | 'name' | 'active';

export interface CommunityListQuery {
  filter?: CommunityListFilter;
  type?: CommunityType;
  access?: AccessTier;
  page?: number;
  // Free-text search over name/tagline/purpose, ANDed with `type`/`access`/
  // `filter` rather than replacing them — mirrors `searchByText`'s ILIKE
  // clause, applied inline so it composes with the rest of `list()`'s query
  // instead of duplicating the pagination/stats/role hydration path.
  q?: string;
  // Defaults to 'newest' (the pre-existing, unparametrized behavior) when
  // omitted — see `list()`'s `ORDER BY`.
  sort?: CommunityListSort;
  // Comma-separated curated tag ids, e.g. ?tags=trans-nonbinary,book-club.
  // Filters `communities.tags` via array overlap (`&&`), same shape as
  // `ProfilesService.searchMembers`'s `?tags=` filter over `profiles.tags`.
  // Unknown ids are dropped before the query runs; see COMMUNITY_TAGS.
  tags?: string;
  // Exact, case-insensitive match on `communities.city`.
  city?: string;
  // One code from LANGUAGE_CODES; matches when `communities.languages`
  // CONTAINS it (array overlap, the same operator `tags` uses).
  language?: string;
  // Matches `communities.is_online`. Undefined applies no filter, so both
  // `true` and `false` are real, expressible answers.
  online?: boolean;
}

/** Body of `freeze`. `note` is the moderator's optional short PUBLIC line
 *  explaining the pause, stored in `communities.frozen_note` and cleared by
 *  `unfreeze`. Absent on a client that predates it, and on every automatic
 *  freeze (which has no human author to write one). */
export interface FreezeCommunityInput {
  note?: string | null;
}

export interface JoinCommunityInput {
  note?: string;
  involvement?: CommunityJoinRequestInvolvement;
  acceptedRulesVersion?: number;
}

export type JoinRequestAction = 'approve' | 'decline';

/** The decline half of a triage call. Both fields are absent on approve, and
 * both may be absent on a decline from a client that predates them. */
export interface TriageJoinRequestInput {
  action: JoinRequestAction;
  declineKind?: CommunityJoinRequestDeclineKind;
  declineReason?: string;
}

/** Options of `removeMember`. `allowReturn` opts OUT of the ban a removal
 * writes by default; it is ignored for a self-leave. `reason` is stored on
 * the ban row, shown on the mod panel, carried into the governance log, and
 * sent to the removed member.
 *
 * `banDays` makes the bar temporary. ABSENT MEANS "PERMANENT, PENDING A SECOND
 * SIGNATURE" (PRD-25): a 30-day bar takes effect at once and a hold opens for
 * a second owner, co-owner or moderator to make it permanent, or for a
 * community with no second eligible signatory, the 30-day bar is the whole of
 * it. `ruleIndex` cites one of the
 * community's own house rules, 0-based into `Community.rules`; the server
 * snapshots the version and wording alongside it so the citation survives a
 * later rules rewrite. Both are ignored when no ban is written at all. */
export interface RemoveMemberOptions {
  allowReturn?: boolean;
  reason?: string;
  banDays?: number;
  ruleIndex?: number;
}

/** The only roles `setMemberRole` can assign — `owner` is not grantable here
 * (ownership moves through `transferOwnership`; see `UpdateCommunityMemberRoleDto`).
 * `co_owner` is grantable, by the owner alone. */
export type AssignableRole =
  RosterRole.Member | RosterRole.Mod | RosterRole.CoOwner;

@Injectable()
export class CommunitiesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    @InjectRepository(CommunityTagRequest)
    private readonly tagRequests: Repository<CommunityTagRequest>,
    // Written by `removeMember` (a removal bars the return by default) and
    // read by `join` before any other gate. Only the WRITE and the enforcing
    // READ live here; listing and lifting bans is a separate surface.
    @InjectRepository(CommunityBan)
    private readonly bans: Repository<CommunityBan>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // For the house-account guardrail on `transferOwnership` (a `User.isSystem`
    // account can never be handed a community). The repo is available via
    // `UsersModule`'s exported `TypeOrmModule` (no extra `forFeature` needed).
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly contentModeration: ContentModerationService,
    private readonly notifications: NotificationsService,
    // `suggestedCommunities`'s social-graph signal: the viewer's accepted
    // connections. See that method's doc comment for why connections (not
    // tags) is the real signal here.
    private readonly connectionsService: ConnectionsService,
    // Batched crop lookup (`MediaCropService.getMany`) for `coverImageUrl`'s
    // sibling `coverCrop`.
    private readonly mediaCropService: MediaCropService,
    // Governance audit trail (`community_governance_log`) — every roster/
    // lifecycle action this service performs (role change, removal,
    // ownership transfer, archive, freeze/unfreeze) writes one entry.
    private readonly governanceLog: CommunityGovernanceLogService,
    // The freeze side of `unfreeze`'s gate: an AUTOMATIC freeze may only be
    // lifted once this service's own open-report count for the community
    // reaches zero (BE-COM-04). Same provider, same module — no cycle
    // (`CommunityAutoFreezeService` depends only on repos, the governance log
    // and notifications).
    private readonly autoFreeze: CommunityAutoFreezeService,
    // Fires `COMMUNITY_MEMBER_JOINED`/`COMMUNITY_MEMBER_LEFT` off every roster
    // add/remove path below, for `MembershipCardListener` (membership cards)
    // to keep a community's card programme in step with who is actually on
    // the roster. Same fire-and-forget `emit` idiom as `COMMUNITY_POST_CREATED`
    // in `CommunityPostsService`.
    private readonly eventEmitter: EventEmitter2,
    // PRD-25. A removal that bars the return FOREVER now opens a hold for a
    // second owner, co-owner or moderator to sign. Same provider, same module,
    // no cycle: `CommunityBanRatificationService` depends only on repositories,
    // the governance log and notifications, and never on this service.
    private readonly banRatifications: CommunityBanRatificationService,
  ) {}

  private readonly logger = new Logger(CommunitiesService.name);

  // A community is taken down under the `community` taxonomy code, keyed by its
  // slug (matching the report `subjectId`).
  private static readonly SUBJECT_TYPE = 'community';

  /**
   * THE COMMUNITY PERMISSION MODEL, in one place, so the next reader does not
   * have to re-derive it from a dozen role comparisons.
   *
   * There are three tiers, and every check in this file is one of them:
   *
   *  1. `isStaffRole` (owner, co-owner, mod) is the MODERATION gate. It is
   *     what lets someone see an archived or moderated community, freeze and
   *     unfreeze it, edit its settings, triage join requests, and remove a
   *     plain member.
   *  2. `isOwnerLevelRole` (owner, co-owner) is the GOVERNANCE gate. It is
   *     what the owner alone used to hold: changing `accessTier` and
   *     `rosterVisible` (the community's privacy promise), and acting on a
   *     moderator (removing one, or changing their role). Handing those to a
   *     trusted second person is the entire point of the co-owner role.
   *  3. A bare `role === RosterRole.Owner`, or `assertOwner` (which reads
   *     `Community.ownerId`, the source of truth), is the OWNER-ONLY gate.
   *     Exactly three powers stay here and a co-owner never reaches them:
   *     transferring ownership, archiving the community, and changing or
   *     removing an owner or a co-owner. Those three are the ones that decide
   *     who the owner is or whether the community continues to exist, so a
   *     co-owner can neither promote themselves out of the owner's reach nor
   *     unseat the person who granted them the role.
   *
   * `Community.ownerId` still holds exactly one accountable owner of record.
   * A co-owner is never the community's owner, and promoting one is still an
   * explicit ownership transfer.
   */
  private static isStaffRole(role: RosterRole | null): boolean {
    return (
      role === RosterRole.Owner ||
      role === RosterRole.CoOwner ||
      role === RosterRole.Mod
    );
  }

  /** Tier 2 of the model above: owner-level powers, held by the owner and by
   *  a co-owner. See `isStaffRole`'s comment for the full matrix. */
  private static isOwnerLevelRole(role: RosterRole | null): boolean {
    return role === RosterRole.Owner || role === RosterRole.CoOwner;
  }

  /**
   * Whether a community at this access tier may be publicly listed at all
   * (`Community.isPubliclyListed`, the signed-out teaser).
   *
   * Only `public` and `request` qualify. An `invite` or `private` community
   * is one whose very existence is not meant to be findable by a stranger, so
   * "listed but invite-only" is a contradiction rather than a configuration.
   * Both write paths lean on this: `create`/`update` refuse to set the flag
   * true at a disqualifying tier, and `update` forces it back to false when
   * the tier itself moves to one.
   */
  private static isPublicListingAllowedAtTier(tier: AccessTier): boolean {
    return tier === AccessTier.Public || tier === AccessTier.Request;
  }

  /** 400 rather than a silent drop: a client that asked to be listed and was
   *  quietly left unlisted would show the owner a switch that lies. */
  private static assertPublicListingAllowed(tier: AccessTier): void {
    if (!CommunitiesService.isPublicListingAllowedAtTier(tier)) {
      throw new BadRequestException(
        'A community can only be publicly listed while its access tier is public or request. Change the tier first, or leave it unlisted.',
      );
    }
  }

  /** The roles that are the community's staff for notification fan-out and
   *  for the moderated-listing exemption. Same set as `isStaffRole`. */
  private static readonly STAFF_ROLES: RosterRole[] = [
    RosterRole.Owner,
    RosterRole.CoOwner,
    RosterRole.Mod,
  ];

  // Excludes moderator-taken-down communities from a browse/search query, in
  // the query itself so the paginated `total` stays consistent with the rows
  // returned. A community's own owner/mod (`m.role`) still sees it — the
  // moderated-away card is withheld from members and non-members only. Assumes
  // the querybuilder has joined `CommunityMember` as `m` on the viewer (both
  // `list` and `searchByText` do).
  private excludeModeratedCommunities(
    communitiesQuery: SelectQueryBuilder<Community>,
  ): void {
    communitiesQuery.andWhere(
      `(NOT EXISTS (
          SELECT 1 FROM "content_moderation" "cm"
          WHERE "cm"."subject_type" = :communitySubjectType
            AND "cm"."subject_id" = c.slug
            AND ("cm"."hidden_at" IS NOT NULL OR "cm"."removed_at" IS NOT NULL)
        ) OR m.role IN (:...communityStaffRoles))`,
      {
        communitySubjectType: CommunitiesService.SUBJECT_TYPE,
        communityStaffRoles: CommunitiesService.STAFF_ROLES,
      },
    );
  }

  async create(
    ownerId: string,
    dto: CreateCommunityInput,
  ): Promise<CommunityDetailDTO> {
    // Refused before anything is written: a community created `invite` or
    // `private` can never be publicly listed, exactly as `update` enforces.
    if (dto.isPubliclyListed) {
      CommunitiesService.assertPublicListingAllowed(dto.accessTier);
    }

    // Resolved BEFORE the create transaction opens: neither list writes
    // anything any more (see `resolveInvitees`), so there is no reason to
    // re-resolve them on each retry of that transaction.
    const { stewardUserIds, invitedUserIds } = await this.resolveInvitees(
      ownerId,
      dto.stewards ?? [],
      dto.invites ?? [],
    );

    const saved = await this.createWithUniqueRef(ownerId, dto);

    // The owner's own roster row is written inside `createWithUniqueRef`'s
    // transaction (see that method) — this fires only after it has
    // committed, same "after the create transaction has committed" timing as
    // `notifyInvitees` below.
    this.eventEmitter.emit(COMMUNITY_MEMBER_JOINED, {
      communityId: saved.id,
      userId: ownerId,
    } satisfies CommunityMemberJoinedEvent);

    // Best-effort, after the create transaction has committed — see
    // `notifyInvitees`.
    await this.notifyInvitees(saved, ownerId, invitedUserIds, stewardUserIds);

    // The creator is always 'owner' right after creation — skip the extra
    // roster lookup `buildDetail` would otherwise do.
    return this.buildDetail(saved, ownerId, RosterRole.Owner);
  }

  // The slug pre-check can lose a race to a concurrent create landing between
  // the read and this INSERT; the unique index on `slug` is the real backstop
  // and turns that race into a 23505. A 23505 aborts the whole transaction
  // (Postgres poisons it on any statement error), so the retry has to re-run
  // the *entire* transaction with a freshly allocated slug, not just the
  // failed insert. Mirrors `EventsService.saveWithUniqueSlug`'s retry loop,
  // generalized from a single `.save()` to the whole create transaction.
  //
  // `ref` no longer participates in that race at all: it comes from the
  // `communities_ref_seq` sequence (BE-COM-23), which is concurrency-safe by
  // construction.
  private async createWithUniqueRef(
    ownerId: string,
    dto: CreateCommunityInput,
  ): Promise<Community> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle, 'community'),
        (s) => this.communities.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const communitiesRepo = manager.getRepository(Community);
          const membersRepo = manager.getRepository(CommunityMember);

          // Sequential ref (`QP-C-0004`, ...), per the brief — allocated from
          // `communities_ref_seq`
          // (`1793620200000-AddCommunitiesRefSequence`) rather than
          // `COUNT(*) + 1` (BE-COM-23). `nextval` never hands the same number
          // to two concurrent creates, and it is independent of how many rows
          // exist, so a hard-deleted community can no longer make every future
          // create collide on `UQ_communities_ref`.
          //
          // The trade-off is gaps: sequence advancement is deliberately not
          // rolled back, so a create that fails after this point burns its
          // number. A ref is an opaque handle, not a count of communities.
          //
          // `nextval` returns bigint, which the pg driver hands back as a
          // string — `padStart` takes it as-is, no Number round-trip.
          const [refRow] = await manager.query<{ refNumber: string }[]>(
            `SELECT nextval('communities_ref_seq') AS "refNumber"`,
          );
          // `nextval` always returns exactly one row, but the destructure is
          // typed as possibly-undefined, and silently falling back to a
          // hardcoded ref would reintroduce the collision this sequence
          // exists to prevent. Fail instead.
          if (!refRow) {
            throw new Error('communities_ref_seq returned no row');
          }
          const ref = `QP-C-${refRow.refNumber.padStart(4, '0')}`;

          const community = await communitiesRepo.save(
            communitiesRepo.create({
              slug,
              name: dto.name,
              purpose: dto.purpose,
              type: dto.type,
              whoFor: dto.whoFor,
              tagline: dto.tagline,
              accessTier: dto.accessTier,
              rosterVisible: dto.rosterVisible,
              features: dto.features,
              rules: dto.rules,
              tags: dto.tags ?? [],
              coverImageUrl: dto.coverImageUrl ?? null,
              avatarImageUrl: dto.avatarImageUrl || null,
              // Free text from a member-facing form: stripped of markup once,
              // here at the write boundary, so no render site has to. An
              // empty result stores as NULL rather than an empty string.
              welcomeMessage: toStoredPlainTextOrNull(dto.welcomeMessage),
              city: toStoredPlainTextOrNull(dto.city),
              area: toStoredPlainTextOrNull(dto.area),
              isOnline: dto.isOnline ?? false,
              languages: dto.languages ?? [],
              // Guarded against the tier above (see
              // `assertPublicListingAllowed`), and off unless the creator
              // deliberately asked for it.
              isPubliclyListed: dto.isPubliclyListed ?? false,
              ownerId,
              ref,
            }),
          );

          // The creator's own roster row is the ONLY membership this
          // transaction writes. `stewards`/`invites` are both invitations now
          // (see `resolveInvitees`), never consent-less roster adds.
          await membersRepo.save(
            membersRepo.create({
              communityId: community.id,
              userId: ownerId,
              role: RosterRole.Owner,
            }),
          );

          return community;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the ref/slug race — recompute both and retry a fresh
            // transaction (the aborted one can't be resumed).
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique community ref',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved community or throws above.
    throw new ConflictException('Could not allocate a unique community ref');
  }

  /**
   * The browse WHERE clause: the viewer's visibility gates plus every
   * `GET /communities` filter, as a query builder with no ordering and no
   * pagination.
   *
   * Returns a FRESH builder every call — the page read and the facet read both
   * mutate what they are handed, so they cannot share one.
   *
   * `skip` lifts one filter group so that group's own availability counts can
   * be taken from everything else (the member directory's
   * `directoryBaseQuery(q, viewer, skip)` is the same contract). Only `tags`
   * carries counts today.
   */
  private browseBaseQuery(
    viewerId: string,
    query: CommunityListQuery,
    skip?: 'tags',
  ): SelectQueryBuilder<Community> {
    const filter = query.filter ?? 'discover';

    const communitiesQuery = this.communities.createQueryBuilder('c');

    if (filter === 'mine') {
      communitiesQuery.innerJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      );
    } else {
      // 'discover' — a LEFT JOIN so a non-member row still surfaces (as long
      // as it isn't private); a member always sees their own communities
      // regardless of tier.
      communitiesQuery
        .leftJoin(
          CommunityMember,
          'm',
          'm.community_id = c.id AND m.user_id = :viewerId',
          { viewerId },
        )
        .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
          privateTier: AccessTier.Private,
          viewerId,
        });
    }

    if (query.type) {
      communitiesQuery.andWhere('c.type = :type', { type: query.type });
    }
    if (query.access) {
      communitiesQuery.andWhere('c.access_tier = :access', {
        access: query.access,
      });
    }
    if (query.q) {
      // ANDed onto the existing filters (not a replacement) — mirrors
      // `searchByText`'s ILIKE clause over the same three columns.
      const pattern = `%${escapeLikeTerm(query.q)}%`;
      communitiesQuery.andWhere(
        '(c.name ILIKE :qPattern OR c.tagline ILIKE :qPattern OR c.purpose ILIKE :qPattern)',
        { qPattern: pattern },
      );
    }
    // Exact city match, case-insensitively, so "Lisbon" and "lisbon" are the
    // same place. `LOWER()` on both sides means the plain btree
    // `IDX_communities_city` cannot serve this predicate; a functional index
    // on `LOWER(city)` is the follow-up if the filter ever gets hot, and that
    // needs a migration this task does not own.
    if (query.city) {
      communitiesQuery.andWhere('LOWER(c.city) = LOWER(:city)', {
        city: query.city,
      });
    }
    // Language filter: the community's `languages` array must CONTAIN the
    // requested code. Array overlap (`&&`) against the GIN-indexed column
    // (`IDX_communities_languages`), the same operator and shape the tag
    // filter below uses. An unknown code cannot match anything, so it matches
    // nothing rather than quietly returning the unfiltered list.
    if (query.language) {
      const languages = knownLanguages([query.language]);
      if (!languages.length) {
        communitiesQuery.andWhere('1 = 0');
      } else {
        communitiesQuery.andWhere('c.languages && :languages', { languages });
      }
    }
    // Both directions are real answers here: `false` narrows to communities
    // that meet in person, it does not mean "no filter" (see
    // `ListCommunitiesQuery.online`).
    if (query.online !== undefined) {
      communitiesQuery.andWhere('c.is_online = :isOnline', {
        isOnline: query.online,
      });
    }
    // Curated tag filter. Plain array-overlap against the GIN-indexed
    // `communities.tags` (see `AddCommunityTags`), same shape as
    // `ProfilesService.searchMembers`'s `?tags=`/`?disciplines=` filters.
    // Unknown ids are dropped; if EVERY id was unknown the caller asked for a
    // tag that cannot exist, so match nothing rather than silently returning
    // the unfiltered list.
    // Lifted entirely when this query is the one counting the tag facets —
    // see `countCommunityTagFacets` for why a tag's own count cannot be taken
    // through its own predicate.
    if (skip !== 'tags') {
      const tags = knownCommunityTags(csv(query.tags));
      if (csv(query.tags).length) {
        if (!tags.length) {
          communitiesQuery.andWhere('1 = 0');
        } else {
          communitiesQuery.andWhere('c.tags && :tags', { tags });
        }
      }
    }
    // An archived community leaves every listing (discover AND mine) — it has
    // been taken down by its owner, so it should stop surfacing anywhere a card
    // is rendered, exactly like the moderated-away exclusion just below.
    communitiesQuery.andWhere('c.archived_at IS NULL');
    this.excludeModeratedCommunities(communitiesQuery);

    return communitiesQuery;
  }

  async list(
    viewerId: string,
    query: CommunityListQuery,
  ): Promise<
    Paginated<CommunityCardDTO> & { facets: CommunityBrowseFacetCounts }
  > {
    const page = normalizePage(query.page);
    const communitiesQuery = this.browseBaseQuery(viewerId, query);
    // 'name' ties (names aren't unique) get a stable, deterministic
    // secondary key so pagination doesn't reshuffle rows across pages.
    if (query.sort === 'name') {
      communitiesQuery.orderBy('c.name', 'ASC').addOrderBy('c.id', 'ASC');
    } else if (query.sort === 'active') {
      // Liveliness first, served straight off the indexed
      // `communities.active_this_week` counter. Ties are dense here (every
      // quiet community sits at 0), so the tiebreak matters more than it does
      // for 'name': newest first, then `id`, which is unique and therefore
      // makes the total order deterministic across pages.
      communitiesQuery
        .orderBy('c.activeThisWeek', 'DESC')
        .addOrderBy('c.createdAt', 'DESC')
        .addOrderBy('c.id', 'ASC');
    } else {
      communitiesQuery.orderBy('c.createdAt', 'DESC');
    }

    // The page and the tag aggregate are independent reads of the same
    // committed snapshot, so they go out together rather than in series.
    const [pageOfCards, tags] = await Promise.all([
      paginate(communitiesQuery, page, async (rows) => {
        if (!rows.length) return [];
        const communityIds = rows.map((community) => community.id);
        const [stats, myRoles] = await Promise.all([
          this.statsForMany(communityIds),
          this.myRoleByCommunity(communityIds, viewerId),
        ]);
        return rows.map((community) =>
          toCommunityCard(
            community,
            stats.get(community.id) ?? EMPTY_STATS,
            myRoles.get(community.id) ?? null,
          ),
        );
      }),
      countCommunityTagFacets(this.browseBaseQuery(viewerId, query, 'tags')),
    ]);
    return { ...pageOfCards, facets: { tags } };
  }

  /**
   * `GET /communities/featured` — the single admin-chosen community the
   * Discover page's hero card shows (`AdminCommunitiesService.updateSettings`
   * is the only writer of `is_featured`, enforced as a singleton there).
   * `null` when no community is currently featured, or when the featured
   * community is archived/moderated-away/private-to-someone-else — this
   * reuses `list()`'s own visibility rule rather than a bare `findOne` so the
   * hero card never leaks a private community to a non-member.
   */
  async getFeatured(viewerId: string): Promise<CommunityCardDTO | null> {
    const featuredCommunityQuery = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .andWhere('c.is_featured = true')
      .andWhere('c.archived_at IS NULL')
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      });
    this.excludeModeratedCommunities(featuredCommunityQuery);

    const community = await featuredCommunityQuery.getOne();
    if (!community) return null;

    const [stats, myRoles] = await Promise.all([
      this.statsForMany([community.id]),
      this.myRoleByCommunity([community.id], viewerId),
    ]);
    return toCommunityCard(
      community,
      stats.get(community.id) ?? EMPTY_STATS,
      myRoles.get(community.id) ?? null,
    );
  }

  // Cross-entity global search (SearchService) — mirrors `list()`'s visibility
  // rule (private communities are only visible to their own members) and its
  // batched stats/role hydration. ILIKE over name / tagline / purpose.
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<CommunityCardDTO[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const matchingCommunitiesQuery = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      })
      .andWhere(
        '(c.name ILIKE :pattern OR c.tagline ILIKE :pattern OR c.purpose ILIKE :pattern)',
        { pattern },
      )
      .andWhere('c.archived_at IS NULL');
    this.excludeModeratedCommunities(matchingCommunitiesQuery);
    const rows = await matchingCommunitiesQuery
      .orderBy('c.name', 'ASC')
      .take(limit)
      .getMany();

    if (!rows.length) return [];
    const communityIds = rows.map((community) => community.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(communityIds),
      this.myRoleByCommunity(communityIds, viewerId),
    ]);
    return rows.map((community) =>
      toCommunityCard(
        community,
        stats.get(community.id) ?? EMPTY_STATS,
        myRoles.get(community.id) ?? null,
      ),
    );
  }

  /**
   * `GET /communities/:slug/related` — up to 4 OTHER communities sharing at
   * least one curated tag with this one, ranked by overlap count (highest
   * first). If the source community has no tags at all, returns `[]` rather
   * than falling back to some other ranking — an untagged community has no
   * tag-based notion of "related" to compute.
   *
   * Same visibility posture as `list()`/`searchByText`: a private community
   * only surfaces to its own members, archived/moderated-away communities
   * never surface. `viewerId` also drives `myRole` on each returned card,
   * same as every other card-producing method here.
   *
   * The overlap count is computed with `cardinality(ARRAY(... INTERSECT
   * ...))` rather than a bespoke intersection operator — Postgres has no
   * built-in array-intersection operator (`&&` only tests *whether* two
   * arrays overlap, not by how much), so the exact count needs this
   * unnest/INTERSECT idiom. The `c.tags && :tags` filter runs first and can
   * use the existing GIN index (`AddCommunityTags`) to narrow candidates
   * before the per-row cardinality is computed and sorted on.
   */
  async relatedCommunities(
    slug: string,
    viewerId: string,
  ): Promise<CommunityCardDTO[]> {
    const community = await this.loadOr404(slug);
    if (!community.tags.length) return [];

    const relatedCommunitiesQuery = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :viewerId',
        { viewerId },
      )
      .where('c.id != :id', { id: community.id })
      .andWhere('c.tags && :tags', { tags: community.tags })
      .andWhere('c.archived_at IS NULL')
      .andWhere('(c.access_tier != :privateTier OR m.user_id = :viewerId)', {
        privateTier: AccessTier.Private,
        viewerId,
      });
    this.excludeModeratedCommunities(relatedCommunitiesQuery);

    relatedCommunitiesQuery
      .addSelect(
        'cardinality(ARRAY(SELECT unnest(c.tags) INTERSECT SELECT unnest(CAST(:tags AS text[]))))',
        'overlap',
      )
      .orderBy('overlap', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .take(4);

    const rows = await relatedCommunitiesQuery.getMany();
    if (!rows.length) return [];

    const communityIds = rows.map((community) => community.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(communityIds),
      this.myRoleByCommunity(communityIds, viewerId),
    ]);
    return rows.map((community) =>
      toCommunityCard(
        community,
        stats.get(community.id) ?? EMPTY_STATS,
        myRoles.get(community.id) ?? null,
      ),
    );
  }

  /**
   * `GET /communities/suggested` — up to `SUGGESTED_COMMUNITIES_LIMIT`
   * communities the viewer hasn't joined that people in their SOCIAL GRAPH
   * have joined, ranked by how many of those connections are on each
   * community's roster (most-connected-in first).
   *
   * The signal is the viewer's ACCEPTED `connections` graph — not
   * `Community.tags`/`Profile.tags` (a tag-based version was investigated and
   * rejected: there's no real vocabulary bridge between free-text profile
   * tags and curated community tags). "Who is this member connected to" is
   * `ConnectionsService.allAcceptedConnectionUserIds`, the same uncapped,
   * id-only accepted-connection read `EventsService`'s `network`-visibility
   * gate reuses — uncapped (unlike the 200-capped
   * `getAcceptedConnectionUserIds`, fine for a rendered list but wrong here:
   * truncating a viewer's own connections would silently under-rank or drop a
   * community their 201st+ connection is in).
   *
   * If the viewer has no accepted connections, or none of those connections
   * belong to any community the viewer hasn't already joined, this returns
   * `[]` — no fallback ranking. Same "no signal = empty, don't guess" posture
   * as `relatedCommunities`.
   *
   * Visibility mirrors `list()`/`relatedCommunities()`: archived and
   * moderator-taken-down communities never surface (`excludeModeratedCommunities`),
   * and since every candidate here is, by construction, a community the
   * viewer has NOT joined (`m.user_id IS NULL`), the private-tier exclusion
   * `list()` expresses as "`private` OR I'm a member" collapses to a flat
   * `access_tier != private` — a private community the viewer isn't in can
   * never be a legitimate suggestion.
   *
   * The connection-overlap count is a correlated-subquery `COUNT(DISTINCT
   * ...)` over `community_members`, mirroring `relatedCommunities`'s own
   * addSelect-a-raw-expression-then-ORDER-BY-its-alias shape (there it's
   * `cardinality(ARRAY(... INTERSECT ...))` for tag overlap; here it's a
   * membership-count subquery). `community_members` already carries a unique
   * composite index on `(community_id, user_id)` (`UQ_community_members`),
   * which backs both the `EXISTS` candidate filter and the `COUNT` — no new
   * index needed.
   */
  async suggestedCommunities(userId: string): Promise<CommunityCardDTO[]> {
    const connectionIds =
      await this.connectionsService.allAcceptedConnectionUserIds(userId);
    if (!connectionIds.length) return [];

    const suggestedCommunitiesQuery = this.communities
      .createQueryBuilder('c')
      .leftJoin(
        CommunityMember,
        'm',
        'm.community_id = c.id AND m.user_id = :userId',
        { userId },
      )
      .where('m.user_id IS NULL') // the viewer hasn't joined this one
      .andWhere('c.archived_at IS NULL')
      .andWhere('c.access_tier != :privateTier', {
        privateTier: AccessTier.Private,
      })
      .andWhere(
        `EXISTS (
          SELECT 1 FROM "community_members" "cm"
          WHERE "cm"."community_id" = c.id AND "cm"."user_id" IN (:...connectionIds)
        )`,
        { connectionIds },
      );
    this.excludeModeratedCommunities(suggestedCommunitiesQuery);

    // The alias MUST be lower-case and the `orderBy` criteria MUST be the bare
    // alias with no quotes of its own, exactly as `relatedCommunities` does
    // with `overlap`. `.take()` + a join sends TypeORM down its two-query
    // "distinct ids" path, which rebuilds the ORDER BY by looking the criteria
    // string up against the registered select ALIASES. A quoted
    // `'"connectionCount"'` matches no alias, so that lookup yields an empty
    // select entry and the outer query is emitted as
    // `SELECT DISTINCT ...ids_c_id, , "distinctAlias"."c_created_at"`: a
    // doubled comma, i.e. `syntax error at or near ","`. Unquoted camelCase
    // would clear that hurdle and then fail in the second query, where
    // Postgres folds the bare identifier to `connectioncount` and never finds
    // the `"connectionCount"` output alias. Lower-case + unquoted is the only
    // spelling that survives both.
    suggestedCommunitiesQuery
      .addSelect(
        `(SELECT COUNT(DISTINCT "cm2"."user_id") FROM "community_members" "cm2"
        WHERE "cm2"."community_id" = c.id AND "cm2"."user_id" IN (:...connectionIds))`,
        'connection_count',
      )
      .orderBy('connection_count', 'DESC')
      .addOrderBy('c.createdAt', 'DESC')
      .take(SUGGESTED_COMMUNITIES_LIMIT);

    const rows = await suggestedCommunitiesQuery.getMany();
    if (!rows.length) return [];

    const communityIds = rows.map((community) => community.id);
    const [stats, myRoles] = await Promise.all([
      this.statsForMany(communityIds),
      this.myRoleByCommunity(communityIds, userId),
    ]);
    return rows.map((community) =>
      toCommunityCard(
        community,
        stats.get(community.id) ?? EMPTY_STATS,
        myRoles.get(community.id) ?? null,
      ),
    );
  }

  async getBySlug(slug: string, viewerId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);
    // Private + non-member -> 404, not 403, so existence isn't leaked.
    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }
    // A moderator takedown 404s the detail for everyone but the community's own
    // owner/mod — same "don't leak existence" posture as the private-tier gate.
    const moderation = await this.contentModeration.stateFor(
      CommunitiesService.SUBJECT_TYPE,
      community.slug,
    );
    if (
      (moderation.hidden || moderation.removed) &&
      !CommunitiesService.isStaffRole(role)
    ) {
      throw new NotFoundException('Community not found');
    }
    // An archived community 404s for everyone but its own owner/mods — same
    // "don't leak existence" posture as the private-tier and takedown gates.
    // Staff still get the detail (with `archived: true`) so the mod panel can
    // render the archived state rather than "not found".
    if (community.archivedAt != null && !CommunitiesService.isStaffRole(role)) {
      throw new NotFoundException('Community not found');
    }
    return this.buildDetail(community, viewerId, role, moderation);
  }

  /**
   * `PATCH /communities/:slug` — edit the community's settings.
   *
   * Owner/mod for most fields, OWNER-LEVEL (owner or co-owner) for
   * `accessTier`, `rosterVisible` and `isPubliclyListed` (BE-COM-22). Those
   * three are the community's privacy promise: flipping `private` to `public`
   * exposes the roster and every post at once, and listing it publicly makes
   * it findable by people who are not on this platform. That is the same
   * class of act as archiving or transferring it, and those are already
   * owner-only. An archived community takes no edits at
   * all — it is down for everyone but its own staff, and editing it would
   * quietly reshape something no member can see.
   *
   * Every effective change is written to `community_governance_log` with its
   * before/after diff. This was the only mutating community route with no
   * audit entry, so an access-tier change left nothing behind for a member
   * asking "who made this public?".
   */
  async update(
    slug: string,
    userId: string,
    dto: UpdateCommunityInput,
  ): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const actorMembership = await this.assertOwnerOrMod(community.id, userId);

    if (community.archivedAt != null) {
      throw new ConflictException(
        'An archived community cannot be edited. Unarchive it first.',
      );
    }

    // Shared-upload backstop (see `assertNoForeignUploadIntroduced`): this
    // community is edited by every owner/moderator, so the interceptor exempts
    // it and lets a co-editor re-save the currently stored cover whoever
    // uploaded it. Runs BEFORE any mutation and draws the line the interceptor
    // cannot: a foreign cover is allowed only when it is already the stored
    // value, so a co-editor cannot point the field at a new foreign upload.
    assertNoForeignUploadIntroduced(userId, dto.coverImageUrl, [
      community.coverImageUrl,
    ]);
    // Same backstop for the avatar, which rides the same exempted handler.
    assertNoForeignUploadIntroduced(userId, dto.avatarImageUrl, [
      community.avatarImageUrl,
    ]);

    // Tier 2 of the permission model (see `isStaffRole`): `accessTier` and
    // `rosterVisible` are the community's privacy promise, so a plain mod
    // still cannot touch them, but a CO-OWNER can. Handing exactly this to a
    // trusted second person is what the co-owner role is for.
    const hasOwnerLevelPowers = CommunitiesService.isOwnerLevelRole(
      actorMembership.role,
    );
    if (
      !hasOwnerLevelPowers &&
      ((dto.accessTier !== undefined &&
        dto.accessTier !== community.accessTier) ||
        (dto.rosterVisible !== undefined &&
          dto.rosterVisible !== community.rosterVisible) ||
        // `isPubliclyListed` sits on this side of the line for the same
        // reason: it decides whether a stranger who is not on this platform
        // can see the community exists at all. That is a privacy decision on
        // an invite-only platform, so a plain moderator cannot make it.
        (dto.isPubliclyListed !== undefined &&
          dto.isPubliclyListed !== community.isPubliclyListed))
    ) {
      throw new ForbiddenException(
        'Only an owner or co-owner can change who can see or join this community',
      );
    }

    // THE PUBLIC-LISTING INVARIANT, in one place.
    //
    // A community may only be publicly listed while its access tier is
    // `public` or `request`. Two things follow, and both are enforced here:
    //
    //  1. Asking to be listed at a disqualifying tier is a 400, never a
    //     silently-dropped field.
    //  2. A TIER CHANGE MUST NEVER LEAVE A PRIVATE COMMUNITY PUBLICLY LISTED.
    //     Moving to `invite` or `private` forces `isPubliclyListed` back to
    //     false IN THE SAME UPDATE, whether or not the client mentioned the
    //     flag. Anything else would leave the teaser standing for a community
    //     that just closed its doors, which is the exact failure this
    //     invariant exists to prevent.
    const nextAccessTier = dto.accessTier ?? community.accessTier;
    const isListingAllowed =
      CommunitiesService.isPublicListingAllowedAtTier(nextAccessTier);
    if (dto.isPubliclyListed === true) {
      CommunitiesService.assertPublicListingAllowed(nextAccessTier);
    }
    const requestedPubliclyListed =
      dto.isPubliclyListed ?? community.isPubliclyListed;
    const nextPubliclyListed = isListingAllowed
      ? requestedPubliclyListed
      : false;

    // A rules edit that actually changes the text bumps `rulesVersion`, and
    // that bump is what re-prompts the existing roster: every member's
    // `rulesVersionAccepted` then trails the community's, which the detail
    // response surfaces as `rulesAcceptedVersion`. Compared by contents so
    // re-saving the same array (the common case when a form echoes every
    // field back) leaves the version alone and nobody is asked to re-agree to
    // rules that did not move. Reordering the list DOES count as a change: the
    // order rules are read in is part of what a member agreed to.
    const shouldBumpRulesVersion =
      dto.rules !== undefined &&
      !CommunitiesService.sameStringList(community.rules, dto.rules);

    const next = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.whoFor !== undefined ? { whoFor: dto.whoFor } : {}),
      ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}),
      ...(dto.accessTier !== undefined ? { accessTier: dto.accessTier } : {}),
      ...(dto.rosterVisible !== undefined
        ? { rosterVisible: dto.rosterVisible }
        : {}),
      ...(dto.features !== undefined ? { features: dto.features } : {}),
      ...(dto.rules !== undefined ? { rules: dto.rules } : {}),
      ...(shouldBumpRulesVersion
        ? { rulesVersion: community.rulesVersion + 1 }
        : {}),
      ...(dto.tags !== undefined ? { tags: dto.tags } : {}),
      // '' from the client (cleared field) normalizes to NULL so an empty
      // cover reads back as "no cover", not an empty string.
      ...(dto.coverImageUrl !== undefined
        ? { coverImageUrl: dto.coverImageUrl || null }
        : {}),
      ...(dto.avatarImageUrl !== undefined
        ? { avatarImageUrl: dto.avatarImageUrl || null }
        : {}),
      // Plain-text fields: markup is stripped once here at the write
      // boundary, and a value that strips down to nothing stores as NULL.
      ...(dto.welcomeMessage !== undefined
        ? { welcomeMessage: toStoredPlainTextOrNull(dto.welcomeMessage) }
        : {}),
      ...(dto.city !== undefined
        ? { city: toStoredPlainTextOrNull(dto.city) }
        : {}),
      ...(dto.area !== undefined
        ? { area: toStoredPlainTextOrNull(dto.area) }
        : {}),
      ...(dto.isOnline !== undefined ? { isOnline: dto.isOnline } : {}),
      ...(dto.languages !== undefined ? { languages: dto.languages } : {}),
      // Included whenever the effective value moves, which covers both an
      // explicit toggle and the forced unlisting a tier change causes. Being
      // in `next` is also what puts it in the `settings_changed` diff: who
      // made this community visible to the whole internet, and when, is at
      // least as consequential as the access tier the log already singles
      // out.
      ...(nextPubliclyListed !== community.isPubliclyListed
        ? { isPubliclyListed: nextPubliclyListed }
        : {}),
    };
    // Diffed BEFORE the assign, against the loaded row, so the log records
    // what actually changed rather than every field the client happened to
    // echo back unchanged.
    const changes = CommunitiesService.diffSettings(community, next);

    Object.assign(community, next);
    const saved = await this.communities.save(community);

    if (Object.keys(changes).length) {
      await this.logGovernanceAction(
        community.id,
        userId,
        GovernanceLogAction.SettingsChanged,
        null,
        { changes },
      );
    }
    return this.buildDetail(saved, userId);
  }

  /**
   * Field-by-field `{ from, to }` diff of a settings patch against the row it
   * is about to be applied to — the `metadata` body of the
   * `settings_changed` governance-log entry. Array fields (`features`,
   * `rules`, `tags`) compare by contents, in order, which is how they are
   * stored and sent.
   */
  /** Contents-and-order equality for the string arrays this service diffs
   *  (`rules`, and any list compared the same way). Same comparison
   *  `diffSettings` applies, factored out because `update`'s `rulesVersion`
   *  bump has to make the identical call before the diff runs. */
  private static sameStringList(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private static diffSettings(
    community: Community,
    next: Record<string, unknown>,
  ): Record<string, { from: unknown; to: unknown }> {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, to] of Object.entries(next)) {
      const from = (community as unknown as Record<string, unknown>)[field];
      const unchanged = Array.isArray(from)
        ? Array.isArray(to) &&
          from.length === to.length &&
          from.every((value, index) => value === to[index])
        : from === to;
      if (!unchanged) changes[field] = { from, to };
    }
    return changes;
  }

  /**
   * `POST /communities/:slug/archive` — take the community down from the mod
   * panel's danger zone.
   *
   * OWNER-ONLY, deliberately stricter than the `owner/mod` gate `update` and
   * the roster routes use. Archiving takes the *whole community* down for every
   * member at once; letting a single moderator do that would be a takeover-by-
   * destruction — the same class of escalation the owner-immutability rules in
   * `removeMember`/`setMemberRole` exist to prevent. Ownership
   * (`Community.ownerId`) is the root of authority, so only the owner may pull
   * this lever.
   *
   * Idempotent: archiving an already-archived community is a no-op 200 (the
   * first `archivedAt` timestamp stands), matching this module's posture on
   * `join`, reaction-add and approve-triage. The owner is still staff, so the
   * returned detail carries `archived: true` rather than 404ing.
   */
  async archive(slug: string, userId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    this.assertOwner(community, userId);

    if (community.archivedAt == null) {
      community.archivedAt = new Date();
      await this.communities.save(community);
      await this.logGovernanceAction(
        community.id,
        userId,
        GovernanceLogAction.Archived,
      );
      await this.notifyRosterArchived(community, userId);
    }
    return this.buildDetail(community, userId, RosterRole.Owner);
  }

  /**
   * `POST /communities/:slug/freeze` — an owner or mod manually freezes a
   * community (e.g. ahead of a moderation review), symmetric to `unfreeze`.
   * Unlike `unfreeze`'s automatic-only counterpart (`CommunityAutoFreezeService`),
   * this action has a real human actor, so it's logged with `actorUserId`
   * set rather than `null`. Idempotent: freezing an already-frozen community
   * is a no-op 200. Uses the same atomic conditional-UPDATE guard (`frozen_at
   * IS NULL`) as `CommunityAutoFreezeService.maybeFreeze`, so a manual freeze
   * racing an automatic one (or a second manual call) can't double-log or
   * double-notify.
   *
   * The optional `note` is the moderator's short PUBLIC explanation, stored
   * in `frozenNote` and read back by every member off the community detail.
   * It exists because one generic sentence covered all three freeze reasons,
   * so a deliberate pause ("closed while we rewrite the rules") was announced
   * to members as a moderation review that was not happening. `frozenByUserId`
   * records who pulled the lever; an automatic freeze leaves it NULL, which is
   * how the two are told apart beyond `frozenReason`.
   */
  async freeze(
    slug: string,
    userId: string,
    input: FreezeCommunityInput = {},
  ): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, userId);
    if (!CommunitiesService.isStaffRole(role)) {
      throw new ForbiddenException(
        'Only an owner or mod can freeze a community',
      );
    }

    // Members read this, so it is stripped to plain text on the way in like
    // every other member-facing free-text field in this module.
    const frozenNote = toStoredPlainTextOrNull(input.note);

    if (community.frozenAt == null) {
      const result = await this.communities
        .createQueryBuilder()
        .update(Community)
        .set({
          frozenAt: () => 'now()',
          // Stamped with the marker so `unfreeze` can let the owner/mod lift
          // THEIR OWN freeze freely, while an automatic one stays gated on the
          // reports actually being handled (BE-COM-04).
          frozenReason: CommunityFrozenReason.Manual,
          frozenNote,
          frozenByUserId: userId,
        })
        .where('id = :id AND frozen_at IS NULL', { id: community.id })
        .execute();
      if (result.affected) {
        community.frozenAt = new Date();
        community.frozenReason = CommunityFrozenReason.Manual;
        community.frozenNote = frozenNote;
        community.frozenByUserId = userId;
        await this.logGovernanceAction(
          community.id,
          userId,
          GovernanceLogAction.Frozen,
          null,
          { reason: 'manual', note: frozenNote },
        );
        await this.notifyStaffFreezeChange(
          community,
          NotificationType.CommunityFrozen,
          userId,
          { reason: 'manual' },
        );
      }
    }
    return this.buildDetail(community, userId, role);
  }

  /**
   * `POST /communities/:slug/unfreeze` — an owner or mod lifts a freeze.
   * Idempotent — unfreezing a community that isn't frozen is a no-op 200
   * that just returns the current detail.
   *
   * The role check alone is not the whole gate (BE-COM-04). A freeze set by
   * `CommunityAutoFreezeService` is the platform's response to an
   * outing/doxxing report or a pile-up of open ones; letting the community's
   * own owner clear it in the next request made that control advisory, which
   * is the opposite of what it is for. So:
   *
   *  - `manual` — the owner/mod set it themselves; they may lift it whenever
   *    they like, no further condition.
   *  - `emergency_report` / `report_pileup` (and any legacy freeze with no
   *    recorded reason, treated as automatic — the conservative direction) —
   *    lifting requires the community's open reports to actually be at zero,
   *    which is what the Swagger text has always claimed ("once reports are
   *    handled") without anything enforcing it. Otherwise 409, and the freeze
   *    stands until a moderator resolves the reports or platform staff lifts
   *    it through `AdminCommunitiesService`.
   *
   * The count is `CommunityAutoFreezeService.openReportCount` — literally the
   * same query that decided to freeze, so the two sides can't drift apart.
   */
  async unfreeze(slug: string, userId: string): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, userId);
    if (!CommunitiesService.isStaffRole(role)) {
      throw new ForbiddenException(
        'Only an owner or mod can unfreeze a community',
      );
    }
    if (community.frozenAt != null) {
      if (community.frozenReason !== CommunityFrozenReason.Manual) {
        const openReports = await this.autoFreeze.openReportCount(community);
        if (openReports > 0) {
          throw new ConflictException(
            'This community was frozen by moderation. It can be unfrozen once its open reports have been resolved.',
          );
        }
      }
      community.frozenAt = null;
      community.frozenReason = null;
      // The note and the actor belong to the freeze that just ended. Leaving
      // them behind would show members a stale explanation for a community
      // that is no longer paused.
      community.frozenNote = null;
      community.frozenByUserId = null;
      await this.communities.save(community);
      await this.logGovernanceAction(
        community.id,
        userId,
        GovernanceLogAction.Unfrozen,
      );
      await this.notifyStaffFreezeChange(
        community,
        NotificationType.CommunityUnfrozen,
        userId,
      );
    }
    return this.buildDetail(community, userId, role);
  }

  /**
   * `POST /communities/:slug/transfer` — hand ownership to another member.
   *
   * Guardrails, in the order enforced below (mirrors `AdminMembersService
   * .updateRole`'s house-account + self-action posture, and this module's own
   * owner invariants):
   *
   *  1. **Actor must be the CURRENT owner.** Not owner-or-mod: transferring the
   *     community away is the single most consequential act on it, and only its
   *     root of authority (`Community.ownerId`) may perform it. A mod attempting
   *     it gets Forbidden.
   *  2. **Target must be a member of this community.** Unknown slug, or a member
   *     of some other community, both 404 `Member not found` — same as
   *     `setMemberRole`/`removeMember`.
   *  3. **No self-transfer.** Handing the community to yourself is a no-op the
   *     caller almost certainly didn't mean; 400 rather than silently succeed.
   *  4. **No transfer to the house account.** A `User.isSystem` account is a
   *     non-human platform account that never rides a permission path; making
   *     it a community owner would strand the community under an account no one
   *     signs in as. Mirrors the immovable-house-account rule in admin role
   *     management.
   *
   * The swap runs in one transaction: `Community.ownerId` moves to the target,
   * the target's roster row becomes `owner`, and the outgoing owner is demoted
   * to `mod` (they keep moderator reach and stay on the roster rather than being
   * orphaned). All three writes commit together or none do.
   */
  async transferOwnership(
    slug: string,
    actorId: string,
    memberSlug: string,
  ): Promise<CommunityDetailDTO> {
    const community = await this.loadOr404(slug);

    // 1. actor is the current owner
    this.assertOwner(community, actorId);

    // 2. target is on this roster
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }

    // 3. not a self-transfer (checked before the roster lookup below since the
    //    owner is trivially their own member)
    if (targetUserId === actorId) {
      throw new BadRequestException('You already own this community');
    }

    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    // 4. not the house account
    const targetUser = await this.users.findOne({
      where: { id: targetUserId },
      select: { id: true, isSystem: true },
    });
    if (targetUser?.isSystem) {
      throw new BadRequestException(
        'Ownership cannot be transferred to the house account',
      );
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const communitiesRepo = manager.getRepository(Community);
      const membersRepo = manager.getRepository(CommunityMember);

      community.ownerId = targetUserId;
      const savedCommunity = await communitiesRepo.save(community);

      // New owner's roster row -> owner.
      targetMembership.role = RosterRole.Owner;
      await membersRepo.save(targetMembership);

      // Outgoing owner stays on the roster, demoted to mod. Guarded on the row
      // still reading `owner` so a retry can't double-demote something already
      // moved.
      const actorMembership = await membersRepo.findOne({
        where: { communityId: community.id, userId: actorId },
      });
      if (actorMembership && actorMembership.role === RosterRole.Owner) {
        actorMembership.role = RosterRole.Mod;
        await membersRepo.save(actorMembership);
      }

      return savedCommunity;
    });

    await this.logGovernanceAction(
      community.id,
      actorId,
      GovernanceLogAction.OwnershipTransferred,
      targetUserId,
      { fromOwnerId: actorId },
    );
    await this.notifyOwnershipTransferred(community, actorId, targetUserId);

    // The actor is now a moderator of the community they handed off.
    return this.buildDetail(saved, actorId, RosterRole.Mod);
  }

  // `public` joins land on the roster instantly; every other tier
  // (`request`/`invite`/`private`) creates a pending `CommunityJoinRequest`
  // for an owner/mod to triage. Idempotent either way: already being on the
  // roster short-circuits to `joined` regardless of tier, so a repeat call
  // (or a UI double-click) never 500s.
  async join(
    slug: string,
    userId: string,
    dto: JoinCommunityInput,
  ): Promise<JoinResultDTO> {
    const community = await this.loadOr404(slug);

    // Bans are checked FIRST, before the roster short-circuit and before every
    // tier gate, because a ban applies to every access tier: the loop it exists
    // to close is exactly "removed from a public community, re-joins in one
    // tap". `community_bans` outlives the roster row that was deleted, which
    // is why it is a separate table (see `CommunityBan`).
    await this.assertNotBanned(community, userId);

    const existingMembership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (existingMembership) {
      return { outcome: 'joined', role: RosterRole.Member, request: null };
    }

    // Everything `getBySlug` 404s, this route must 404 too (BE-COM-17). It
    // used to check `frozenAt` and nothing else, so a caller could confirm a
    // private community exists purely from the status code (201 here vs 404
    // there), and staff of a private or archived community received
    // join-request notifications from people who should never have known it
    // was there. Existing members short-circuit above, so none of this
    // touches someone already on the roster.
    if (community.archivedAt != null) {
      throw new NotFoundException('Community not found');
    }
    if (community.accessTier === AccessTier.Private) {
      // No membership (checked above) and the tier is invitation-only —
      // exactly the case `getBySlug` refuses to confirm the existence of.
      throw new NotFoundException('Community not found');
    }
    const moderation = await this.contentModeration.stateFor(
      CommunitiesService.SUBJECT_TYPE,
      community.slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new NotFoundException('Community not found');
    }

    // A frozen community stays visible but takes no new members until an
    // owner/mod lifts the freeze (see `Community.frozenAt`). Existing members
    // short-circuit above, so this only blocks a genuinely new join.
    if (community.frozenAt) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }

    // A `not_now` (or `not_a_fit`) decline sets a date before which this
    // applicant may not apply again. Checked after the existence gates above,
    // so a wait period can never confirm a community the caller should not
    // know about.
    await this.assertReapplyWindowPassed(community, userId);

    // House rules are agreed to at the door, per version. A community with no
    // rules has nothing to accept and this is a no-op.
    CommunitiesService.assertRulesAccepted(community, dto.acceptedRulesVersion);

    // Second-vouch gate: a community that requires a vouch to join can only
    // instant-admit an applicant a current member has vouched for. An un-vouched
    // applicant to an otherwise-public community is routed to a reviewable
    // request rather than silently turned away — a mod (themselves a member)
    // can vouch, then approve. Request/invite/private tiers already create a
    // request; the same gate is enforced again at approval in `triageJoinRequest`.
    const instantJoinAllowed =
      community.accessTier === AccessTier.Public &&
      (!community.requiresSecondVouch ||
        (await this.hasMemberVouch(community.id, userId)));

    if (instantJoinAllowed) {
      // ON CONFLICT DO NOTHING absorbs a race between two concurrent joins
      // without a pre-check + 23505 — mirrors `CommunityPostsService
      // .addReaction`/`EventsService.addCohost`'s insert idiom.
      await this.members
        .createQueryBuilder()
        .insert()
        .into(CommunityMember)
        .values({
          communityId: community.id,
          userId,
          role: RosterRole.Member,
          // Recorded only when there were rules to agree to. Stamping an
          // acceptance for a community with no rules would write down a
          // consent nobody was asked for, and a later rules edit bumps
          // `rulesVersion` anyway, so this member is prompted then.
          ...CommunitiesService.rulesAcceptanceStamp(community),
        })
        .orIgnore()
        .execute();
      this.eventEmitter.emit(COMMUNITY_MEMBER_JOINED, {
        communityId: community.id,
        userId,
      } satisfies CommunityMemberJoinedEvent);
      return { outcome: 'joined', role: RosterRole.Member, request: null };
    }

    // request | invite | private, or a second-vouch-gated public join -> pending.
    return this.createJoinRequest(community, slug, userId, dto);
  }

  /**
   * Create a pending join request. Used by the request/invite/private tiers and
   * by a public community whose second-vouch gate the applicant hasn't met. The
   * partial-unique index on (community_id, user_id) WHERE status='pending' is
   * the real backstop against a double-request race; a hit surfaces here as
   * 23505 and converges on a 409.
   */
  private async createJoinRequest(
    community: Community,
    slug: string,
    userId: string,
    dto: JoinCommunityInput,
  ): Promise<JoinResultDTO> {
    try {
      const saved = await this.joinRequests.save(
        this.joinRequests.create({
          communityId: community.id,
          userId,
          note: dto.note ?? null,
          // A real column now, so a reviewer can read a queue by involvement
          // instead of parsing it back out of the free-text note. `note` is
          // untouched and keeps carrying whatever the client sends.
          involvement: dto.involvement ?? null,
        }),
      );
      const memberRef = await this.memberRefFor(userId);
      // Tell the owner + mods a request is waiting. Best-effort: a notification
      // failure must not fail the request itself. `createForRecipients` applies
      // the actor block/mute filter per recipient and drops the requester
      // themselves, so no self-notification is possible.
      await this.notifyStaffOfJoinRequest(community, slug, userId);
      return {
        outcome: 'requested',
        role: null,
        request: toJoinRequestDTO(saved, memberRef),
      };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('A join request is already pending');
      }
      throw err;
    }
  }

  /**
   * Whether a current member of the community holds an active platform vouch for
   * the applicant — the "second vouch" a `requiresSecondVouch` community needs
   * before admitting someone. An empty roster (nobody to have vouched) is
   * trivially unmet.
   */
  private async hasMemberVouch(
    communityId: string,
    applicantId: string,
  ): Promise<boolean> {
    // One bounded `EXISTS` rather than loading every roster user id into
    // memory and passing them to `VouchService.hasActiveVouchFrom` as an
    // `IN (...)` list (BE-COM-36): that second query's parameter list grew
    // with the community, and a large community made every join attempt read
    // its whole roster first. Postgres can stop at the first matching pair.
    const match = await this.members
      .createQueryBuilder('m')
      .select('1', 'one')
      .where('m.community_id = :communityId', { communityId })
      .andWhere(
        `EXISTS (
           SELECT 1 FROM "vouches" v
           WHERE v.voucher_id = m.user_id
             AND v.vouchee_id = :applicantId
             AND v.withdrawn_at IS NULL
         )`,
        { applicantId },
      )
      .limit(1)
      .getRawOne<{ one: number }>();
    return match !== undefined && match !== null;
  }

  /**
   * Refuses a join by someone this community currently bars. Applies to EVERY
   * access tier, and runs before every other gate in `join`.
   *
   * Expiry is enforced by QUERY, never by a sweep job: the predicate is
   * `expires_at IS NULL OR expires_at > now()`, so a timed ban stops biting
   * the instant it runs out whether or not anything has deleted the row. The
   * spent row is then deleted on the way past, which is lazy expiry with
   * write-through, the pattern `JwtStrategy.liftExpiredRestriction` uses for
   * `users.restricted_until`. The DELETE is guarded on the row still being
   * expired, so a moderator re-banning the member between the read and the
   * write is never clobbered by a stale decision.
   *
   * The refusal now carries the terms. It used to be a bare "you cannot join,
   * contact its moderators", which named a route the product does not offer:
   * there is no way to message a community's moderators, and the ban reached
   * the member as nothing at all. So the reason the moderator wrote, the rule
   * they cited, and the date the bar lifts all travel with the 403. A member
   * who can read the terms of a sanction can decide whether to wait it out or
   * appeal it; a member who cannot can do neither.
   */
  private async assertNotBanned(
    community: Community,
    userId: string,
  ): Promise<void> {
    const ban = await this.bans.findOne({
      where: { communityId: community.id, userId },
    });
    if (!ban) return;

    const now = new Date();
    if (ban.expiresAt !== null && ban.expiresAt.getTime() <= now.getTime()) {
      await this.bans
        .createQueryBuilder()
        .delete()
        .from(CommunityBan)
        .where('id = :id AND expires_at IS NOT NULL AND expires_at <= :now', {
          id: ban.id,
          now,
        })
        .execute();
      return;
    }

    throw new ForbiddenException({
      code: 'BANNED_FROM_COMMUNITY',
      message: ban.expiresAt
        ? `You cannot join this community until ${ban.expiresAt.toISOString().slice(0, 10)}.`
        : 'You cannot join this community.',
      reason: ban.reason,
      expiresAt: ban.expiresAt?.toISOString() ?? null,
      rule: ban.ruleText,
    });
  }

  /**
   * Refuses a join filed before the reapply date a previous decline set. The
   * date is in the response so the client can say "you can apply again on the
   * 3rd" rather than an unexplained no.
   *
   * Reads the most recent declined request for this pair, so a later decline
   * always supersedes an earlier one. A NULL `reapplyAfter` means no wait,
   * never a permanent bar (that is a ban, in a different table).
   */
  private async assertReapplyWindowPassed(
    community: Community,
    userId: string,
  ): Promise<void> {
    const lastDecline = await this.joinRequests.findOne({
      where: {
        communityId: community.id,
        userId,
        status: JoinRequestStatus.Declined,
      },
      order: { createdAt: 'DESC' },
    });
    const reapplyAfter = lastDecline?.reapplyAfter ?? null;
    if (reapplyAfter && reapplyAfter.getTime() > Date.now()) {
      throw new ForbiddenException({
        code: 'REAPPLY_TOO_SOON',
        message: `This community asked you to apply again later. You can apply again on ${reapplyAfter.toISOString().slice(0, 10)}.`,
        reapplyAfter: reapplyAfter.toISOString(),
      });
    }
  }

  /**
   * A community with house rules only admits someone who agreed to the
   * CURRENT version of them. The refusal is a distinct, machine-readable 400
   * (`code: 'RULES_ACCEPTANCE_REQUIRED'`, plus the version to agree to), so
   * the client can tell it apart from every other 400 on this route and
   * re-prompt with the rules rather than showing a generic validation error.
   *
   * Static: it is a pure function of the community and the submitted version.
   */
  private static assertRulesAccepted(
    community: Community,
    acceptedRulesVersion: number | undefined,
  ): void {
    if (!community.rules.length) return;
    if (acceptedRulesVersion === community.rulesVersion) return;
    throw new BadRequestException({
      code: 'RULES_ACCEPTANCE_REQUIRED',
      message:
        "Please read and accept this community's house rules before joining.",
      rulesVersion: community.rulesVersion,
    });
  }

  /**
   * The `rules_accepted_at` / `rules_version_accepted` pair to stamp on a
   * roster row being created, as a spreadable partial. Empty for a community
   * with no rules: there was nothing to agree to, and recording an acceptance
   * anyway would be a consent nobody gave.
   */
  private static rulesAcceptanceStamp(
    community: Community,
  ): Partial<
    Pick<CommunityMember, 'rulesAcceptedAt' | 'rulesVersionAccepted'>
  > {
    if (!community.rules.length) return {};
    return {
      rulesAcceptedAt: new Date(),
      rulesVersionAccepted: community.rulesVersion,
    };
  }

  // Private + non-member -> 404, not 403, so existence isn't leaked — mirrors
  // `getBySlug`/`CommunityPostsService.assertViewable`. Beyond that, respects
  // `rosterVisible`: a non-member is forbidden from seeing the roster of a
  // (non-private) community that has opted to keep it members-only.
  //
  // DELIBERATELY NOT block/mute filtered, unlike the post feeds in
  // `CommunityPostsService.listPosts`. A roster is a factual membership
  // record, not a content feed: hiding a blocked member from it would tell the
  // viewer that someone they blocked is *absent* from a space they are in fact
  // in — actively misleading, and worse for the blocker than the truth, since
  // deciding whether to join or post somewhere may depend on exactly that.
  // Blocks already do the work that matters here by severing interaction; they
  // are not a "make them disappear from the world" primitive.
  async roster(
    slug: string,
    viewerId: string,
    page?: number,
    q?: string,
  ): Promise<Paginated<RosterEntryDTO>> {
    const community = await this.loadOr404(slug);
    const role = await this.myRole(community.id, viewerId);

    if (community.accessTier === AccessTier.Private && !role) {
      throw new NotFoundException('Community not found');
    }

    if (!community.rosterVisible && !role) {
      throw new ForbiddenException('Roster is private to members');
    }

    const normalizedPage = normalizePage(page);
    const rosterMembersQuery = this.members
      .createQueryBuilder('m')
      .where('m.community_id = :communityId', { communityId: community.id })
      .orderBy('m.joined_at', 'ASC');

    // Server-side search across the WHOLE roster, so a big community is
    // searchable at all: filtering only the pages already fetched can never
    // find the member on page nine. Expressed as an EXISTS against `profiles`
    // rather than a join, which keeps `paginate`'s `.skip()/.take()` clear of
    // the distinct-alias pass a joined ORDER BY runs into, and keeps `total`
    // counting matches rather than the whole roster.
    const searchTerm = q?.trim().slice(0, ROSTER_SEARCH_MAX_LENGTH);
    if (searchTerm) {
      const pattern = `%${escapeLikeTerm(searchTerm)}%`;
      rosterMembersQuery.andWhere(
        `EXISTS (
           SELECT 1 FROM "profiles" "rp"
           WHERE "rp"."user_id" = m.user_id
             AND (
               "rp"."first_name" ILIKE :rosterPattern
               OR "rp"."last_name" ILIKE :rosterPattern
               OR ("rp"."first_name" || ' ' || "rp"."last_name") ILIKE :rosterPattern
               OR "rp"."slug" ILIKE :rosterPattern
             )
         )`,
        { rosterPattern: pattern },
      );
    }

    return paginate(rosterMembersQuery, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      const profilesByUserId = await new MemberLookup(this.profiles).byUserIds(
        rows.map((member) => member.userId),
      );
      return rows
        .filter((member) => profilesByUserId.has(member.userId))
        .map((member) =>
          toRosterEntry(member, profilesByUserId.get(member.userId)!),
        );
    });
  }

  // Also NOT block/mute filtered, for a stronger reason than `roster` above:
  // this is a moderation queue, not a feed. Silently hiding a join request
  // because the reviewing mod happens to have blocked (or muted) the applicant
  // would strand that request as permanently pending, with no one aware it
  // exists — a block by one mod would become an invisible, unaccountable veto.
  // A mod who cannot fairly triage a specific applicant should recuse
  // themselves; the queue must still show the work.
  /**
   * `POST /communities/:slug/tag-requests` — an owner/mod's free-text
   * "I wish this tag existed" feedback. Same owner/mod gate as `update`.
   * INFORMATIONAL ONLY: this never touches `COMMUNITY_TAGS` or
   * `Community.tags` — see `CommunityTagRequest`'s docstring. An admin
   * reviews the resulting inbox from `AdminCommunityTagRequestsController`.
   */
  async createTagRequest(
    slug: string,
    actorId: string,
    dto: CreateCommunityTagRequestDto,
  ): Promise<CommunityTagRequestResponseDTO> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const saved = await this.tagRequests.save(
      this.tagRequests.create({
        communityId: community.id,
        requestedByUserId: actorId,
        label: dto.label.trim(),
        note: dto.note?.trim() ? dto.note.trim() : null,
      }),
    );
    return toCommunityTagRequestResponse(saved);
  }

  /**
   * The community's PENDING join-request queue, oldest first, paginated
   * (ENG-41).
   *
   * Supersedes the earlier BE-COM-36 note here, which capped the queue at
   * `DEFAULT_LIST_LIMIT` and called the cap "invisible to today's callers".
   * Bounding it was right; leaving it invisible was not. Oldest-first plus a
   * hard 200-row cap means the requests that fall off the end are the NEWEST
   * arrivals, so a community with 201 pending requests hid the most recent one
   * from every moderator and said nothing about it. The envelope now carries
   * `total`, so the queue can state its real size, and `page`, so a moderator
   * can reach every request in it.
   *
   * ORDERING STAYS OLDEST-FIRST, deliberately: this is a work queue, and the
   * request that has waited longest is the one that most needs an answer.
   * Newest-first would be the wrong sort for a queue even now that nothing is
   * hidden, so please do not "fix" it.
   *
   * The `EXISTS` against `profiles` is what keeps `total` honest. Every row is
   * rendered through a `MemberRef`, so a request whose applicant has no profile
   * row cannot be rendered at all and used to be dropped AFTER the fetch: the
   * count would then have included rows no moderator could ever see or act on.
   * Filtering in the query instead means `total` is exactly the number of
   * requests reachable through these pages. Expressed as `EXISTS` rather than a
   * join, the same way `roster` does it, so `paginate`'s `.skip()/.take()`
   * stays clear of the distinct-alias pass a joined query runs into.
   */
  async listJoinRequests(
    slug: string,
    actorId: string,
    query: ListJoinRequestsQuery = {},
  ): Promise<Paginated<CommunityJoinRequestDTO>> {
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const page = normalizePage(query.page);
    const joinRequestsQuery = this.joinRequests
      .createQueryBuilder('request')
      .where('request.community_id = :communityId', {
        communityId: community.id,
      })
      .andWhere('request.status = :pending', {
        pending: JoinRequestStatus.Pending,
      })
      .andWhere(
        `EXISTS (
           SELECT 1 FROM "profiles" "applicant_profile"
           WHERE "applicant_profile"."user_id" = request.user_id
         )`,
      )
      // `created_at` alone is not a total order, so it is not a safe sort key for
      // offset pagination: two rows written in the same transaction share a
      // statement timestamp, and Postgres is then free to return that tie in
      // either order per query, which is how a row appears on two pages and
      // another appears on none. `id` breaks the tie deterministically. Same
      // reasoning as `PlatformSettingsService.listChanges`.
      .orderBy('request.created_at', 'ASC')
      .addOrderBy('request.id', 'ASC');

    return paginate(joinRequestsQuery, page, async (rows) => {
      if (!rows.length) return [];

      const applicantIds = rows.map((row) => row.userId);
      // Both lookups are batched across the WHOLE page, never per row: this
      // list is rendered one card per request, and a per-request query here
      // would be the N+1 that `statsForMany` exists to avoid elsewhere in this
      // service. Pagination narrowed what "the whole set" means; it did not
      // turn either lookup into a per-row call.
      const [refs, contexts] = await Promise.all([
        new MemberLookup(this.profiles).byUserIds(applicantIds),
        this.applicantContexts(community, actorId, applicantIds),
      ]);
      // Unreachable given the `EXISTS` above, and kept as a type-level guard so
      // `refs.get(...)!` is not an unchecked assertion.
      return rows
        .filter((row) => refs.has(row.userId))
        .map((row) =>
          toJoinRequestDTO(
            row,
            refs.get(row.userId)!,
            contexts.get(row.userId),
          ),
        );
    });
  }

  /**
   * The reviewer-side context for a whole queue of applicants, in THREE
   * batched queries total regardless of queue length (see
   * `JoinRequestApplicantContext`). Same discipline as `statsForMany`: one
   * query per metric across the id set, never one per row.
   *
   *  - account age comes from `users.created_at`;
   *  - shared connections reuse `ConnectionsService.mutualCountsByUserIds`,
   *    which already answers exactly this question in batch;
   *  - shared communities is one grouped query, counting the OTHER
   *    communities an applicant is in that somebody on this community's
   *    roster is also in. This community itself is excluded (the applicant is
   *    not in it yet, and it would be a constant anyway).
   *
   * An applicant with no rows in a given lane simply reads 0.
   */
  private async applicantContexts(
    community: Community,
    reviewerId: string,
    applicantIds: string[],
  ): Promise<Map<string, JoinRequestApplicantContext>> {
    const contexts = new Map<string, JoinRequestApplicantContext>();
    if (!applicantIds.length) return contexts;

    const [accounts, sharedConnectionCounts, sharedCommunityRows] =
      await Promise.all([
        this.users.find({
          where: { id: In(applicantIds) },
          select: { id: true, createdAt: true },
        }),
        this.connectionsService.mutualCountsByUserIds(reviewerId, applicantIds),
        // Alias kept lowercase on purpose: TypeORM quotes the alias it
        // generates, and an unquoted camelCase reference inside the raw
        // `EXISTS` below would fold to lowercase in Postgres and fail to
        // match it. Every alias in this file is lowercase for the same
        // reason.
        this.members
          .createQueryBuilder('applicant')
          .select('applicant.user_id', 'applicantId')
          .addSelect('COUNT(DISTINCT applicant.community_id)', 'sharedCount')
          .where('applicant.user_id IN (:...applicantIds)', {
            applicantIds,
          })
          .andWhere('applicant.community_id != :communityId', {
            communityId: community.id,
          })
          .andWhere(
            `EXISTS (
               SELECT 1
               FROM "community_members" "shared_membership"
               INNER JOIN "community_members" "roster_membership"
                 ON "roster_membership"."user_id" = "shared_membership"."user_id"
                AND "roster_membership"."community_id" = :communityId
               WHERE "shared_membership"."community_id" = applicant.community_id
             )`,
          )
          .groupBy('applicant.user_id')
          .getRawMany<{ applicantId: string; sharedCount: string }>(),
      ]);

    const createdAtByUserId = new Map(
      accounts.map((account) => [account.id, account.createdAt]),
    );
    const sharedCommunityCountByUserId = new Map(
      sharedCommunityRows.map((row) => [
        row.applicantId,
        Number(row.sharedCount),
      ]),
    );

    for (const applicantId of applicantIds) {
      const accountCreatedAt = createdAtByUserId.get(applicantId);
      // No `users` row means the account is gone; there is no context to
      // report, and the caller renders the request without it.
      if (!accountCreatedAt) continue;
      contexts.set(applicantId, {
        accountCreatedAt,
        sharedConnectionCount: sharedConnectionCounts.get(applicantId) ?? 0,
        sharedCommunityCount:
          sharedCommunityCountByUserId.get(applicantId) ?? 0,
      });
    }
    return contexts;
  }

  async triageJoinRequest(
    slug: string,
    id: string,
    actorId: string,
    input: TriageJoinRequestInput,
  ): Promise<CommunityJoinRequestDTO> {
    const { action } = input;
    const community = await this.loadOr404(slug);
    await this.assertOwnerOrMod(community.id, actorId);

    const request = await this.joinRequests.findOne({
      where: { id, communityId: community.id },
    });
    if (!request) {
      throw new NotFoundException('Join request not found');
    }
    if (request.status !== JoinRequestStatus.Pending) {
      throw new ConflictException('Join request already resolved');
    }

    // A live ban bars admission through this door too. `join` has always
    // checked `community_bans` first, but approving a pending request skipped
    // the table entirely, so a barred member with a request already in flight
    // could be waved back in by a moderator who had no way of knowing. Checked
    // on approve only: declining a barred applicant's request is always fine,
    // and `assertNotBanned` treats an expired ban as no ban and clears it.
    if (action === 'approve') {
      await this.assertNotBanned(community, request.userId);
    }

    // Second-vouch gate at admission: even a mod can't approve until a current
    // member holds a vouch for the applicant (a mod is a member, so they can
    // vouch first, then approve). Only enforced on approve — declining is always
    // allowed.
    if (
      action === 'approve' &&
      community.requiresSecondVouch &&
      !(await this.hasMemberVouch(community.id, request.userId))
    ) {
      throw new UnprocessableEntityException(
        'This community requires a vouch from a current member before this applicant can be admitted',
      );
    }

    const newStatus =
      action === 'approve'
        ? JoinRequestStatus.Approved
        : JoinRequestStatus.Declined;

    // The decline half of the decision, resolved once so the guarded UPDATE,
    // the in-memory entity and the notification all describe the same thing.
    // A decline with no kind (an older client) records no kind and no wait,
    // which is how `CommunityJoinRequest.declineKind` tells readers to treat
    // an unqualified decline.
    const declineKind =
      action === 'decline' ? (input.declineKind ?? null) : null;
    const declineReason =
      action === 'decline' ? input.declineReason?.trim() || null : null;
    const reapplyAfter = CommunitiesService.reapplyAfterFor(declineKind);

    const saved = await this.dataSource.transaction(async (manager) => {
      const joinRequestsRepo = manager.getRepository(CommunityJoinRequest);
      const membersRepo = manager.getRepository(CommunityMember);

      // Atomic conditional claim: flip `pending -> newStatus` only if the row
      // is STILL pending. The pre-transaction status check above is just a
      // fast-path; without this guarded UPDATE an approve and a decline racing
      // (or a double-approve) could both pass that check as read-modify-write,
      // and the approve branch could leave a just-declined applicant on the
      // roster. `affected === 0` means another call already resolved it — the
      // roster insert below is then skipped and we abort with a 409.
      const claim = await joinRequestsRepo
        .createQueryBuilder()
        .update(CommunityJoinRequest)
        .set({ status: newStatus, declineKind, declineReason, reapplyAfter })
        .where('id = :id AND status = :pending', {
          id: request.id,
          pending: JoinRequestStatus.Pending,
        })
        .execute();
      if (claim.affected === 0) {
        // Rolls the transaction back (nothing was inserted, since the roster
        // insert is gated on this claim succeeding).
        throw new ConflictException('Join request already resolved');
      }

      if (action === 'approve') {
        // Idempotent upsert: approving a request whose applicant is somehow
        // already a member must not 500 on the roster's unique constraint.
        await membersRepo
          .createQueryBuilder()
          .insert()
          .into(CommunityMember)
          .values({
            communityId: community.id,
            userId: request.userId,
            role: RosterRole.Member,
            // The applicant agreed to the rules when they applied, and this
            // is the roster row that records it. See `rulesAcceptanceStamp`.
            // Known limitation: the version they actually agreed to at
            // request time is not persisted on the request itself, so an
            // approval that lands after an owner edits the rules records the
            // CURRENT version. Fixing that properly needs an
            // `accepted_rules_version` column on `community_join_requests`.
            ...CommunitiesService.rulesAcceptanceStamp(community),
          })
          .orIgnore()
          .execute();
      }

      // Reflect the claimed status and the decline fields on the in-memory
      // entity for the DTO — the guarded UPDATE doesn't hydrate it.
      request.status = newStatus;
      request.declineKind = declineKind;
      request.declineReason = declineReason;
      request.reapplyAfter = reapplyAfter;
      return request;
    });

    // Fired only after the transaction above has committed the roster
    // insert, and only on the branch that actually wrote one — mirrors the
    // `action === 'approve'` gate on the insert itself.
    if (action === 'approve') {
      this.eventEmitter.emit(COMMUNITY_MEMBER_JOINED, {
        communityId: community.id,
        userId: saved.userId,
      } satisfies CommunityMemberJoinedEvent);
    }

    // Tell the applicant the outcome — they always have an account (a
    // `CommunityJoinRequest.userId` is a real member), so this in-app
    // notification always reaches them. No actor: it's the community telling
    // you about your own status, not a member action to filter on. Best-effort.
    try {
      await this.notifications.create(
        saved.userId,
        action === 'approve'
          ? NotificationType.JoinRequestApproved
          : NotificationType.JoinRequestDeclined,
        {
          source: 'community',
          communitySlug: slug,
          // The decline payload carries the KIND so the client can word "not
          // right now, here is when you can apply again" and "not a fit"
          // differently, and the date so it can say when. It also carries the
          // reviewer's `declineReason`, which is the column's stated purpose:
          // it is written FOR the applicant. The moderators' private channel
          // is `internalNote`, which no notification and no response body
          // ever includes.
          ...(action === 'decline'
            ? {
                declineKind,
                declineReason,
                reapplyAfter: reapplyAfter ? reapplyAfter.toISOString() : null,
              }
            : {}),
        },
      );
    } catch {
      // Intentionally ignored — the triage decision already committed.
    }

    const memberRef = await this.memberRefFor(saved.userId);
    return toJoinRequestDTO(saved, memberRef);
  }

  /**
   * The date a declined applicant may apply again, from the kind of "no" they
   * were given. NULL for an approve and for a decline that carried no kind,
   * which means no waiting period at all rather than a permanent bar.
   */
  private static reapplyAfterFor(
    declineKind: CommunityJoinRequestDeclineKind | null,
  ): Date | null {
    if (declineKind === CommunityJoinRequestDeclineKind.NotNow) {
      return new Date(Date.now() + REAPPLY_WAIT_DAYS_NOT_NOW * DAY_MS);
    }
    if (declineKind === CommunityJoinRequestDeclineKind.NotAFit) {
      return new Date(Date.now() + REAPPLY_WAIT_DAYS_NOT_A_FIT * DAY_MS);
    }
    return null;
  }

  /**
   * Fan the "someone wants to join" notification out to the owner and every
   * mod. Own try/catch so a notification failure never surfaces as a failed
   * join request. Deep-links to the community (where the triage queue lives).
   */
  private async notifyStaffOfJoinRequest(
    community: Community,
    slug: string,
    requesterId: string,
  ): Promise<void> {
    try {
      const recipientIds = await this.staffRecipientIds(community);
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.JoinRequestReceived,
        { actorId: requesterId, source: 'community', communitySlug: slug },
        requesterId,
      );
    } catch {
      // Intentionally ignored — best-effort, same contract as the reply fan-out.
    }
  }

  /**
   * Self-leave or staff-remove.
   *
   * Guardrails, in the order enforced below:
   *  1. Anyone may remove THEMSELVES (leaving); removing anyone else requires
   *     owner/mod. Authorization runs before the owner check so an
   *     unauthorized stranger gets Forbidden rather than a hint about who owns
   *     the community.
   *  2. Only an OWNER-LEVEL actor (owner or co-owner) may remove another
   *     moderator. `setMemberRole` already refuses to let a mod demote a peer
   *     ("only the owner can change a moderator's role"), but `removeMember`
   *     used to block only the owner — so a mod could simply kick a peer mod
   *     off the roster instead, which is strictly stronger than the demotion
   *     the other rule forbids (BE-COM-07). The two agree: a mod's standing in
   *     a community can only be taken away from above, whichever route is
   *     used. A mod removing THEMSELVES is still a self-leave and stays
   *     allowed.
   *  3. Only the OWNER may remove a CO-OWNER. A co-owner holds owner-level
   *     powers, so letting one remove another would make the role
   *     self-consuming: two co-owners could race to unseat each other, and the
   *     owner would find their governance team dismantled by someone they
   *     appointed. This is one of the three powers the owner keeps alone (see
   *     the permission model at `isStaffRole`).
   *  4. The owner is never removable — they'd orphan the community.
   *
   * REMOVAL BARS RETURN BY DEFAULT. Deleting the roster row alone means a
   * removed member re-joins a public-tier community in one tap, so a removal
   * also writes a `community_bans` row unless the caller explicitly passes
   * `allowReturn`. A member removing THEMSELVES never writes one, whatever
   * the caller sent: leaving is not a moderation act, and a member who leaves
   * must be able to come back.
   *
   * A PERMANENT BAR NEEDS A SECOND SIGNATURE (PRD-25). Omitting `banDays` used
   * to bar someone from this community forever on one person's say-so, while
   * the platform-level equivalent had required a second moderator since TS-12.
   * It now applies a 30-day bar at once and opens a hold
   * (`community_ban_ratifications`) for a second owner, co-owner or moderator
   * to sign inside 72 hours. The member is off the roster immediately either
   * way: only the permanence waits. A community with no second eligible
   * signatory opens no hold and the bar stands at 30 days, which the returned
   * outcome says out loud rather than leaving the caller to believe they did
   * something they did not.
   */
  async removeMember(
    slug: string,
    actorId: string,
    memberSlug: string,
    options: RemoveMemberOptions = {},
  ): Promise<CommunityRemovalOutcomeDTO> {
    const community = await this.loadOr404(slug);

    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    const isSelfLeave = actorId === targetUserId;
    if (!isSelfLeave) {
      const actorMembership = await this.assertOwnerOrMod(
        community.id,
        actorId,
      );
      // Rule 3, checked before rule 2 because it is the stricter of the two:
      // removing a co-owner is owner-only.
      if (
        targetMembership.role === RosterRole.CoOwner &&
        actorMembership.role !== RosterRole.Owner
      ) {
        throw new ForbiddenException('Only the owner can remove a co-owner');
      }
      // Rule 2, mirroring `setMemberRole`'s rule 5 — see this method's doc
      // comment. Owner-level, so a co-owner may remove a mod.
      if (
        targetMembership.role === RosterRole.Mod &&
        !CommunitiesService.isOwnerLevelRole(actorMembership.role)
      ) {
        throw new ForbiddenException(
          'Only an owner or co-owner can remove a moderator',
        );
      }
    }

    if (targetMembership.role === RosterRole.Owner) {
      throw new BadRequestException('The owner cannot be removed');
    }

    await this.members.delete({ id: targetMembership.id });
    // Self-leave or staff-removal, either way the roster row is gone — the
    // card programme must not keep a former member's card working.
    this.eventEmitter.emit(COMMUNITY_MEMBER_LEFT, {
      communityId: community.id,
      userId: targetUserId,
    } satisfies CommunityMemberLeftEvent);

    // A self-leave never bars the return, whatever `allowReturn` said: this
    // guard is explicit rather than relying on the caller, because the query
    // param is client-supplied and "leaving banned me from my own community"
    // is the worst possible way to be wrong here.
    //
    // The reason the actor typed, if any. It is the ban's reason when the
    // return is barred, and the note on the removal's audit row either way, so
    // it is named for what it is rather than for one of the two branches.
    const statedReason = options.reason?.trim() || null;
    const barOutcome =
      !isSelfLeave && !options.allowReturn
        ? await this.barReturn(community, actorId, targetUserId, statedReason, {
            banDays: options.banDays,
            ruleIndex: options.ruleIndex,
          })
        : null;
    const ban = barOutcome?.ban ?? null;
    const ratification = barOutcome?.ratification ?? null;
    const hasBarredReturn = ban !== null;

    // One entry, under the action that describes what actually happened. A
    // removal that bars the return and one that does not differ in whether the
    // person can come back, so the audit trail records them as different
    // actions rather than one action with a flag (see `MemberBanned`).
    await this.logGovernanceAction(
      community.id,
      actorId,
      hasBarredReturn
        ? GovernanceLogAction.MemberBanned
        : GovernanceLogAction.MemberRemoved,
      targetUserId,
      {
        removedBySelf: isSelfLeave,
        ...(hasBarredReturn && statedReason ? { reason: statedReason } : {}),
        // The terms of the bar, so the community's own governance log answers
        // "for how long, and under which rule" without a join onto
        // `community_bans` (a lifted ban deletes that row; this entry stays).
        ...(ban
          ? {
              banExpiresAt: ban.expiresAt?.toISOString() ?? null,
              ...(ban.ruleText !== null
                ? {
                    ruleIndex: ban.ruleIndex,
                    ruleVersion: ban.ruleVersion,
                    ruleText: ban.ruleText,
                  }
                : {}),
            }
          : {}),
      },
    );
    // A community ban is now written into `mod_audit_logs` as well (TS-10).
    // That table is what `POST /appeals` resolves an appeal's target from, so
    // until this row existed a community ban was the one sanction on the
    // platform that could not be argued with. Best effort inside the helper:
    // the removal has already committed.
    if (ban) {
      await this.governanceLog.logModerationAudit({
        actorUserId: actorId,
        action: COMMUNITY_BAN_AUDIT_ACTION,
        targetUserId,
        note: statedReason,
        duration: ban.expiresAt ? ban.expiresAt.toISOString() : null,
      });
    } else if (!isSelfLeave) {
      // PRD-28. The mirror the branch above writes used to be the ban's alone,
      // so a removal that let the member come back wrote `governance_log` and
      // nothing else, and the appeal machinery reading `mod_audit_logs` could
      // not see it. Being able to rejoin is not the same as being able to
      // contest the decision, and the decision was the part with no record.
      //
      // A SELF-LEAVE WRITES NOTHING HERE, for the same reason it writes no ban
      // and sends no notification: leaving is not a moderation act, and
      // "you appealed leaving your own community" is the worst possible way to
      // be wrong. Same guard, deliberately spelled out rather than inferred.
      //
      // Its own action string, so the appeals queue can tell a removal from a
      // bar (`COMMUNITY_REMOVAL_AUDIT_ACTION`). Best effort inside the helper,
      // exactly like the ban: the removal has already committed, so a mirror
      // that cannot be written must never fail the request.
      await this.governanceLog.logModerationAudit({
        actorUserId: actorId,
        action: COMMUNITY_REMOVAL_AUDIT_ACTION,
        targetUserId,
        note: statedReason,
        // A removal serves no term. The member may come back the same minute,
        // so there is no end date to record and none to display.
        duration: null,
      });
    }
    // A self-leave doesn't need a "you were removed" notification telling the
    // member the thing they themselves just did. One notification per
    // removal: `CommunityBanned` when the return was barred, the plain
    // `CommunityMemberRemoved` for the tidy-up case, never both.
    if (!isSelfLeave) {
      if (ban) {
        await this.notifyMemberBanned(community, actorId, ban);
      } else {
        await this.notifyMemberRemoved(community, actorId, targetUserId);
      }
    }

    // PRD-25. The route used to answer 204, which was honest while a removal
    // had one possible outcome. Asking for a permanent bar now lands in three
    // different places, and a moderator told nothing would believe they got
    // the one they asked for.
    return toCommunityRemovalOutcomeDTO({
      isSelfLeave,
      hasBarredReturn,
      barExpiresAt: ban?.expiresAt ?? null,
      ratificationId: ratification?.id ?? null,
      ratificationExpiresAt: ratification?.expiresAt ?? null,
      hasNoSecondSignatory: barOutcome?.hasNoSecondSignatory ?? false,
    });
  }

  /**
   * Writes the `community_bans` row a removal leaves behind, and hands the
   * caller the row that is now in force. `ON CONFLICT DO NOTHING` against the
   * unique (community, user) index, so re-removing someone already banned is
   * a no-op rather than a 23505; the ban already on file is what stands, and
   * that is the row returned.
   *
   * `banDays` is the lighter rung (TS-10): with it the bar ends by the clock,
   * without it the bar is permanent, which is what every community ban was
   * until now. `ruleIndex` cites one of the community's house rules (TS-15);
   * the version and the rule's exact wording are snapshotted with it, so the
   * record still reads correctly after the rules are rewritten. An index that
   * falls outside the current rules is dropped rather than stored.
   *
   * NO `banDays` MEANS "PERMANENT", AND PERMANENT NEEDS TWO PEOPLE (PRD-25).
   * What that writes now is a 30-day bar plus a hold for a second owner,
   * co-owner or moderator to sign, so the member is out of the room at once and
   * only the permanence waits. If this community has nobody else who could
   * sign, no hold is opened and the 30-day bar is the whole sanction: a solo
   * owner does not get to bar someone for life on their own signature, and
   * that is the case the finding was most worried about. The caller is handed
   * `hasNoSecondSignatory` so it can say so.
   *
   * Only the WRITE lives here. Listing, revising and lifting bans is a
   * separate surface with its own service.
   */
  private async barReturn(
    community: Community,
    actorId: string,
    targetUserId: string,
    reason: string | null,
    terms: { banDays?: number; ruleIndex?: number },
  ): Promise<{
    ban: CommunityBan | null;
    ratification: CommunityBanRatification | null;
    hasNoSecondSignatory: boolean;
  }> {
    const isPermanentRequested = terms.banDays === undefined;
    // A permanent request lands as the fallback term first. Everything after
    // this point treats it as an ordinary timed bar, and the hold below is the
    // only thing that can turn it back into a permanent one.
    const expiresAt = banExpiryFromDays(
      terms.banDays ?? COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS,
    );
    const rule = resolveRuleSnapshot(
      community.rules,
      community.rulesVersion,
      terms.ruleIndex,
    );

    await this.bans
      .createQueryBuilder()
      .insert()
      .into(CommunityBan)
      .values({
        communityId: community.id,
        userId: targetUserId,
        bannedByUserId: actorId,
        reason,
        expiresAt,
        ruleIndex: rule?.ruleIndex ?? null,
        ruleVersion: rule?.ruleVersion ?? null,
        ruleText: rule?.ruleText ?? null,
      })
      .orIgnore()
      .execute();

    // Ban evasion (TS-05). The bar is in place; record the correlation
    // material for the invite review queue. Emitted after the insert, never
    // awaited into it.
    const removed: AccountRemovedEvent = {
      userId: targetUserId,
      removalKind: RemovalKind.CommunityBan,
      communityId: community.id,
      removedAt: new Date(),
    };
    this.eventEmitter.emit(ACCOUNT_REMOVED, removed);

    // Read back rather than trusting the values just sent: on the conflict
    // path nothing was written and the ban already on file is the one whose
    // terms the member is actually serving, so it is the one the notification
    // and the audit rows have to describe.
    const ban = await this.bans.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });

    // Nothing to ratify unless a permanent bar was asked for AND the bar now
    // in force has an end date to remove. A conflict-path row that is already
    // permanent needs no second signature: it got one, or it predates this
    // control, and re-proposing it would ask somebody to sign a decision that
    // has already been made.
    if (!isPermanentRequested || !ban || ban.expiresAt === null) {
      return { ban, ratification: null, hasNoSecondSignatory: false };
    }

    const ratification = await this.banRatifications.proposePermanentBar({
      community,
      ban,
      proposerUserId: actorId,
      reason,
    });
    return {
      ban,
      ratification,
      hasNoSecondSignatory: ratification === null,
    };
  }

  /**
   * `GET /me/communities` — every community the caller is actually *on the
   * roster of*, as a flat `{ slug, name, role, joinedAt }[]`.
   *
   * DELIBERATELY NOT PAGINATED, unlike `list()`. This is a membership index
   * the client needs *whole* (it keys a slug -> role map used to decide, for
   * any community it renders from any other source, whether the viewer is a
   * member). Serving it a page at a time is precisely the defect this
   * endpoint exists to fix: the previous workaround — filtering
   * `myRole !== null` across `GET /communities` — is incomplete by
   * construction, because that route is paginated and there is no guarantee
   * the caller's memberships fall on the pages fetched. A member's community
   * count is inherently small and bounded by deliberate human action (you
   * join communities one at a time), so the whole set is a safe response
   * size; if that ever stops being true the fix is a cap plus an explicit
   * signal, not silent truncation.
   *
   * Only `community_members` rows count. A *pending* `CommunityJoinRequest`
   * is not a membership and never appears here — it has no roster row at all,
   * so it is excluded structurally rather than by a filter. (`myJoinRequestStatus`
   * on the community card/detail is where a pending request surfaces.)
   *
   * NOT block-filtered, and there is nothing here to filter: every row
   * describes the caller's own relationship to a community, so no other
   * member's identity or content is exposed. (`BlockFilterService` is used in
   * this module only by `CommunityPostsService`, over post/reply *authors* —
   * see the notes on `roster` and `listJoinRequests` for why the membership
   * surfaces stay unfiltered.)
   */
  async myCommunities(userId: string): Promise<MyCommunityDTO[]> {
    const rows = await this.members
      .createQueryBuilder('m')
      .innerJoin(Community, 'c', 'c.id = m.community_id')
      // Whether this community runs a live membership-card programme, carried
      // on the membership map itself so a cardless member's wallet can name
      // the communities a card could come from in ONE request. Resolved here
      // rather than by the client asking `GET /communities/:slug/card` once
      // per community, which is N requests to render one empty state.
      //
      // A LEFT JOIN over `IDX_community_cards_issuer_id`, and at most one row
      // can match (`UQ_community_cards_issuer`), so it cannot multiply the
      // membership rows. `is_enabled` is part of the ON clause on purpose: a
      // paused programme issues nothing today, and putting it in a WHERE
      // would turn the outer join into an inner one and drop communities.
      .leftJoin(
        CommunityCard,
        'card',
        'card.issuer_type = :cardIssuerType AND card.issuer_id = c.id AND card.is_enabled = TRUE',
        { cardIssuerType: CardIssuerType.Community },
      )
      .select('c.slug', 'slug')
      .addSelect('c.name', 'name')
      .addSelect('m.role', 'role')
      .addSelect('m.joined_at', 'joinedAt')
      // The id rather than a boolean expression: every driver agrees on
      // "there was a row or there was not", and `getRawMany` hands booleans
      // back inconsistently across pg versions.
      .addSelect('card.id', 'cardProgramId')
      .where('m.user_id = :userId', { userId })
      // An archived community drops out of the caller's membership map too, so
      // the client stops treating it as a live community they belong to.
      .andWhere('c.archived_at IS NULL')
      .orderBy('m.joined_at', 'DESC')
      .limit(DEFAULT_LIST_LIMIT)
      .getRawMany<{
        slug: string;
        name: string;
        role: RosterRole;
        joinedAt: Date;
        cardProgramId: string | null;
      }>();

    return rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      role: row.role,
      joinedAt: new Date(row.joinedAt).toISOString(),
      hasCardProgram: row.cardProgramId !== null,
    }));
  }

  /**
   * `PATCH /communities/:slug/members/:memberSlug` — promote a member to
   * moderator, or demote a moderator back to member.
   *
   * Authorization rules, in the order enforced below:
   *
   *  1. **Actor must be owner or mod** — the same `assertOwnerOrMod` gate the
   *     join-request review routes (`listJoinRequests`/`triageJoinRequest`)
   *     and `update` already use. Checked *first*, before the target is even
   *     resolved, so an unauthorized caller learns nothing about who is on
   *     the roster (stricter than `removeMember`, which has to resolve the
   *     target first because self-leave is an authorized path there; this
   *     route has no self path at all — see rule 4).
   *  2. **Target must be on this roster** — unknown/inactive member slug, or
   *     a real member of some *other* community, both 404 `Member not found`,
   *     mirroring `removeMember`.
   *  3. **The owner's role is immutable.** Mirrors `removeMember`'s "the
   *     owner cannot be removed": the owner is the community's root of
   *     authority and `Community.ownerId` is the source of truth for it, so a
   *     roster row can't contradict it. Without this a *mod* could demote the
   *     owner and take over the community — the escalation this route most
   *     obviously invites. 400, not 403: the actor is allowed to be here, the
   *     requested change is the impossible part.
   *  4. **Nobody changes their own role.** Redundant in today's role set
   *     (an owner acting on themselves is caught by rule 3, a mod acting on
   *     themselves by rule 5) but stated explicitly so the invariant survives
   *     any future rule change — self-mutation is the classic escalation
   *     vector. Stepping down is done by leaving (`DELETE .../members/:me`),
   *     which is the self-service path that already exists.
   *  5. **Only an owner-level actor may change an existing moderator's
   *     role.** A mod may therefore only promote a plain `member` to `mod`;
   *     they may not demote a peer. Otherwise any single mod could
   *     unilaterally dismantle the rest of the mod team and become the sole
   *     moderator — a takeover from inside the mod tier, quietly and with
   *     nothing on the roster to show for it. `removeMember` enforces the same
   *     rule (BE-COM-07). It used to let a mod remove a peer mod outright, on
   *     the reasoning that removal is loud where a demotion is quiet — but
   *     loud does not make it weaker, and it left the exact takeover this rule
   *     forbids reachable through the next endpoint over. Both routes agree.
   *  6. **Only the OWNER may grant or revoke `co_owner`, or change the role
   *     of someone who already holds it.** Both directions of the same rule:
   *     a co-owner who could appoint another co-owner, or demote one, could
   *     rebuild the community's governance around themselves without the
   *     owner. This is one of the three owner-only powers in the permission
   *     model (see `isStaffRole`). 403, since the actor's role is the reason
   *     the change is refused.
   *
   * The rules are evaluated against the *current* roles only, never against
   * the role being requested, so authorization can't be steered by the body.
   * The requested value is consulted afterwards, and only to skip a no-op
   * write — the call is idempotent (re-promoting an existing mod, as the
   * owner, is a 200 with no UPDATE), matching this module's posture on
   * `join`, reaction-add and approve-triage.
   */
  async setMemberRole(
    slug: string,
    actorId: string,
    memberSlug: string,
    role: AssignableRole,
  ): Promise<MemberRoleDTO> {
    const community = await this.loadOr404(slug);

    // 1. actor is owner/mod
    const actorMembership = await this.assertOwnerOrMod(community.id, actorId);

    // 2. target is on this roster
    const targetUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!targetUserId) {
      throw new NotFoundException('Member not found');
    }
    const targetMembership = await this.members.findOne({
      where: { communityId: community.id, userId: targetUserId },
    });
    if (!targetMembership) {
      throw new NotFoundException('Member not found');
    }

    // 3. the owner's role can never change
    if (targetMembership.role === RosterRole.Owner) {
      throw new BadRequestException("The owner's role cannot be changed");
    }

    // 4. no self role change
    if (targetUserId === actorId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    // 6a. only the owner may change a co-owner's role (checked before rule 5,
    //     being the stricter of the two)
    if (
      targetMembership.role === RosterRole.CoOwner &&
      actorMembership.role !== RosterRole.Owner
    ) {
      throw new ForbiddenException(
        "Only the owner can change a co-owner's role",
      );
    }

    // 6b. only the owner may GRANT co-owner, whoever the target is
    if (
      role === RosterRole.CoOwner &&
      actorMembership.role !== RosterRole.Owner
    ) {
      throw new ForbiddenException('Only the owner can appoint a co-owner');
    }

    // 5. only an owner-level actor may change a moderator's role
    if (
      targetMembership.role === RosterRole.Mod &&
      !CommunitiesService.isOwnerLevelRole(actorMembership.role)
    ) {
      throw new ForbiddenException(
        "Only an owner or co-owner can change a moderator's role",
      );
    }

    if (targetMembership.role !== role) {
      const fromRole = targetMembership.role;
      targetMembership.role = role;
      await this.members.save(targetMembership);
      await this.logGovernanceAction(
        community.id,
        actorId,
        GovernanceLogAction.RoleChanged,
        targetUserId,
        { fromRole, toRole: role },
      );
      await this.notifyRoleChanged(
        community,
        actorId,
        targetUserId,
        fromRole,
        role,
      );
    }

    return { slug: community.slug, memberSlug, role };
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Community> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  /** Tier 1 of the permission model (see `isStaffRole`): the moderation gate,
   * passed by an owner, a CO-OWNER and a mod alike. Returns the actor's roster
   * row on success, so callers that need to tell those three apart
   * (`update`, `removeMember`, `setMemberRole`) don't re-query for it.
   * Callers that only need the gate can keep ignoring the value. */
  private async assertOwnerOrMod(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    if (!membership || !CommunitiesService.isStaffRole(membership.role)) {
      throw new ForbiddenException('Only the owner or a moderator can do that');
    }
    return membership;
  }

  /** Tier 3 of the permission model (see `isStaffRole`): the owner-only gate,
   * read from `Community.ownerId` (the source of truth for ownership — a
   * roster row can never contradict it). Used by the two community-level
   * actions no co-owner or mod may reach (`archive`, `transferOwnership`).
   * Throws Forbidden otherwise. */
  private assertOwner(community: Community, userId: string): void {
    if (community.ownerId !== userId) {
      throw new ForbiddenException('Only the owner can do that');
    }
  }

  private async myRole(
    communityId: string,
    userId: string,
  ): Promise<RosterRole | null> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    return membership?.role ?? null;
  }

  // Resolves a single userId to a MemberRef, for mapping a join-request /
  // roster row this service itself just created or mutated. A miss here
  // would mean a data-integrity bug (an authenticated actor without a
  // profile row), not a legitimate empty state, so it 404s rather than
  // silently mapping to `null` (unlike `toMemberRef`'s callers elsewhere,
  // which tolerate an optional/foreign profile being absent).
  private async memberRefFor(userId: string): Promise<MemberRef> {
    const refs = await new MemberLookup(this.profiles).byUserIds([userId]);
    const ref = refs.get(userId);
    if (!ref) {
      throw new NotFoundException('Member profile not found');
    }
    return ref;
  }

  private async myRoleByCommunity(
    communityIds: string[],
    userId: string,
  ): Promise<Map<string, RosterRole>> {
    if (!communityIds.length) return new Map();
    const rows = await this.members.find({
      where: { communityId: In(communityIds), userId },
    });
    return new Map(rows.map((m) => [m.communityId, m.role]));
  }

  /**
   * Resolves the create form's `stewards` and `invites` slugs to user ids.
   * Writes NOTHING — both lists are invitations, and the only roster row
   * `create` writes is the creator's own `owner`.
   *
   * `stewards` used to be seeded straight into the roster as `mod` inside the
   * create transaction: no notification, no accept step, no way to decline
   * (BE-COM-06). Any member could therefore create a community under any name
   * and make up to 50 other members its moderators, who would then appear as
   * `mod` on the roster, in `myCommunities`, in the admin moderators list and
   * in admin trust-network derivation — a misattribution and harassment vector
   * on a safety platform. A steward is now told they were asked (the
   * notification carries `proposedRole: 'mod'`) and the owner promotes them
   * with `setMemberRole` once they have actually joined, which is the existing
   * consented path for handing someone moderator standing.
   *
   * Both lists are resolved in ONE batched lookup so an unknown/typo'd slug in
   * either behaves identically — it just resolves to nothing.
   *
   * System/house accounts (`User.isSystem`) are dropped: they are non-human
   * platform accounts nobody signs in as, so an invitation to one can never be
   * answered. Mirrors the house-account guardrail on `transferOwnership`.
   * `MemberLookup.userIdsForSlugs` already restricts to `active` users.
   */
  private async resolveInvitees(
    ownerId: string,
    stewards: string[],
    invites: string[],
  ): Promise<{ stewardUserIds: string[]; invitedUserIds: string[] }> {
    const slugs = [...stewards, ...invites];
    if (!slugs.length) return { stewardUserIds: [], invitedUserIds: [] };

    const idBySlug = await new MemberLookup(this.profiles).userIdsForSlugs(
      slugs,
    );
    const resolvedIds = [...new Set(idBySlug.values())];
    const systemUserIds = resolvedIds.length
      ? new Set(
          (
            await this.users.find({
              where: { id: In(resolvedIds), isSystem: true },
              select: { id: true },
            })
          ).map((user) => user.id),
        )
      : new Set<string>();

    // The creator is trivially already on the roster, and nobody is invited
    // twice — a slug listed as BOTH a steward and an invite is only ever the
    // steward invitation (the stronger of the two).
    const seen = new Set<string>([ownerId]);
    const take = (slugList: string[]): string[] => {
      const out: string[] = [];
      for (const slug of slugList) {
        const userId = idBySlug.get(slug);
        if (!userId || seen.has(userId) || systemUserIds.has(userId)) continue;
        seen.add(userId);
        out.push(userId);
      }
      return out;
    };

    const stewardUserIds = take(stewards);
    const invitedUserIds = take(invites);
    return { stewardUserIds, invitedUserIds };
  }

  private async buildDetail(
    community: Community,
    viewerId: string,
    myRole?: RosterRole | null,
    moderation?: ContentModerationState,
  ): Promise<CommunityDetailDTO> {
    const [membership, stats, ownerProfile, myJoinRequest, crops] =
      await Promise.all([
        // The viewer's own roster row, loaded even when the caller already
        // knows their role: `rulesVersionAccepted` lives on it, and it is what
        // lets the detail tell an existing member their agreement is out of
        // date after an owner edits the rules. One indexed lookup, the same
        // one `myRole` was doing.
        this.members.findOne({
          where: { communityId: community.id, userId: viewerId },
        }),
        this.statsFor(community.id),
        // `ownerId` is null for an ownerless (post-erasure, pre-promotion)
        // community — no profile to look up; the detail simply renders no
        // owner rather than throwing or querying `userId IS NULL`.
        community.ownerId
          ? this.profiles.findOne({ where: { userId: community.ownerId } })
          : Promise.resolve(null),
        this.joinRequests.findOne({
          where: { communityId: community.id, userId: viewerId },
          order: { createdAt: 'DESC' },
        }),
        this.mediaCropService.getMany(
          community.coverImageUrl ? [community.coverImageUrl] : [],
        ),
      ]);
    // The caller's `myRole` still wins when it passed one (it may describe a
    // role this request just wrote and the row above predates).
    const role = myRole !== undefined ? myRole : (membership?.role ?? null);
    return toCommunityDetail(
      community,
      stats,
      role,
      toMemberRef(ownerProfile),
      myJoinRequest?.status ?? null,
      moderation,
      crops,
      membership?.rulesVersionAccepted ?? null,
    );
  }

  private async statsFor(communityId: string): Promise<CommunityStats> {
    const stats = await this.statsForMany([communityId]);
    return stats.get(communityId) ?? EMPTY_STATS;
  }

  // Grouped-count pattern (mirrors `EventsService.summarize`): one query per
  // metric across the whole page/id-set instead of N+1 per-row lookups.
  private async statsForMany(
    communityIds: string[],
  ): Promise<Map<string, CommunityStats>> {
    const stats = new Map<string, CommunityStats>(
      communityIds.map((id) => [id, { ...EMPTY_STATS }]),
    );
    if (!communityIds.length) return stats;
    const since = new Date(Date.now() - WEEK_MS);

    const memberRows = await this.members
      .createQueryBuilder('m')
      .select('m.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('m.community_id IN (:...ids)', { ids: communityIds })
      .groupBy('m.community_id')
      .getRawMany<{ communityId: string; count: string }>();
    for (const row of memberRows) {
      const s = stats.get(row.communityId);
      if (s) s.memberCount = Number(row.count);
    }

    const activeAuthors = new Map<string, Set<string>>(
      communityIds.map((id) => [id, new Set<string>()]),
    );

    const postRows = await this.posts
      .createQueryBuilder('p')
      .select('p.community_id', 'communityId')
      .addSelect('p.author_id', 'authorId')
      .where('p.community_id IN (:...ids)', { ids: communityIds })
      .andWhere('p.created_at >= :since', { since })
      .getRawMany<{ communityId: string; authorId: string }>();
    for (const row of postRows) {
      const s = stats.get(row.communityId);
      if (s) s.postsThisWeek += 1;
      activeAuthors.get(row.communityId)?.add(row.authorId);
    }

    const replyRows = await this.replies
      .createQueryBuilder('r')
      .innerJoin(CommunityPost, 'p', 'p.id = r.post_id')
      .select('p.community_id', 'communityId')
      .addSelect('r.author_id', 'authorId')
      .where('p.community_id IN (:...ids)', { ids: communityIds })
      .andWhere('r.created_at >= :since', { since })
      .getRawMany<{ communityId: string; authorId: string }>();
    for (const row of replyRows) {
      activeAuthors.get(row.communityId)?.add(row.authorId);
    }

    for (const [id, authors] of activeAuthors) {
      const s = stats.get(id);
      if (s) s.activeThisWeek = authors.size;
    }

    return stats;
  }

  // --- governance audit log + lifecycle notifications ---

  /**
   * Writes one `community_governance_log` entry. Best-effort: a logging
   * failure must never roll back the action it describes or surface to the
   * caller as a failed request — mirrors this module's existing posture on
   * notification failures (see `notifyStaffOfJoinRequest`).
   */
  private async logGovernanceAction(
    communityId: string,
    actorUserId: string | null,
    action: GovernanceLogAction,
    targetUserId?: string | null,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.governanceLog.log({
        communityId,
        actorUserId,
        action,
        targetUserId,
        metadata,
      });
    } catch (error) {
      this.logger.error(
        `Failed to write governance log (${action}) for community ${communityId}: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /**
   * The owner + every mod on the roster, deduped and null-filtered — the
   * recipient set for staff-scoped notifications (join requests, freeze/
   * unfreeze). `Community.ownerId` can be null for an ownerless (post-
   * erasure, pre-promotion) community.
   */
  private async staffRecipientIds(community: Community): Promise<string[]> {
    const staff = await this.members.find({
      where: {
        communityId: community.id,
        role: In(CommunitiesService.STAFF_ROLES),
      },
      select: { userId: true },
    });
    return [
      ...new Set(
        [community.ownerId, ...staff.map((row) => row.userId)].filter(
          (id): id is string => id !== null,
        ),
      ),
    ];
  }

  /** Best-effort "your role changed" notification for `setMemberRole`. */
  private async notifyRoleChanged(
    community: Community,
    actorId: string,
    targetUserId: string,
    fromRole: RosterRole,
    toRole: RosterRole,
  ): Promise<void> {
    try {
      await this.notifications.create(
        targetUserId,
        NotificationType.CommunityRoleChanged,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
          fromRole,
          toRole,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the role change already committed.
    }
  }

  /** Best-effort "you were removed" notification for `removeMember` (never
   *  sent for a self-leave — see the caller). */
  private async notifyMemberRemoved(
    community: Community,
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        targetUserId,
        NotificationType.CommunityMemberRemoved,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the removal already committed.
    }
  }

  /**
   * Best-effort "you were removed and cannot re-join" notification, sent in
   * place of `notifyMemberRemoved` when the removal barred the return. Own
   * try/catch, exactly like every other notify helper here: a notification
   * failure must never surface as a failed removal.
   *
   * The payload now carries the TERMS (TS-10): the reason the moderator
   * recorded, the rule they cited, and the date the bar lifts when it is a
   * timed one. A ban used to reach the member as a bare fact, which left them
   * unable to tell a week's timeout from a life sentence and gave them nothing
   * to appeal against. This is the platform's only channel to them, since
   * QueerPulse sends no email and there is no way to message a community's
   * moderators.
   *
   * `actorId` still travels as the block/mute argument so that gate holds, and
   * is deliberately absent from the payload: the bell names the community and
   * never the moderator who acted.
   */
  private async notifyMemberBanned(
    community: Community,
    actorId: string,
    ban: CommunityBan,
  ): Promise<void> {
    try {
      await this.notifications.create(
        ban.userId,
        NotificationType.CommunityBanned,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
          reason: ban.reason,
          expiresAt: ban.expiresAt?.toISOString() ?? null,
          ruleText: ban.ruleText,
          ruleIndex: ban.ruleIndex,
          ruleVersion: ban.ruleVersion,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the removal already committed.
    }
  }

  /**
   * Two best-effort notifications for `transferOwnership`: one to the
   * incoming owner ("you are now owner"), one to the outgoing owner
   * ("ownership was transferred"), each own try/catch so one send failing
   * never suppresses the other.
   */
  private async notifyOwnershipTransferred(
    community: Community,
    fromOwnerId: string,
    toOwnerId: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        toOwnerId,
        NotificationType.CommunityOwnershipTransferred,
        {
          actorId: fromOwnerId,
          source: 'community',
          communitySlug: community.slug,
          youAreNowOwner: true,
          counterpartId: fromOwnerId,
        },
        fromOwnerId,
      );
    } catch {
      // Intentionally ignored — best-effort; the transfer already committed.
    }
    try {
      await this.notifications.create(
        fromOwnerId,
        NotificationType.CommunityOwnershipTransferred,
        {
          actorId: fromOwnerId,
          source: 'community',
          communitySlug: community.slug,
          youAreNowOwner: false,
          counterpartId: toOwnerId,
        },
        fromOwnerId,
      );
    } catch {
      // Intentionally ignored — best-effort; the transfer already committed.
    }
  }

  /** Best-effort "this community was archived" fan-out to the whole roster,
   *  for `archive`. Batched via `createForRecipients`, not row-by-row. */
  private async notifyRosterArchived(
    community: Community,
    actorId: string,
  ): Promise<void> {
    try {
      const rosterRows = await this.members.find({
        where: { communityId: community.id },
        select: { userId: true },
      });
      const recipientIds = rosterRows.map((row) => row.userId);
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunityArchived,
        { actorId, source: 'community', communitySlug: community.slug },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the archive already committed.
    }
  }

  /**
   * Best-effort freeze/unfreeze notification, scoped to staff only (owner +
   * mods) — operational, matching `notifyStaffOfJoinRequest`'s scope, not the
   * whole-roster fan-out `notifyRosterArchived` does.
   */
  private async notifyStaffFreezeChange(
    community: Community,
    type: NotificationType.CommunityFrozen | NotificationType.CommunityUnfrozen,
    actorId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const recipientIds = await this.staffRecipientIds(community);
      if (!recipientIds.length) return;
      await this.notifications.createForRecipients(
        recipientIds,
        type,
        {
          actorId,
          source: 'community',
          communitySlug: community.slug,
          ...metadata,
        },
        actorId,
      );
    } catch {
      // Intentionally ignored — best-effort; the freeze/unfreeze already committed.
    }
  }

  /**
   * Best-effort "you were invited" fan-out for `create`'s resolved `invites`
   * and `stewards`. NEITHER is a roster add — see `resolveInvitees`'s "no
   * consent-less roster adds" note. Runs after the create transaction has
   * committed (notification writes aren't part of it), so a failure here can
   * never roll back a successful community creation.
   *
   * Two fan-outs, not one: a steward's notification carries
   * `proposedRole: 'mod'` so the client can say "asked you to help moderate"
   * rather than a plain invite, and so the owner's intent survives to the
   * moment the steward joins and is promoted through `setMemberRole`.
   */
  private async notifyInvitees(
    community: Community,
    inviterId: string,
    invitedUserIds: string[],
    stewardUserIds: string[],
  ): Promise<void> {
    const payload = {
      actorId: inviterId,
      source: 'community',
      communitySlug: community.slug,
    };
    try {
      if (invitedUserIds.length) {
        await this.notifications.createForRecipients(
          invitedUserIds,
          NotificationType.CommunityInviteReceived,
          payload,
          inviterId,
        );
      }
      if (stewardUserIds.length) {
        await this.notifications.createForRecipients(
          stewardUserIds,
          NotificationType.CommunityInviteReceived,
          { ...payload, proposedRole: RosterRole.Mod },
          inviterId,
        );
      }
    } catch {
      // Intentionally ignored — best-effort; the community already exists.
    }
  }
}

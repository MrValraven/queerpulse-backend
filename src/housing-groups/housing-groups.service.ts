import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { assessHousingRisk } from '../housing-listings/housing-risk';
import { HousingListingType } from '../housing-listings/entities/housing-listing.entity';
import { HousingGroup } from './entities/housing-group.entity';
import {
  GroupJoinRequest,
  GroupJoinRequestStatus,
} from './entities/group-join-request.entity';
import {
  GroupListing,
  GroupListingStatus,
} from './entities/group-listing.entity';
import { CreateHousingGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { CreateGroupJoinRequestDto } from './dto/create-group-join-request.dto';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { UpdateGroupListingDto } from './dto/update-group-listing.dto';
import { HideGroupListingDto } from './dto/hide-group-listing.dto';
import { SetGroupListingStatusDto } from './dto/set-group-listing-status.dto';
import { ListGroupJoinRequestsQuery } from './dto/list-group-join-requests.query';
import { ListGroupListingQueueQuery } from './dto/list-group-listing-queue.query';
import {
  AdminGroupJoinRequestDTO,
  AdminGroupJoinRequestsPageDTO,
  AdminGroupListingDTO,
  AdminGroupListingsPageDTO,
  GroupListingDTO,
  HousingGroupDTO,
  MyGroupListingDTO,
  toAdminGroupJoinRequestDTO,
  toAdminGroupListingDTO,
  toGroupListingDTO,
  toHousingGroupDTO,
  toMyGroupListingDTO,
} from './housing-groups-response';

/** One page of the moderator's group-listing review queue (LOC-19). */
export const GROUP_LISTING_QUEUE_PAGE_SIZE = 20;

/** One page of the moderator's group join-request triage queue (ENG-41). Same
 * size as the listing queue beside it, so the two halves of the same console
 * page at the same rhythm. */
export const GROUP_JOIN_REQUEST_QUEUE_PAGE_SIZE = 20;

/** The subset of a group listing the risk scorer reads. Structurally satisfied
 * by both `CreateGroupListingDto` (submission) and the `GroupListing` entity
 * (an edit re-score), so `assessGroupListingRisk` serves both without either
 * side knowing about the other. */
type GroupListingRiskFields = Pick<
  GroupListing,
  'title' | 'description' | 'neighbourhood' | 'priceEuros' | 'accessibilityInfo'
>;

@Injectable()
export class HousingGroupsService {
  private readonly logger = new Logger(HousingGroupsService.name);

  constructor(
    @InjectRepository(HousingGroup)
    private readonly groups: Repository<HousingGroup>,
    @InjectRepository(GroupJoinRequest)
    private readonly joinRequests: Repository<GroupJoinRequest>,
    @InjectRepository(GroupListing)
    private readonly listings: Repository<GroupListing>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    // Read-only, for resolving a listing's poster into a `MemberRef` on the
    // moderator queue (LOC-19). Same `forFeature` overlap pattern as
    // `AdminReadingGroupProposalsService`, so no dependency on ProfilesModule.
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly affirmingPledge: AffirmingPledgeService,
    // Step-up gate + honest risk signal for a group listing (BE-HSG-01), the
    // same two things `HousingListingsService.create` reads it for.
    private readonly verification: VerificationService,
    // The poster is told what happened to their own submission, in-app plus
    // push (LOC-19). QueerPulse sends no email.
    private readonly notifications: NotificationsService,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async listPublished(): Promise<HousingGroupDTO[]> {
    const groups = await this.groups.find({
      where: { published: true },
      order: { createdAt: 'ASC' },
    });
    return groups.map(toHousingGroupDTO);
  }

  async getPublishedBySlug(slug: string): Promise<HousingGroupDTO> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    return toHousingGroupDTO(group);
  }

  /**
   * The group's PUBLIC listings. Two independent filters, both required
   * (BE-HSG-01): `status = live` is the pre-publication gate (a listing awaiting
   * or failing moderator review has never been public), and `hidden = false` is
   * the post-publication norm-violation takedown. Before the status column
   * existed this read returned every non-hidden row, which meant a brand-new
   * unreviewed listing was live to anonymous visitors the moment it was posted.
   */
  async listVisibleListings(slug: string): Promise<GroupListingDTO[]> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const listings = await this.listings.find({
      where: {
        groupId: group.id,
        status: GroupListingStatus.Live,
        hidden: false,
      },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return listings.map(toGroupListingDTO);
  }

  async listAllForAdmin(): Promise<HousingGroupDTO[]> {
    const groups = await this.groups.find({ order: { createdAt: 'ASC' } });
    return groups.map(toHousingGroupDTO);
  }

  async createGroup(dto: CreateHousingGroupDto): Promise<HousingGroupDTO> {
    const existing = await this.groups.findOne({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException('Slug already in use');
    try {
      const saved = await this.groups.save(
        this.groups.create({
          ...dto,
          nameEm: dto.nameEm ?? null,
          norms: dto.norms ?? [],
          screeningQuestions: dto.screeningQuestions ?? [],
        }),
      );
      return toHousingGroupDTO(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Slug already in use');
      }
      throw err;
    }
  }

  async updateGroup(id: string, dto: UpdateGroupDto): Promise<HousingGroupDTO> {
    const group = await this.groups.findOne({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');
    Object.assign(group, dto);
    try {
      return toHousingGroupDTO(await this.groups.save(group));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Slug already in use');
      }
      throw err;
    }
  }

  async deleteGroup(id: string): Promise<void> {
    const result = await this.groups.delete({ id });
    if (!result.affected) throw new NotFoundException('Group not found');
  }

  async createJoinRequest(
    slug: string,
    dto: CreateGroupJoinRequestDto,
    userId: string | null,
  ): Promise<{ id: string }> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');

    // Baseline gate: a signed-in member asking to join commits to the affirming
    // pledge. Anonymous applicants (userId null — the access-gated group model
    // deliberately lets a non-member ask to be let in) are NOT gated: requiring
    // a member-level pledge of someone who isn't a member yet is impossible, and
    // gating who may ASK to join would edge toward the very exclusion this design
    // avoids. Their commitment is captured at the point they become a member.
    if (userId) await this.affirmingPledge.requireAccepted(userId);

    // Access-gating enforcement: every REQUIRED screening question must have a
    // non-empty answer. Snapshot the prompt text alongside each answer so an
    // admin reviewer reads exactly what was asked.
    const answersById = new Map(
      (dto.answers ?? []).map((answer) => [
        answer.questionId,
        answer.answer.trim(),
      ]),
    );
    const snapshot = group.screeningQuestions.map((question) => {
      const answer = answersById.get(question.id) ?? '';
      if (question.required && answer.length === 0) {
        throw new BadRequestException(
          `Screening question "${question.prompt}" must be answered`,
        );
      }
      return { questionId: question.id, question: question.prompt, answer };
    });

    const saved = await this.joinRequests.save(
      this.joinRequests.create({
        groupId: group.id,
        name: dto.name,
        relationship: dto.relationship,
        answers: snapshot,
        note: dto.note ?? null,
        userId,
        status: GroupJoinRequestStatus.Pending,
      }),
    );
    return { id: saved.id };
  }

  /**
   * The steward/moderator triage queue for group join requests, paginated
   * (ENG-41).
   *
   * What this used to do, and why it was worse than a cap: it returned the
   * newest `DEFAULT_LIST_LIMIT` requests in EVERY status as a flat array, and
   * `AdminHousingGroupsPage` then filtered client-side to the pending ones. So
   * the cap did not merely hide the 201st request, it spent the whole budget on
   * already-decided rows. A group carrying 200 approvals newer than one pending
   * request showed a moderator an EMPTY queue while somebody waited. `status`
   * now filters in the query, `total` counts the whole filtered queue, and
   * `page` reaches the rest of it.
   *
   * ORDERING STAYS NEWEST-FIRST here, unlike the community and listing-claim
   * queues, and deliberately so: this is the ordering the console has always
   * shown, the queue is worked as an arrivals list, and nothing is hidden any
   * more, which was the actual defect. Changing the sort would be a separate,
   * product-visible decision.
   *
   * `.offset()`/`.limit()` rather than `.skip()`/`.take()`, matching
   * `listListingQueue` below: this query joins the group and pages it, which is
   * exactly the combination where TypeORM's DISTINCT-subquery pagination
   * misbehaves. And `computeMutualConnections` still runs as TWO bulk queries
   * for the whole page, never one per row.
   */
  async listJoinRequests(
    query: ListGroupJoinRequestsQuery = {},
  ): Promise<AdminGroupJoinRequestsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = GROUP_JOIN_REQUEST_QUEUE_PAGE_SIZE;

    const joinRequestsQuery = this.joinRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.group', 'group')
      // `created_at` alone is not a total order, so it is not a safe sort key for
      // offset pagination: two rows written in the same transaction share a
      // statement timestamp, and Postgres is then free to return that tie in
      // either order per query, which is how a row appears on two pages and
      // another appears on none. `id` breaks the tie deterministically. Same
      // reasoning as `PlatformSettingsService.listChanges`.
      .orderBy('request.createdAt', 'DESC')
      .addOrderBy('request.id', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    if (query.status) {
      joinRequestsQuery.andWhere('request.status = :status', {
        status: query.status,
      });
    }
    if (query.group) {
      joinRequestsQuery.andWhere('group.slug = :groupSlug', {
        groupSlug: query.group,
      });
    }

    const [requests, total] = await joinRequestsQuery.getManyAndCount();
    if (!requests.length) {
      return { items: [], total, page, pageSize };
    }

    // Nothing is filtered out after the fetch, so `total` is exactly the number
    // of rows these pages reach: every request renders, an anonymous applicant
    // simply reads `mutualConnections: null`.
    const mutuals = await this.computeMutualConnections(requests);
    const items = requests.map((request) =>
      toAdminGroupJoinRequestDTO(request, mutuals.get(request.id) ?? null),
    );
    return { items, total, page, pageSize };
  }

  /**
   * Best-effort "mutual connections" trust signal for the admin queue: for each
   * request submitted by a signed-in member, how many of that member's accepted
   * connections are already APPROVED members of the same group. Two extra bulk
   * queries for the whole PAGE (see `listJoinRequests`), no per-row N+1.
   * Returns a map keyed
   * by join-request id; requests without a `userId` are absent (→ `null`).
   *
   * Follow-up: this reads live approved-membership from join requests. If a
   * dedicated `group_members` table lands, key off that instead.
   */
  private async computeMutualConnections(
    requests: GroupJoinRequest[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const identified = requests.filter(
      (request): request is GroupJoinRequest & { userId: string } =>
        request.userId !== null,
    );
    if (identified.length === 0) return result;

    const groupIds = [...new Set(identified.map((request) => request.groupId))];
    const applicantIdSet = new Set(identified.map((request) => request.userId));
    const applicantIds = [...applicantIdSet];

    // Approved members per group (only those with a known user id).
    const approvedRows = await this.joinRequests.find({
      where: { groupId: In(groupIds), status: GroupJoinRequestStatus.Approved },
      select: { groupId: true, userId: true },
    });
    const membersByGroup = new Map<string, Set<string>>();
    for (const row of approvedRows) {
      if (!row.userId) continue;
      const set = membersByGroup.get(row.groupId) ?? new Set<string>();
      set.add(row.userId);
      membersByGroup.set(row.groupId, set);
    }

    // Each applicant's accepted-connection partners. Indexed by asking the
    // applicant-id set about each row once, rather than re-walking every
    // applicant id per row: a page of N requests otherwise scans the whole
    // accepted-connection set N times, and that product grows with both the
    // review queue and members' connection graphs.
    //
    // The two directions are tested independently (two `if`s, never
    // `if`/`else if`) because one row can join two applicants to each other,
    // and it has to be recorded under both of their ids.
    //
    // The loop reads exactly two columns, so the row is projected down to them
    // plus the primary key, which `getMany()` needs to de-duplicate entities.
    // The unbounded TEXT columns (`requestMessage`, `requestReason`) are
    // deliberately left unhydrated: a well-connected page of applicants can
    // match thousands of accepted connections, and none of that prose can
    // reach a return value that is only counts.
    const connectionRows = await this.connections
      .createQueryBuilder('connection')
      .select([
        'connection.id',
        'connection.requesterId',
        'connection.addresseeId',
      ])
      .where('connection.status = :accepted', {
        accepted: ConnectionStatus.Accepted,
      })
      .andWhere(
        '(connection.requesterId IN (:...applicantIds) OR connection.addresseeId IN (:...applicantIds))',
        { applicantIds },
      )
      .getMany();
    const partnersByApplicant = new Map<string, Set<string>>();
    for (const connectionRow of connectionRows) {
      if (applicantIdSet.has(connectionRow.requesterId)) {
        const partners =
          partnersByApplicant.get(connectionRow.requesterId) ??
          new Set<string>();
        partners.add(connectionRow.addresseeId);
        partnersByApplicant.set(connectionRow.requesterId, partners);
      }
      if (applicantIdSet.has(connectionRow.addresseeId)) {
        const partners =
          partnersByApplicant.get(connectionRow.addresseeId) ??
          new Set<string>();
        partners.add(connectionRow.requesterId);
        partnersByApplicant.set(connectionRow.addresseeId, partners);
      }
    }

    for (const request of identified) {
      const partners = partnersByApplicant.get(request.userId);
      const members = membersByGroup.get(request.groupId);
      if (!partners || !members) {
        result.set(request.id, 0);
        continue;
      }
      let count = 0;
      for (const partnerId of partners) {
        if (partnerId !== request.userId && members.has(partnerId)) count += 1;
      }
      result.set(request.id, count);
    }
    return result;
  }

  async triageJoinRequest(
    id: string,
    action: 'approved' | 'declined',
  ): Promise<AdminGroupJoinRequestDTO> {
    const request = await this.joinRequests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Join request not found');
    request.status =
      action === 'approved'
        ? GroupJoinRequestStatus.Approved
        : GroupJoinRequestStatus.Declined;
    await this.joinRequests.save(request);
    // The roster IS the set of approved join requests — `computeMutualConnections`
    // above already reads membership that way. Recount after every decision so
    // the published "N members" figure follows the roster instead of being an
    // admin-typed number that drifts from it.
    await this.refreshMemberCount(request.groupId);
    const updated = await this.joinRequests.findOne({
      where: { id },
      relations: { group: true },
    });
    const [mutual] = [
      ...(await this.computeMutualConnections([updated!])).values(),
    ];
    return toAdminGroupJoinRequestDTO(updated!, mutual ?? null);
  }

  /**
   * Recompute `housing_groups.member_count` from the approved join requests.
   *
   * A full recount rather than an increment/decrement: triage can move a
   * request in either direction (and back), so a delta would drift, whereas
   * this is self-healing — one COUNT and one UPDATE per decision, off the read
   * path entirely so the group page stays a single row read.
   */
  private async refreshMemberCount(groupId: string): Promise<void> {
    const memberCount = await this.joinRequests.count({
      where: { groupId, status: GroupJoinRequestStatus.Approved },
    });
    await this.groups.update({ id: groupId }, { memberCount });
  }

  /**
   * Share a housing listing into a group. Carries the SAME three gates the
   * sibling member-listing surface forces (`HousingListingsService.create`) —
   * before BE-HSG-01 this path had only the first of them, so any member who
   * had ticked the pledge could publish an unreviewed advert straight to
   * anonymous visitors:
   *
   *  1. the mandatory LGBTQ+ affirming pledge (the universal baseline),
   *  2. a phone-verification step-up, because the result is publicly browsable,
   *  3. the deterministic `assessHousingRisk` pass (which includes the
   *     discriminatory-language scan), stored for the moderation queue.
   *
   * And, like the sibling, it lands in `review` — never public until a human
   * clears it. The risk score deliberately does NOT refuse a submission on its
   * own: it sorts the moderator queue riskiest-first, exactly as it does for
   * member listings, and the review state is what actually keeps content off
   * the public page.
   */
  async createListing(
    slug: string,
    dto: CreateGroupListingDto,
    userId: string | null,
  ): Promise<MyGroupListingDTO> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    // `userId` is typed nullable to mirror `createJoinRequest`'s anonymous
    // path, but the only caller (`POST /housing-groups/:slug/listings`) is
    // `ActiveMemberGuard`-gated, so in practice it is always a member.
    let listerLevel = VerificationLevel.Email;
    if (userId) {
      // Baseline gate: sharing a listing into a group is a member action —
      // commit to the affirming pledge first.
      await this.affirmingPledge.requireAccepted(userId);
      // Step-up gate: what this produces is a publicly-browsable housing
      // advert, so it needs at least a phone-verified account.
      await this.verification.requireLevel(userId, VerificationLevel.Phone);
      // The poster's real assurance level is itself a risk signal.
      listerLevel = await this.verification.levelForUser(userId);
    }
    const assessment = this.assessGroupListingRisk(dto, listerLevel);
    const saved = await this.listings.save(
      this.listings.create({
        groupId: group.id,
        status: GroupListingStatus.Review,
        title: dto.title,
        description: dto.description,
        neighbourhood: dto.neighbourhood,
        priceEuros: dto.priceEuros,
        accessibilityInfo: dto.accessibilityInfo,
        riskScore: assessment.score,
        riskReasons: assessment.reasons,
        postedByUserId: userId,
      }),
    );
    // Every listing lands in `review` straight away (there is no draft
    // state), so `createListing` IS the submit-for-review path. Tell whoever
    // works the housing-group-listing queue that a new one landed. Awaited,
    // but safe to await: `announce` catches everything internally, so a
    // notification failure can never fail the poster's submission.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.HousingGroupListings,
      saved.id,
    );
    // The poster's own view, so the 201 already carries `status: 'review'`.
    // Answering a submission with the public DTO left the client with nothing
    // to show but a title, and no honest way to say what happens next.
    return toMyGroupListingDTO(saved, group);
  }

  /**
   * Runs the shared housing risk scorer over a group listing's submitted text.
   *
   * Two structural notes on the mapping, both deliberate:
   *  - `type` is `Room`: a group listing is a room/place inside a shared home
   *    priced per month, which is exactly what the `Room` rent band models.
   *  - `gallery`/`features` are empty because the group-listing schema has no
   *    photo or amenity fields at all. That makes the scorer's `no_photos`
   *    signal a CONSTANT +5 on every group listing rather than a discriminating
   *    one, so it never changes the queue's relative ordering. Left in place
   *    rather than special-cased, so this surface's score stays directly
   *    comparable with a member listing's.
   */
  private assessGroupListingRisk(
    listing: GroupListingRiskFields,
    listerVerificationLevel: VerificationLevel,
  ) {
    return assessHousingRisk({
      type: HousingListingType.Room,
      title: listing.title,
      // A group listing has no separate short blurb — the neighbourhood is the
      // only other free text on the row, and it is member-typed, so it is
      // scanned too rather than silently exempted.
      blurb: listing.neighbourhood,
      description: `${listing.description} ${listing.accessibilityInfo}`,
      rentEuros: listing.priceEuros,
      accessibilityInfo: listing.accessibilityInfo,
      gallery: [],
      features: [],
      listerVerificationLevel,
    });
  }

  /**
   * The POSTER corrects their own listing (BE-HSG-20). Before this, the only
   * member write on a group listing was the create: a typo in the price could
   * not be fixed and a room that had been let stayed advertised forever, with
   * the poster having to ask a moderator to hide their own post.
   *
   * An edit that changes what the group page shows re-opens the review, exactly
   * as an owner edit does on the sibling member-listing surface (BE-HSG-02):
   * the alternative is a listing approved clean and then rewritten in place.
   * LOC-19 widened that from `live` to every decided state, so answering a
   * moderator's question or fixing what a refusal named actually puts the room
   * back in the queue.
   */
  async updateListing(
    slug: string,
    id: string,
    dto: UpdateGroupListingDto,
    userId: string,
  ): Promise<MyGroupListingDTO> {
    const { group, listing } = await this.loadPostedListingOr404(
      slug,
      id,
      userId,
    );
    const before = this.listingContentFingerprint(listing);
    Object.assign(listing, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.neighbourhood !== undefined
        ? { neighbourhood: dto.neighbourhood }
        : {}),
      ...(dto.priceEuros !== undefined ? { priceEuros: dto.priceEuros } : {}),
      ...(dto.accessibilityInfo !== undefined
        ? { accessibilityInfo: dto.accessibilityInfo }
        : {}),
    });
    // Re-score against the edited text, for the same reason the sibling does: a
    // listing that was clean at submission can be edited into a scam price or
    // discriminatory copy, and the queue must reflect what it says NOW.
    const level = await this.verification.levelForUser(userId);
    const assessment = this.assessGroupListingRisk(listing, level);
    listing.riskScore = assessment.score;
    listing.riskReasons = assessment.reasons;
    // A content change re-opens the review from ANY decided state, not just
    // `live`. Restricting it to `live` left the two states an edit is the
    // ANSWER to permanently stuck: a poster asked a question, or told what to
    // fix, could rewrite their room and it stayed `question`/`declined`
    // forever, because nothing put it back in front of a moderator. A listing
    // already sitting in `review` is left where it is, since it is queued.
    if (
      listing.status !== GroupListingStatus.Review &&
      this.listingContentFingerprint(listing) !== before
    ) {
      listing.status = GroupListingStatus.Review;
      // A re-opened review is a fresh one: the previous verdict and its reason
      // are cleared rather than left standing against text nobody has read yet.
      listing.decidedAt = null;
      listing.decidedBy = null;
      listing.decisionReason = null;
    }
    return toMyGroupListingDTO(await this.listings.save(listing), group);
  }

  /**
   * The POSTER withdraws their own listing (BE-HSG-20) — the "I found someone"
   * / "this is let" path. A hard delete rather than a hide: `hidden` is the
   * MODERATOR's norm-violation takedown and carries a `hiddenReason` for the
   * audit trail, and overloading it with "the poster is done" would make the
   * moderation queue lie about why a listing is down.
   */
  async removeListing(slug: string, id: string, userId: string): Promise<void> {
    const { listing } = await this.loadPostedListingOr404(slug, id, userId);
    await this.listings.remove(listing);
  }

  /**
   * Every room the caller has submitted to this group, in whatever state it is
   * in (LOC-19). The public group read shows only what a moderator has cleared,
   * so before this existed a member who posted a room saw it vanish and had no
   * surface anywhere that could tell them it was waiting, had gone up, had a
   * question against it, or had been refused.
   *
   * Their own rows, resolved by `postedByUserId`, so ownership is the query
   * rather than something the client asserts and a 403 corrects afterwards.
   */
  async listMyListings(
    slug: string,
    userId: string,
  ): Promise<MyGroupListingDTO[]> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const listings = await this.listings.find({
      where: { groupId: group.id, postedByUserId: userId },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return listings.map((listing) => toMyGroupListingDTO(listing, group));
  }

  /** Loads a listing in the given group that the caller actually posted, with
   * the group it belongs to. 404 for a listing that is not in this group, 403
   * for someone else's (and for a listing with no recorded poster, which
   * nobody can edit). */
  private async loadPostedListingOr404(
    slug: string,
    id: string,
    userId: string,
  ): Promise<{ group: HousingGroup; listing: GroupListing }> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const listing = await this.listings.findOne({
      where: { id, groupId: group.id },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (!listing.postedByUserId || listing.postedByUserId !== userId) {
      throw new ForbiddenException('Only the poster can do that');
    }
    // The group rides back with the listing because the poster-facing DTO
    // names the group it belongs to, and the relation is never loaded here.
    return { group, listing };
  }

  /** The fields the group page actually shows, fingerprinted so `updateListing`
   * can tell a real edit from a PATCH that re-sends the same values. */
  private listingContentFingerprint(listing: GroupListing): string {
    return JSON.stringify([
      listing.title,
      listing.description,
      listing.neighbourhood,
      listing.priceEuros,
      listing.accessibilityInfo,
    ]);
  }

  async listAllListingsForAdmin(
    groupSlug?: string,
  ): Promise<AdminGroupListingDTO[]> {
    // RISKIEST first, then newest — the same queue order the sibling
    // `HousingListingsService.listAllForAdmin` uses, so the listings most
    // likely to carry discriminatory text, a scam price or off-platform payment
    // language surface at the top with their machine reasons attached.
    const query = this.listings
      .createQueryBuilder('listing')
      .leftJoinAndSelect('listing.group', 'group')
      .orderBy('listing.riskScore', 'DESC')
      .addOrderBy('listing.createdAt', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (groupSlug) query.where('group.slug = :groupSlug', { groupSlug });
    const listings = await query.getMany();
    // Explicit arrow: `toAdminGroupListingDTO`'s second parameter is the
    // poster ref, and a bare point-free `.map` would hand it the array index.
    return listings.map((listing) => toAdminGroupListingDTO(listing));
  }

  /**
   * The paginated review queue a moderator actually works from (LOC-19).
   *
   * Sibling of `listAllListingsForAdmin`, which stays exactly as it is: that
   * one returns a single uncapped slab of every listing ever posted for the
   * existing admin-housing console, and this one answers "what is still
   * waiting on me", filtered and paged, with the poster resolved so a decision
   * can be addressed to a person.
   *
   * Ordering is riskiest-first then newest, the same order the slab uses, so
   * the listings most likely to carry discriminatory text, a scam price or
   * off-platform payment language surface at the top with their machine
   * reasons attached.
   *
   * `.offset()`/`.limit()` rather than `.skip()`/`.take()`: this query joins
   * the group and pages it, which is exactly the combination where TypeORM's
   * DISTINCT-subquery pagination misbehaves. The two profile lookups are ONE
   * batched query for the whole page, never one per row.
   */
  async listListingQueue(
    query: ListGroupListingQueueQuery,
  ): Promise<AdminGroupListingsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = GROUP_LISTING_QUEUE_PAGE_SIZE;

    const listingQueryBuilder = this.listings
      .createQueryBuilder('listing')
      .leftJoinAndSelect('listing.group', 'group')
      .orderBy('listing.riskScore', 'DESC')
      .addOrderBy('listing.createdAt', 'DESC')
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    if (query.status) {
      listingQueryBuilder.andWhere('listing.status = :status', {
        status: query.status,
      });
    }
    if (query.group) {
      listingQueryBuilder.andWhere('group.slug = :groupSlug', {
        groupSlug: query.group,
      });
    }
    if (query.hidden !== undefined) {
      listingQueryBuilder.andWhere('listing.hidden = :hidden', {
        hidden: query.hidden,
      });
    }

    const [rows, total] = await listingQueryBuilder.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const posterIds = [
      ...new Set(
        rows
          .map((listing) => listing.postedByUserId)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];
    const refsByUserId = posterIds.length
      ? await new MemberLookup(this.profiles).byUserIds(posterIds)
      : new Map<string, MemberRef>();

    const items = rows.map((listing) =>
      toAdminGroupListingDTO(
        listing,
        listing.postedByUserId
          ? (refsByUserId.get(listing.postedByUserId) ?? null)
          : null,
      ),
    );

    return { items, total, page, pageSize };
  }

  /**
   * Moderator/admin: move a group listing through its pre-publication review
   * (BE-HSG-01). This is the ONLY way a listing becomes public — members never
   * self-transition, mirroring `HousingListingsService.setStatus`.
   *
   * LOC-19 turned this from a status write into a decision (the whole point of
   * the item: a member submitted a room and the platform acknowledged receipt
   * and did nothing):
   *  - `declined` and `question` REQUIRE a reason. A refusal with no sentence
   *    attached, and a question with no question in it, are the two failures
   *    this endpoint exists to stop.
   *  - Who decided, when, and why are recorded on the row.
   *  - The poster is told, in-app plus push, for every outcome except a return
   *    to `review`. That one is the queue's own bookkeeping ("nobody has
   *    decided yet"), so there is nothing to report.
   *
   * IDEMPOTENT on a repeat of the same decision: a listing already carrying
   * that exact `status` with a decision stamped is returned unchanged, so a
   * double-clicked approve or a second moderator working the same queue cannot
   * send the poster the same verdict twice.
   */
  async setListingStatus(
    id: string,
    dto: SetGroupListingStatusDto,
    adminUserId: string,
  ): Promise<AdminGroupListingDTO> {
    const reason = HousingGroupsService.trimToNull(dto.reason);
    const isRefusal = dto.status === GroupListingStatus.Declined;
    const isQuestion = dto.status === GroupListingStatus.Question;
    if (!reason && (isRefusal || isQuestion)) {
      throw new BadRequestException(
        isRefusal
          ? 'A declined listing needs a reason the poster can read.'
          : 'Send the poster the question you need answered.',
      );
    }

    const listing = await this.listings.findOne({
      where: { id },
      relations: { group: true },
    });
    if (!listing) throw new NotFoundException('Listing not found');

    if (listing.status === dto.status && listing.decidedAt) {
      return this.toAdminListingDTO(listing);
    }

    listing.status = dto.status;
    listing.decidedAt = new Date();
    listing.decidedBy = adminUserId;
    listing.decisionReason = reason;
    await this.listings.save(listing);

    if (dto.status !== GroupListingStatus.Review) {
      await this.notifyListingDecided(listing, dto.status, reason);
    }

    return this.toAdminListingDTO(listing);
  }

  /** Hand-map a listing to the admin DTO with its poster resolved. */
  private async toAdminListingDTO(
    listing: GroupListing,
  ): Promise<AdminGroupListingDTO> {
    if (!listing.postedByUserId) return toAdminGroupListingDTO(listing, null);
    const refsByUserId = await new MemberLookup(this.profiles).byUserIds([
      listing.postedByUserId,
    ]);
    return toAdminGroupListingDTO(
      listing,
      refsByUserId.get(listing.postedByUserId) ?? null,
    );
  }

  /**
   * Best-effort "here is what happened to the room you posted" to the poster,
   * in-app plus push. Never throws: the decision has already committed by the
   * time this runs, and a notification failure must not turn a completed
   * review into a 500 the moderator retries into a second decision.
   *
   * Only the listing's title, the group it was posted into and the moderator's
   * own words travel. The description, price and accessibility text stay on
   * the page the deep link opens.
   */
  private async notifyListingDecided(
    listing: GroupListing,
    status: GroupListingStatus,
    reason: string | null,
  ): Promise<void> {
    if (!listing.postedByUserId) return;
    try {
      await this.notifications.create(
        listing.postedByUserId,
        NotificationType.GroupListingDecided,
        {
          source: 'housing_group',
          decision: status,
          listingTitle: listing.title,
          ...(listing.group
            ? { groupSlug: listing.group.slug, groupName: listing.group.name }
            : {}),
          ...(reason ? { reason } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to notify poster of group listing ${listing.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Empty or whitespace-only free text stores as NULL, never as a blank. */
  private static trimToNull(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }

  async setListingHidden(
    id: string,
    dto: HideGroupListingDto,
  ): Promise<AdminGroupListingDTO> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    listing.hidden = dto.hidden;
    listing.hiddenReason = dto.hidden ? (dto.reason ?? null) : null;
    await this.listings.save(listing);
    const updated = await this.listings.findOne({
      where: { id },
      relations: { group: true },
    });
    return this.toAdminListingDTO(updated!);
  }
}

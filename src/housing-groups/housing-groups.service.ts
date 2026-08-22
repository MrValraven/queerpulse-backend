import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
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
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { CreateGroupJoinRequestDto } from './dto/create-group-join-request.dto';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { UpdateGroupListingDto } from './dto/update-group-listing.dto';
import { HideGroupListingDto } from './dto/hide-group-listing.dto';
import { SetGroupListingStatusDto } from './dto/set-group-listing-status.dto';
import {
  AdminGroupJoinRequestDTO,
  AdminGroupListingDTO,
  GroupListingDTO,
  HousingGroupDTO,
  toAdminGroupJoinRequestDTO,
  toAdminGroupListingDTO,
  toGroupListingDTO,
  toHousingGroupDTO,
} from './housing-groups-response';

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
  constructor(
    @InjectRepository(HousingGroup)
    private readonly groups: Repository<HousingGroup>,
    @InjectRepository(GroupJoinRequest)
    private readonly joinRequests: Repository<GroupJoinRequest>,
    @InjectRepository(GroupListing)
    private readonly listings: Repository<GroupListing>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    private readonly affirmingPledge: AffirmingPledgeService,
    // Step-up gate + honest risk signal for a group listing (BE-HSG-01), the
    // same two things `HousingListingsService.create` reads it for.
    private readonly verification: VerificationService,
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

  async createGroup(dto: CreateGroupDto): Promise<HousingGroupDTO> {
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

  async listJoinRequests(
    groupSlug?: string,
  ): Promise<AdminGroupJoinRequestDTO[]> {
    const query = this.joinRequests
      .createQueryBuilder('request')
      .leftJoinAndSelect('request.group', 'group')
      .orderBy('request.createdAt', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (groupSlug) query.where('group.slug = :groupSlug', { groupSlug });
    const requests = await query.getMany();

    const mutuals = await this.computeMutualConnections(requests);
    return requests.map((request) =>
      toAdminGroupJoinRequestDTO(request, mutuals.get(request.id) ?? null),
    );
  }

  /**
   * Best-effort "mutual connections" trust signal for the admin queue: for each
   * request submitted by a signed-in member, how many of that member's accepted
   * connections are already APPROVED members of the same group. Two extra bulk
   * queries for the whole (bounded) list — no per-row N+1. Returns a map keyed
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
    const applicantIds = [
      ...new Set(identified.map((request) => request.userId)),
    ];

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

    // Each applicant's accepted-connection partners.
    const connectionRows = await this.connections
      .createQueryBuilder('connection')
      .where('connection.status = :accepted', {
        accepted: ConnectionStatus.Accepted,
      })
      .andWhere(
        '(connection.requesterId IN (:...applicantIds) OR connection.addresseeId IN (:...applicantIds))',
        { applicantIds },
      )
      .getMany();
    const partnersByApplicant = new Map<string, Set<string>>();
    for (const row of connectionRows) {
      for (const applicantId of applicantIds) {
        let partnerId: string | null = null;
        if (row.requesterId === applicantId) partnerId = row.addresseeId;
        else if (row.addresseeId === applicantId) partnerId = row.requesterId;
        if (!partnerId) continue;
        const set = partnersByApplicant.get(applicantId) ?? new Set<string>();
        set.add(partnerId);
        partnersByApplicant.set(applicantId, set);
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
  ): Promise<GroupListingDTO> {
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
    return toGroupListingDTO(saved);
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
   */
  async updateListing(
    slug: string,
    id: string,
    dto: UpdateGroupListingDto,
    userId: string,
  ): Promise<GroupListingDTO> {
    const listing = await this.loadPostedListingOr404(slug, id, userId);
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
    if (
      listing.status === GroupListingStatus.Live &&
      this.listingContentFingerprint(listing) !== before
    ) {
      listing.status = GroupListingStatus.Review;
    }
    return toGroupListingDTO(await this.listings.save(listing));
  }

  /**
   * The POSTER withdraws their own listing (BE-HSG-20) — the "I found someone"
   * / "this is let" path. A hard delete rather than a hide: `hidden` is the
   * MODERATOR's norm-violation takedown and carries a `hiddenReason` for the
   * audit trail, and overloading it with "the poster is done" would make the
   * moderation queue lie about why a listing is down.
   */
  async removeListing(slug: string, id: string, userId: string): Promise<void> {
    const listing = await this.loadPostedListingOr404(slug, id, userId);
    await this.listings.remove(listing);
  }

  /** Loads a listing in the given group that the caller actually posted.
   * 404 for a listing that is not in this group, 403 for someone else's (and
   * for a listing with no recorded poster, which nobody can edit). */
  private async loadPostedListingOr404(
    slug: string,
    id: string,
    userId: string,
  ): Promise<GroupListing> {
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
    return listing;
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
    return listings.map(toAdminGroupListingDTO);
  }

  /**
   * Moderator/admin: move a group listing through its pre-publication review
   * (BE-HSG-01). This is the ONLY way a listing becomes public — members never
   * self-transition, mirroring `HousingListingsService.setStatus`.
   */
  async setListingStatus(
    id: string,
    dto: SetGroupListingStatusDto,
  ): Promise<AdminGroupListingDTO> {
    const listing = await this.listings.findOne({ where: { id } });
    if (!listing) throw new NotFoundException('Listing not found');
    listing.status = dto.status;
    await this.listings.save(listing);
    const updated = await this.listings.findOne({
      where: { id },
      relations: { group: true },
    });
    return toAdminGroupListingDTO(updated!);
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
    return toAdminGroupListingDTO(updated!);
  }
}

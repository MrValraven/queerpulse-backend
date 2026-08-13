import {
  BadRequestException,
  ConflictException,
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
import { HousingGroup } from './entities/housing-group.entity';
import {
  GroupJoinRequest,
  GroupJoinRequestStatus,
} from './entities/group-join-request.entity';
import { GroupListing } from './entities/group-listing.entity';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { CreateGroupJoinRequestDto } from './dto/create-group-join-request.dto';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { HideGroupListingDto } from './dto/hide-group-listing.dto';
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

  /** The group's visible listings — hidden (norm-violating) ones are excluded. */
  async listVisibleListings(slug: string): Promise<GroupListingDTO[]> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    const listings = await this.listings.find({
      where: { groupId: group.id, hidden: false },
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
    const updated = await this.joinRequests.findOne({
      where: { id },
      relations: { group: true },
    });
    const [mutual] = [
      ...(await this.computeMutualConnections([updated!])).values(),
    ];
    return toAdminGroupJoinRequestDTO(updated!, mutual ?? null);
  }

  async createListing(
    slug: string,
    dto: CreateGroupListingDto,
    userId: string | null,
  ): Promise<GroupListingDTO> {
    const group = await this.groups.findOne({
      where: { slug, published: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    // Baseline gate: sharing a listing into a group is a member action — commit
    // to the affirming pledge first.
    if (userId) await this.affirmingPledge.requireAccepted(userId);
    const saved = await this.listings.save(
      this.listings.create({
        groupId: group.id,
        title: dto.title,
        description: dto.description,
        neighbourhood: dto.neighbourhood,
        priceEuros: dto.priceEuros,
        accessibilityInfo: dto.accessibilityInfo,
        postedByUserId: userId,
      }),
    );
    return toGroupListingDTO(saved);
  }

  async listAllListingsForAdmin(
    groupSlug?: string,
  ): Promise<AdminGroupListingDTO[]> {
    const query = this.listings
      .createQueryBuilder('listing')
      .leftJoinAndSelect('listing.group', 'group')
      .orderBy('listing.createdAt', 'DESC')
      .take(DEFAULT_LIST_LIMIT);
    if (groupSlug) query.where('group.slug = :groupSlug', { groupSlug });
    const listings = await query.getMany();
    return listings.map(toAdminGroupListingDTO);
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

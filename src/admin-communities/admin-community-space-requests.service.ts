import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { MemberLookup } from '../common/member-ref';
import { PAGE_SIZE } from '../common/pagination';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { Community } from '../communities/entities/community.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from '../communities/entities/community-space-request.entity';
import { SPACE_REQUEST_NOT_OPEN_CODE } from '../communities/subcommunity-rules';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminCommunitiesService } from './admin-communities.service';
import {
  AdminCommunitySpaceRequestDTO,
  AdminCommunitySpaceRequestsPageDTO,
  toAdminCommunitySpaceRequestDTO,
} from './admin-community-space-requests-response';
import { ListAdminCommunitySpaceRequestsQuery } from './dto/list-admin-community-space-requests.query';

/**
 * The `admin/community-space-requests` queue. Approving hands off to
 * `AdminCommunitiesService.updateSettings`, which switches spaces on, writes
 * the governance entry and closes the request (through
 * `SpaceRequestApprovalsService`), so this service never writes an approval
 * itself.
 */
@Injectable()
export class AdminCommunitySpaceRequestsService {
  constructor(
    @InjectRepository(CommunitySpaceRequest)
    private readonly requests: Repository<CommunitySpaceRequest>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly adminCommunities: AdminCommunitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    query: ListAdminCommunitySpaceRequestsQuery,
    actorRole: string,
  ): Promise<AdminCommunitySpaceRequestsPageDTO> {
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
    const page = query.page && query.page > 0 ? query.page : 1;
    const queryBuilder = this.requests
      .createQueryBuilder('request')
      .orderBy('request.createdAt', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);
    if (query.status) {
      queryBuilder.andWhere('request.status = :status', {
        status: query.status,
      });
    }
    const [rows, total] = await queryBuilder.getManyAndCount();
    if (!rows.length) return { items: [], total, page, pageSize: PAGE_SIZE };

    const communityIds = [...new Set(rows.map((row) => row.communityId))];
    const communityRows = await this.communities.find({
      where: { id: In(communityIds) },
    });
    const communitiesById = new Map(
      communityRows.map((community) => [community.id, community]),
    );
    const requesters = await new MemberLookup(this.profiles).byUserIds(
      isPlatformStaffReader
        ? [...new Set(rows.map((row) => row.requestedByUserId))]
        : [],
    );
    return {
      items: rows.map((row) =>
        toAdminCommunitySpaceRequestDTO(
          row,
          communitiesById.get(row.communityId) ?? null,
          requesters.get(row.requestedByUserId) ?? null,
          isPlatformStaffReader,
        ),
      ),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }

  async approve(
    id: string,
    adminUserId: string,
    actorRole: string,
  ): Promise<AdminCommunitySpaceRequestDTO> {
    const request = await this.loadOpen(id);
    const community = await this.loadCommunity(request.communityId);
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
    await this.adminCommunities.updateSettings(
      community.slug,
      { allowsSubcommunities: true },
      adminUserId,
      isPlatformStaffReader,
    );
    const decided = (await this.requests.findOne({ where: { id } })) ?? request;
    return this.toDto(decided, community, isPlatformStaffReader);
  }

  async decline(
    id: string,
    adminUserId: string,
    reason: string | undefined,
    actorRole: string,
  ): Promise<AdminCommunitySpaceRequestDTO> {
    const request = await this.loadOpen(id);
    const community = await this.loadCommunity(request.communityId);
    const decidedAt = new Date();
    const declineReason = toStoredPlainTextOrNull(reason);
    // Conditional on status still being `open`: a concurrent approval or
    // withdraw may have already closed this row between the read above and
    // this write, and the last writer must not overwrite a terminal status.
    const result = await this.requests.update(
      { id: request.id, status: CommunitySpaceRequestStatus.Open },
      {
        status: CommunitySpaceRequestStatus.Declined,
        decidedAt,
        decidedByUserId: adminUserId,
        declineReason,
      },
    );
    if (!result.affected) {
      throw AdminCommunitySpaceRequestsService.notOpenConflict();
    }
    const saved: CommunitySpaceRequest = {
      ...request,
      status: CommunitySpaceRequestStatus.Declined,
      decidedAt,
      decidedByUserId: adminUserId,
      declineReason,
    };
    try {
      await this.notifications.create(
        saved.requestedByUserId,
        NotificationType.CommunitySpaceRequestDeclined,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
        },
      );
    } catch {
      // The decline stands; the reason also shows in the Spaces pane.
    }
    return this.toDto(saved, community, isPlatformStaffTier(actorRole));
  }

  private async loadOpen(id: string): Promise<CommunitySpaceRequest> {
    const request = await this.requests.findOne({ where: { id } });
    if (!request) throw new NotFoundException('Space request not found');
    if (request.status !== CommunitySpaceRequestStatus.Open) {
      throw AdminCommunitySpaceRequestsService.notOpenConflict();
    }
    return request;
  }

  private static notOpenConflict(): ConflictException {
    return new ConflictException({
      message: 'This space request is no longer open',
      code: SPACE_REQUEST_NOT_OPEN_CODE,
    });
  }

  private async loadCommunity(communityId: string): Promise<Community> {
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) throw new NotFoundException('Community not found');
    return community;
  }

  private async toDto(
    request: CommunitySpaceRequest,
    community: Community,
    isPlatformStaffReader: boolean,
  ): Promise<AdminCommunitySpaceRequestDTO> {
    const requesters = await new MemberLookup(this.profiles).byUserIds(
      isPlatformStaffReader ? [request.requestedByUserId] : [],
    );
    return toAdminCommunitySpaceRequestDTO(
      request,
      community,
      requesters.get(request.requestedByUserId) ?? null,
      isPlatformStaffReader,
    );
  }
}

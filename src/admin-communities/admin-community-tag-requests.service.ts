import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CommunityTagRequest,
  CommunityTagRequestStatus,
} from '../communities/entities/community-tag-request.entity';
import { Community } from '../communities/entities/community.entity';
import { MemberLookup } from '../common/member-ref';
import { PAGE_SIZE } from '../common/pagination';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  AdminCommunityTagRequestCommunityDTO,
  AdminCommunityTagRequestDTO,
  AdminCommunityTagRequestsPageDTO,
  toAdminCommunityTagRequestDTO,
} from './admin-community-tag-requests-response';
import { ListAdminCommunityTagRequestsQuery } from './dto/list-admin-community-tag-requests.query';

/**
 * Read model + resolve transition behind the admin "suggest a tag" review
 * queue. INFORMATIONAL ONLY: resolving a request flips its `status` and
 * notifies the requester, but never writes to `COMMUNITY_TAGS` or
 * `Community.tags` — that stays a hardcoded, code-reviewed array by
 * deliberate product decision (see `CommunityTagRequest`'s docstring). An
 * admin who acts on a request does so by hand, in a separate future code
 * change. Mirrors `AdminResourceSuggestionsService`, including resolving
 * both the community and the requester in one batched lookup per page, never
 * one query per row.
 */
@Injectable()
export class AdminCommunityTagRequestsService {
  constructor(
    @InjectRepository(CommunityTagRequest)
    private readonly tagRequests: Repository<CommunityTagRequest>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    query: ListAdminCommunityTagRequestsQuery,
  ): Promise<AdminCommunityTagRequestsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;

    const qb = this.tagRequests
      .createQueryBuilder('request')
      .orderBy('request.createdAt', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    if (query.status) {
      qb.andWhere('request.status = :status', { status: query.status });
    }

    const [rows, total] = await qb.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize: PAGE_SIZE };
    }

    const [communitiesById, requestersByUserId] = await Promise.all([
      this.communitiesById([...new Set(rows.map((row) => row.communityId))]),
      new MemberLookup(this.profiles).byUserIds([
        ...new Set(rows.map((row) => row.requestedByUserId)),
      ]),
    ]);

    const items = rows.map((row) =>
      toAdminCommunityTagRequestDTO(
        row,
        communitiesById.get(row.communityId) ?? null,
        requestersByUserId.get(row.requestedByUserId) ?? null,
      ),
    );

    return { items, total, page, pageSize: PAGE_SIZE };
  }

  /**
   * Marks a request resolved and notifies the requester — the "we saw your
   * feedback" close of the loop. Does NOT touch `COMMUNITY_TAGS` or
   * `Community.tags`; see this class's docstring. Idempotent-adjacent but not
   * idempotent: resolving an already-resolved request re-stamps
   * `resolvedAt`/`resolvedByUserId` and re-notifies, mirroring
   * `AdminResourceSuggestionsService.decide`'s lack of a status guard (the
   * admin UI does not expose a re-resolve control, so this is a defensive
   * default, not a relied-upon behaviour).
   */
  async resolve(
    id: string,
    adminUserId: string,
  ): Promise<AdminCommunityTagRequestDTO> {
    const request = await this.tagRequests.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Tag request not found');
    }

    request.status = CommunityTagRequestStatus.Resolved;
    request.resolvedAt = new Date();
    request.resolvedByUserId = adminUserId;
    const saved = await this.tagRequests.save(request);

    const community = await this.communities.findOne({
      where: { id: saved.communityId },
    });

    // Best-effort — the resolution already committed above; a flaky notifier
    // must never roll that back or surface as a failed request.
    try {
      await this.notifications.create(
        saved.requestedByUserId,
        NotificationType.CommunityTagRequestResolved,
        {
          source: 'community',
          communitySlug: community?.slug ?? null,
          label: saved.label,
        },
      );
    } catch {
      // Intentionally ignored — see docstring above.
    }

    const requestersByUserId = await new MemberLookup(this.profiles).byUserIds([
      saved.requestedByUserId,
    ]);

    return toAdminCommunityTagRequestDTO(
      saved,
      community ? { slug: community.slug, name: community.name } : null,
      requestersByUserId.get(saved.requestedByUserId) ?? null,
    );
  }

  private async communitiesById(
    ids: string[],
  ): Promise<Map<string, AdminCommunityTagRequestCommunityDTO>> {
    const map = new Map<string, AdminCommunityTagRequestCommunityDTO>();
    if (!ids.length) return map;
    const rows = await this.communities.find({ where: { id: In(ids) } });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, name: row.name });
    }
    return map;
  }
}

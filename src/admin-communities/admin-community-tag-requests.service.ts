import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CommunityTagRequest,
  CommunityTagRequestStatus,
} from '../communities/entities/community-tag-request.entity';
import { Community } from '../communities/entities/community.entity';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
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

  /**
   * `actorRole` is the caller's ACCOUNT TIER off the JWT. Since OPS-03 this
   * queue also opens on the additive `communities` grant, so the handler can no
   * longer assume its caller is Moderator/Admin: a grant holder reads every row
   * without the requester being named. See `AdminCommunityTagRequestDTO`.
   */
  async list(
    query: ListAdminCommunityTagRequestsQuery,
    actorRole: string,
  ): Promise<AdminCommunityTagRequestsPageDTO> {
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
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
      // Skipped entirely for a grant holder: the refs are not built, so they
      // cannot be serialized by accident later.
      new MemberLookup(this.profiles).byUserIds(
        isPlatformStaffReader
          ? [...new Set(rows.map((row) => row.requestedByUserId))]
          : [],
      ),
    ]);

    const items = rows.map((row) =>
      toAdminCommunityTagRequestDTO(
        row,
        communitiesById.get(row.communityId) ?? null,
        requestersByUserId.get(row.requestedByUserId) ?? null,
        isPlatformStaffReader,
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
    actorRole: string,
  ): Promise<AdminCommunityTagRequestDTO> {
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
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

    // Same narrowing as `list`: the requester's profile is not even fetched for
    // a caller who reached this on the `communities` grant.
    const requestersByUserId = await new MemberLookup(this.profiles).byUserIds(
      isPlatformStaffReader ? [saved.requestedByUserId] : [],
    );

    return toAdminCommunityTagRequestDTO(
      saved,
      community ? { slug: community.slug, name: community.name } : null,
      requestersByUserId.get(saved.requestedByUserId) ?? null,
      isPlatformStaffReader,
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

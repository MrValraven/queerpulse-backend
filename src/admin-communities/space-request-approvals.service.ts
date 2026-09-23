import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Community } from '../communities/entities/community.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from '../communities/entities/community-space-request.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * Closes a community's open space request as approved. Called by
 * `AdminCommunitiesService.updateSettings` whenever it sets
 * `allowsSubcommunities: true`, which is the one path both the queue's
 * Approve button and the settings switch take, so a community that hosts
 * spaces never keeps an open request in the queue.
 */
@Injectable()
export class SpaceRequestApprovalsService {
  constructor(
    @InjectRepository(CommunitySpaceRequest)
    private readonly requests: Repository<CommunitySpaceRequest>,
    private readonly notifications: NotificationsService,
  ) {}

  async closeOpenAsApproved(
    community: Pick<Community, 'id' | 'slug' | 'name'>,
    adminUserId: string,
  ): Promise<void> {
    const open = await this.requests.findOne({
      where: {
        communityId: community.id,
        status: CommunitySpaceRequestStatus.Open,
      },
    });
    if (!open) return;
    const decidedAt = new Date();
    // Conditional on status still being `open`: a concurrent decline or
    // withdraw may have already closed this row between the read above and
    // this write, and the last writer must not overwrite a terminal status.
    const result = await this.requests.update(
      { id: open.id, status: CommunitySpaceRequestStatus.Open },
      {
        status: CommunitySpaceRequestStatus.Approved,
        decidedAt,
        decidedByUserId: adminUserId,
      },
    );
    if (!result.affected) return;
    try {
      await this.notifications.create(
        open.requestedByUserId,
        NotificationType.CommunitySpaceRequestApproved,
        {
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
        },
      );
    } catch {
      // The approval stands without the notification; the requester sees
      // spaces switched on in their mod tools either way.
    }
  }
}

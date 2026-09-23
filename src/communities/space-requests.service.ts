import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup } from '../common/member-ref';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import { CommunityMembershipService } from './community-membership.service';
import { toStoredPlainTextOrNull } from './community-plain-text';
import { CreateSpaceRequestDto } from './dto/create-space-request.dto';
import { Community } from './entities/community.entity';
import { RosterRole } from './entities/community-member.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from './entities/community-space-request.entity';
import {
  LatestSpaceRequestResponseDTO,
  SpaceRequestDTO,
  toSpaceRequestDTO,
} from './space-request-response';
import {
  SPACES_ALREADY_ALLOWED_CODE,
  SPACE_REQUEST_ALREADY_OPEN_CODE,
  SUBCOMMUNITIES_NOT_ALLOWED_CODE,
} from './subcommunity-rules';

// `CommunitiesService.SUBJECT_TYPE`, private there: the
// `content_moderation.subject_type` a community takedown is keyed under.
const COMMUNITY_MODERATION_SUBJECT_TYPE = 'community';

/**
 * A community owner or co-owner asking platform staff to switch spaces on.
 * Staff (owner, co-owner, mod) can read the latest request; only the owner
 * and co-owners can file or withdraw one. Staff decide it from
 * `AdminCommunitySpaceRequestsService`.
 */
@Injectable()
export class SpaceRequestsService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunitySpaceRequest)
    private readonly requests: Repository<CommunitySpaceRequest>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly membership: CommunityMembershipService,
    private readonly contentModeration: ContentModerationService,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async latest(
    slug: string,
    actorId: string,
  ): Promise<LatestSpaceRequestResponseDTO> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const request = await this.requests.findOne({
      where: { communityId },
      order: { createdAt: 'DESC' },
    });
    return { request: request ? await this.toDto(request) : null };
  }

  async create(
    slug: string,
    actorId: string,
    dto: CreateSpaceRequestDto,
  ): Promise<SpaceRequestDTO> {
    const community = await this.loadForOwnerLevel(slug, actorId);
    if (community.parentId !== null) {
      throw new ConflictException({
        message: 'A space cannot host spaces of its own',
        code: SUBCOMMUNITIES_NOT_ALLOWED_CODE,
      });
    }
    if (community.allowsSubcommunities) {
      throw new ConflictException({
        message: 'This community already hosts spaces',
        code: SPACES_ALREADY_ALLOWED_CODE,
      });
    }
    if (community.frozenAt) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }
    const moderation = await this.contentModeration.stateFor(
      COMMUNITY_MODERATION_SUBJECT_TYPE,
      community.slug,
    );
    if (moderation.hidden || moderation.removed) {
      throw new ForbiddenException(
        'This community is under moderator review and cannot open spaces',
      );
    }
    const alreadyOpen = await this.openRequestFor(community.id);
    if (alreadyOpen) throw SpaceRequestsService.alreadyOpen();

    let saved: CommunitySpaceRequest;
    try {
      saved = await this.requests.save(
        this.requests.create({
          communityId: community.id,
          requestedByUserId: actorId,
          note: toStoredPlainTextOrNull(dto.note),
          status: CommunitySpaceRequestStatus.Open,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw SpaceRequestsService.alreadyOpen();
      throw error;
    }
    // Safe to await: `announce` catches everything internally.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.CommunitySpaceRequests,
      saved.id,
    );
    return this.toDto(saved);
  }

  async withdraw(slug: string, actorId: string): Promise<SpaceRequestDTO> {
    const community = await this.loadForOwnerLevel(slug, actorId);
    const open = await this.openRequestFor(community.id);
    if (!open) throw new NotFoundException('No open space request');
    const decidedAt = new Date();
    // Conditional on status still being `open`: a concurrent approval or
    // decline may have already closed this row between the read above and
    // this write, and the last writer must not overwrite a terminal status.
    const result = await this.requests.update(
      { id: open.id, status: CommunitySpaceRequestStatus.Open },
      {
        status: CommunitySpaceRequestStatus.Withdrawn,
        decidedAt,
        decidedByUserId: actorId,
      },
    );
    if (!result.affected) {
      throw new NotFoundException('No open space request');
    }
    return this.toDto({
      ...open,
      status: CommunitySpaceRequestStatus.Withdrawn,
      decidedAt,
      decidedByUserId: actorId,
    });
  }

  /**
   * 404 for an archived community or a private one the caller is outside of,
   * 403 for a plain member (both from `assertOwnerOrModBySlug`), then 403 for
   * a mod: filing and withdrawing are owner-level decisions.
   */
  private async loadForOwnerLevel(
    slug: string,
    actorId: string,
  ): Promise<Community> {
    const communityId = await this.membership.assertOwnerOrModBySlug(
      slug,
      actorId,
    );
    const community = await this.communities.findOne({
      where: { id: communityId },
    });
    if (!community) throw new NotFoundException('Community not found');
    const role = await this.membership.effectiveRole(community, actorId);
    if (role !== RosterRole.Owner && role !== RosterRole.CoOwner) {
      throw new ForbiddenException(
        'Only an owner or co-owner can ask for spaces',
      );
    }
    return community;
  }

  private openRequestFor(
    communityId: string,
  ): Promise<CommunitySpaceRequest | null> {
    return this.requests.findOne({
      where: { communityId, status: CommunitySpaceRequestStatus.Open },
    });
  }

  private async toDto(
    request: CommunitySpaceRequest,
  ): Promise<SpaceRequestDTO> {
    const requesters = await new MemberLookup(this.profiles).byUserIds([
      request.requestedByUserId,
    ]);
    return toSpaceRequestDTO(
      request,
      requesters.get(request.requestedByUserId) ?? null,
    );
  }

  private static alreadyOpen(): ConflictException {
    return new ConflictException({
      message: 'This community already has an open space request',
      code: SPACE_REQUEST_ALREADY_OPEN_CODE,
    });
  }
}

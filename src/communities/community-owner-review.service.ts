import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import {
  CommunityOwnerReviewStateDTO,
  toCommunityOwnerReviewRequestDTO,
} from './community-owner-review-response';
import { toStoredPlainText } from './community-plain-text';
import {
  loadActiveCommunityOr404,
  loadMembershipOr403,
  resolveStaffCommunity,
} from './community-staff-access';
import { CreateCommunityOwnerReviewDto } from './dto/create-community-owner-review.dto';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import {
  CommunityOwnerReviewRequest,
  CommunityOwnerReviewRequestStatus,
} from './entities/community-owner-review-request.entity';
import { Community } from './entities/community.entity';

// Postgres `unique_violation`. The partial unique index
// `UQ_community_owner_review_requests_open` (`WHERE status = 'open'`) is the
// real enforcement of "one open request per community": the pre-check in
// `open()` loses to a concurrent filing between its read and the INSERT, and
// without this the loser sees a 500 instead of the 409 the rule means.
const UNIQUE_VIOLATION = '23505';

/** The platform roles that receive an owner-review alert. Mirrors
 *  `PlatformStaffService`'s `STAFF_ROLES` (moderators and admins). */
const PLATFORM_STAFF_ROLES = [UserRole.Moderator, UserRole.Admin];

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return (candidate?.code ?? candidate?.driverError?.code) === UNIQUE_VIOLATION;
}

/**
 * Backs `/communities/:slug/owner-review` — a community's moderators flagging
 * that their owner has gone unreachable.
 *
 * An owner who simply stops logging in leaves their moderators stuck: they
 * hold no owner-only powers (settings, ownership transfer, the danger zone),
 * and the only remedy was a platform-staff reassignment nobody had a way to
 * ASK for. `communities.needs_owner_review_at` already existed and was stamped
 * by exactly one automatic path (`CommunityOwnerOrphanService
 * .handleOwnerErasure`, an owner who erased their account with no moderator to
 * promote), and the admin surface already queries it. This is the human route
 * onto that same surface.
 *
 * ## Writing to the community row from here
 *
 * `needsOwnerReviewAt` is stamped and cleared through the `Community`
 * REPOSITORY injected below, deliberately, rather than through
 * `CommunitiesService`. This build does not touch `communities.service.ts`
 * (it is another agent's file in this effort), and the stamp is a single
 * column write with no other lifecycle attached, so a targeted
 * `communities.update(...)` is the whole operation. Anything that needs the
 * community's broader lifecycle rules still belongs in `CommunitiesService`.
 */
@Injectable()
export class CommunityOwnerReviewService {
  private readonly logger = new Logger(CommunityOwnerReviewService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityOwnerReviewRequest)
    private readonly reviewRequests: Repository<CommunityOwnerReviewRequest>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The current state for a community's own staff (owner, co-owner or
   * moderator). The owner is included as a READER on purpose: a request filed
   * about them is not a secret, and seeing it is what prompts the "I am still
   * here" withdrawal below.
   */
  async getState(
    slug: string,
    userId: string,
  ): Promise<CommunityOwnerReviewStateDTO> {
    const { community, membership } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    return this.buildState(community, membership, userId);
  }

  /**
   * File an owner-review request (moderators and co-owners).
   *
   * The owner is refused: a community's owner flagging themselves as absent
   * is not a signal anyone can act on, and the withdrawal route below is their
   * side of this conversation.
   */
  async open(
    slug: string,
    userId: string,
    dto: CreateCommunityOwnerReviewDto,
  ): Promise<CommunityOwnerReviewStateDTO> {
    const community = await loadActiveCommunityOr404(this.communities, slug);
    const membership = await loadMembershipOr403(
      this.members,
      community.id,
      userId,
    );
    if (
      membership.role !== RosterRole.Mod &&
      membership.role !== RosterRole.CoOwner
    ) {
      throw new ForbiddenException(
        membership.role === RosterRole.Owner
          ? 'A community owner cannot file an owner review for their own community'
          : 'Only a moderator or co-owner can file an owner review',
      );
    }

    const alreadyOpen = await this.openRequestFor(community.id);
    if (alreadyOpen) {
      throw new ConflictException(
        'This community already has an open owner review',
      );
    }

    const reason = toStoredPlainText(dto.reason);
    let saved: CommunityOwnerReviewRequest;
    try {
      saved = await this.reviewRequests.save(
        this.reviewRequests.create({
          communityId: community.id,
          requestedByUserId: userId,
          reason,
          status: CommunityOwnerReviewRequestStatus.Open,
        }),
      );
    } catch (error) {
      // The pre-check above can lose a race to a concurrent filing; the
      // partial unique index is the real backstop, and this turns its 23505
      // into the same 409 rather than a 500.
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          'This community already has an open owner review',
        );
      }
      throw error;
    }

    // The stamp the admin surface queries. Written here through the community
    // repository, see this service's doc comment.
    await this.communities.update(
      { id: community.id },
      { needsOwnerReviewAt: saved.createdAt },
    );
    community.needsOwnerReviewAt = saved.createdAt;

    await this.notifyPlatformStaff(community, userId, reason);

    return this.buildState(community, membership, userId, saved);
  }

  /**
   * Withdraw the open request, by the moderator who filed it or by the
   * community's owner.
   *
   * The owner withdrawing is the "I am still here" signal, so that route also
   * clears `needsOwnerReviewAt` and takes the community off the admin queue.
   * A requester withdrawing does NOT clear it: that same column is set by the
   * automatic orphan path for a community with no owner at all, and a
   * moderator taking their own request back must not be able to erase that
   * flag. Platform staff clear it from their own surface.
   */
  async withdraw(
    slug: string,
    userId: string,
  ): Promise<CommunityOwnerReviewStateDTO> {
    const community = await loadActiveCommunityOr404(this.communities, slug);
    const membership = await loadMembershipOr403(
      this.members,
      community.id,
      userId,
    );

    const request = await this.openRequestFor(community.id);
    if (!request) {
      throw new NotFoundException('No open owner review for this community');
    }

    const isRequester = request.requestedByUserId === userId;
    const isOwner =
      community.ownerId === userId || membership.role === RosterRole.Owner;
    if (!isRequester && !isOwner) {
      throw new ForbiddenException(
        'Only the moderator who filed this review, or the community owner, can withdraw it',
      );
    }

    request.status = CommunityOwnerReviewRequestStatus.Withdrawn;
    request.resolvedAt = new Date();
    const saved = await this.reviewRequests.save(request);

    if (isOwner) {
      await this.communities.update(
        { id: community.id },
        { needsOwnerReviewAt: null },
      );
      community.needsOwnerReviewAt = null;
    }

    return this.buildState(community, membership, userId, saved);
  }

  private async openRequestFor(
    communityId: string,
  ): Promise<CommunityOwnerReviewRequest | null> {
    return this.reviewRequests.findOne({
      where: {
        communityId,
        status: CommunityOwnerReviewRequestStatus.Open,
      },
    });
  }

  /**
   * The state DTO for one viewer. `knownRequest` lets the write paths reuse
   * the row they just saved instead of reading it back: a withdrawn request is
   * still worth returning to the caller who withdrew it, even though it is no
   * longer the community's OPEN request.
   */
  private async buildState(
    community: Community,
    membership: CommunityMember,
    viewerUserId: string,
    knownRequest?: CommunityOwnerReviewRequest,
  ): Promise<CommunityOwnerReviewStateDTO> {
    const request = knownRequest ?? (await this.openRequestFor(community.id));
    const requestedBy = request?.requestedByUserId
      ? ((
          await new MemberLookup(this.profiles).byUserIds([
            request.requestedByUserId,
          ])
        ).get(request.requestedByUserId) ?? null)
      : null;

    const isOpen = request?.status === CommunityOwnerReviewRequestStatus.Open;
    const canFile =
      membership.role === RosterRole.Mod ||
      membership.role === RosterRole.CoOwner;
    const isOwner =
      community.ownerId === viewerUserId ||
      membership.role === RosterRole.Owner;

    return {
      request: request
        ? toCommunityOwnerReviewRequestDTO(request, requestedBy)
        : null,
      needsOwnerReviewAt: community.needsOwnerReviewAt
        ? community.needsOwnerReviewAt.toISOString()
        : null,
      canOpen: canFile && !isOpen,
      canWithdraw:
        isOpen && (isOwner || request?.requestedByUserId === viewerUserId),
    };
  }

  /**
   * Best-effort alert to PLATFORM staff (moderators and admins), in its own
   * try/catch after the request row has already committed, the contract every
   * notification path in this module follows.
   *
   * Recipients are resolved exactly the way `PlatformStaffService.list` does:
   * active users holding a staff role. A suspended moderator stops being staff
   * the moment their account changes state, so they stop being paged too.
   *
   * The requesting moderator is carried in the payload as `actorId` (which is
   * what the notification type's docstring specifies) but is deliberately NOT
   * passed as `createForRecipients`'s `actorId` ARGUMENT, unlike the
   * community-scoped fan-outs. That argument applies the recipient's block and
   * mute list; a platform-staff operational alert must not be droppable by one
   * staff member's personal block of the member who raised it.
   */
  private async notifyPlatformStaff(
    community: Community,
    requesterUserId: string,
    reason: string,
  ): Promise<void> {
    try {
      const staff = await this.users.find({
        where: {
          role: In(PLATFORM_STAFF_ROLES),
          status: UserStatus.Active,
        },
        select: { id: true },
      });
      const recipientIds = staff
        .map((staffUser) => staffUser.id)
        .filter((recipientId) => recipientId !== requesterUserId);
      if (!recipientIds.length) return;

      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunityOwnerReviewRequested,
        {
          actorId: requesterUserId,
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
          reason,
        },
      );
    } catch (error) {
      this.logger.error(
        `Owner review opened for community ${community.id}, but notifying platform staff failed: ${String(error)}`,
      );
    }
  }
}

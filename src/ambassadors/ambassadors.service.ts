import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { CommunitySystemMembershipService } from '../communities/community-system-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
import { AmbassadorCircleService } from './ambassador-circle.service';
import type { AmbassadorFocusArea } from './ambassador-focus-areas';
import {
  AdminAmbassadorDTO,
  AmbassadorCircleSummaryDTO,
  AmbassadorStaffSeatDTO,
  toAdminAmbassador,
} from './ambassador-response';
import type { AmbassadorListStatus } from './dto/list-ambassadors.query';
import { Ambassador } from './entities/ambassador.entity';

export const AMBASSADOR_ALREADY_ACTIVE_CODE = 'ambassador_already_active';
export const AMBASSADOR_NOT_FOUND_CODE = 'ambassador_not_found';
export const AMBASSADOR_MEMBER_NOT_FOUND_CODE = 'ambassador_member_not_found';
export const AMBASSADOR_SELF_GRANT_CODE = 'ambassador_self_grant';
export const AMBASSADOR_INELIGIBLE_MEMBER_CODE = 'ambassador_ineligible_member';

export interface GrantAmbassadorInput {
  memberSlug: string;
  focusArea: AmbassadorFocusArea;
  reason: string;
}

/**
 * Every write to the ambassador status: grant, focus-area change and revoke,
 * each keeping the circle roster in step, plus the admin reads. The cheap
 * status reads other modules need live in `AmbassadorStatusService`.
 */
@Injectable()
export class AmbassadorsService {
  private readonly logger = new Logger(AmbassadorsService.name);

  constructor(
    @InjectRepository(Ambassador)
    private readonly ambassadors: Repository<Ambassador>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    private readonly circle: AmbassadorCircleService,
    private readonly systemMembership: CommunitySystemMembershipService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Names a member an ambassador and seats them in the circle, all or
   * nothing: the circle is resolved before anything is written, and a failed
   * circle join deletes the row it just wrote. The notification goes out last
   * and cannot fail the grant.
   */
  async grant(
    input: GrantAmbassadorInput,
    actorId: string,
  ): Promise<AdminAmbassadorDTO> {
    const profile = await this.profiles.findOne({
      where: { slug: input.memberSlug },
      select: { userId: true },
    });
    if (!profile) {
      throw new NotFoundException({
        message: 'No member has that handle',
        code: AMBASSADOR_MEMBER_NOT_FOUND_CODE,
      });
    }
    const userId = profile.userId;
    if (userId === actorId) {
      throw new ForbiddenException({
        message: 'Staff cannot name themselves an ambassador',
        code: AMBASSADOR_SELF_GRANT_CODE,
      });
    }
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, isSystem: true, status: true },
    });
    if (!user || user.isSystem || user.status !== UserStatus.Active) {
      throw new BadRequestException({
        message: 'Only an active member can be named an ambassador',
        code: AMBASSADOR_INELIGIBLE_MEMBER_CODE,
      });
    }
    const hasActiveGrant = await this.ambassadors.exists({
      where: { userId, revokedAt: IsNull() },
    });
    if (hasActiveGrant) throw AmbassadorsService.alreadyActive();

    const circle = await this.circle.resolveCircle();

    let inserted: Ambassador;
    try {
      inserted = await this.ambassadors.save(
        this.ambassadors.create({
          userId,
          focusArea: input.focusArea,
          grantedById: actorId,
          grantReason: input.reason,
          revokedAt: null,
          revokedById: null,
          revokeReason: null,
        }),
      );
    } catch (error) {
      // Two grants racing past the pre-check above: the partial unique index
      // `UQ_ambassadors_active_user` lets only one active row through.
      if (isUniqueViolation(error)) throw AmbassadorsService.alreadyActive();
      throw error;
    }

    try {
      // A no-op for a member who already holds a seat (a staff `mod`, say).
      // A member who left the circle earlier has no row, so a re-grant seats
      // them again and the card listener issues a fresh card.
      await this.systemMembership.addMember(
        circle.id,
        userId,
        RosterRole.Member,
      );
    } catch (error) {
      await this.ambassadors.delete({ id: inserted.id });
      throw error;
    }

    await this.notifySafely(userId, NotificationType.AmbassadorGranted, {
      focusArea: input.focusArea,
      communitySlug: circle.slug,
    });

    return this.loadAdminAmbassador(inserted.id);
  }

  async updateFocusArea(
    id: string,
    focusArea: AmbassadorFocusArea,
    actorId: string,
  ): Promise<AdminAmbassadorDTO> {
    const result = await this.ambassadors.update(
      { id, revokedAt: IsNull() },
      { focusArea },
    );
    if (!result.affected) throw AmbassadorsService.notFound();
    this.logger.log(
      `Ambassador grant ${id} focus area set to ${focusArea} by ${actorId}`,
    );
    return this.loadAdminAmbassador(id);
  }

  /**
   * Stands an ambassador down. The circle seat goes first and the stamp
   * second: should the stamp fail, the grant is still active and a retry
   * finishes the job, where the other order would leave a revoked member in
   * the circle with a live card and no way to retry. Only a plain `member`
   * row leaves the circle, so a staff `mod` seat survives the revoke.
   */
  async revoke(
    id: string,
    reason: string,
    actorId: string,
  ): Promise<AdminAmbassadorDTO> {
    const active = await this.ambassadors.findOne({
      where: { id, revokedAt: IsNull() },
      select: { id: true, userId: true },
    });
    if (!active) throw AmbassadorsService.notFound();

    const circle = await this.circle.resolveCircle();
    await this.systemMembership.removeMemberIfRole(
      circle.id,
      active.userId,
      RosterRole.Member,
    );

    const result = await this.ambassadors.update(
      { id, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedById: actorId, revokeReason: reason },
    );
    if (!result.affected) throw AmbassadorsService.notFound();

    await this.notifySafely(
      active.userId,
      NotificationType.AmbassadorRevoked,
      {},
    );

    return this.loadAdminAmbassador(id);
  }

  /** Active grants newest first, or past ones most recently revoked first. */
  async list(
    status: AmbassadorListStatus = 'active',
  ): Promise<AdminAmbassadorDTO[]> {
    const isPast = status === 'past';
    const rows = await this.ambassadors.find({
      where: { revokedAt: isPast ? Not(IsNull()) : IsNull() },
      relations: { user: { profile: true } },
      order: isPast ? { revokedAt: 'DESC' } : { grantedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return this.toAdminRows(rows);
  }

  async getCircleSummary(
    viewerId: string,
  ): Promise<AmbassadorCircleSummaryDTO> {
    const circle = await this.circle.resolveCircle();
    const [memberCount, isViewerMember] = await Promise.all([
      this.communityMembers.count({ where: { communityId: circle.id } }),
      this.communityMembers.exists({
        where: { communityId: circle.id, userId: viewerId },
      }),
    ]);
    return { slug: circle.slug, memberCount, isViewerMember };
  }

  /**
   * Seats the calling staff member as a `mod`, so they can post previews and
   * polls and edit the card programme. Someone already in the circle keeps
   * the seat they have.
   */
  async takeStaffSeat(viewerId: string): Promise<AmbassadorStaffSeatDTO> {
    const circle = await this.circle.resolveCircle();
    await this.systemMembership.addMember(circle.id, viewerId, RosterRole.Mod);
    return { slug: circle.slug };
  }

  private async loadAdminAmbassador(id: string): Promise<AdminAmbassadorDTO> {
    const row = await this.ambassadors.findOne({
      where: { id },
      relations: { user: { profile: true } },
    });
    const [mapped] = row ? await this.toAdminRows([row]) : [];
    if (!mapped) throw AmbassadorsService.notFound();
    return mapped;
  }

  /**
   * Hand-maps grants for the admin page. The granting and revoking staff are
   * looked up in one batch; a grant whose member has no profile row (an
   * account mid-erasure) is left off the page.
   */
  private async toAdminRows(rows: Ambassador[]): Promise<AdminAmbassadorDTO[]> {
    const actorIds = new Set<string>();
    for (const row of rows) {
      if (row.grantedById) actorIds.add(row.grantedById);
      if (row.revokedById) actorIds.add(row.revokedById);
    }
    const actorProfiles =
      actorIds.size > 0
        ? await this.profiles.find({
            where: { userId: In([...actorIds]) },
            select: {
              userId: true,
              slug: true,
              firstName: true,
              lastName: true,
            },
          })
        : [];
    const actorProfileByUserId = new Map(
      actorProfiles.map((actorProfile) => [actorProfile.userId, actorProfile]),
    );
    const mapped: AdminAmbassadorDTO[] = [];
    for (const row of rows) {
      const memberProfile = row.user?.profile;
      if (!row.user || !memberProfile) continue;
      mapped.push(
        toAdminAmbassador({
          ambassador: row,
          memberProfile,
          inviteQuotaOverride: row.user.inviteMonthlyQuota ?? null,
          grantedByProfile: row.grantedById
            ? (actorProfileByUserId.get(row.grantedById) ?? null)
            : null,
          revokedByProfile: row.revokedById
            ? (actorProfileByUserId.get(row.revokedById) ?? null)
            : null,
        }),
      );
    }
    return mapped;
  }

  private async notifySafely(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notifications.create(userId, type, payload);
    } catch (error) {
      // The grant or revoke stands without the bell; the member sees the
      // change on their profile either way.
      this.logger.warn(
        `Could not send ${type} to ${userId}: ${(error as Error).message}`,
      );
    }
  }

  private static alreadyActive(): ConflictException {
    return new ConflictException({
      message: 'This member is already an ambassador',
      code: AMBASSADOR_ALREADY_ACTIVE_CODE,
    });
  }

  private static notFound(): NotFoundException {
    return new NotFoundException({
      message: 'No active ambassador grant with that id',
      code: AMBASSADOR_NOT_FOUND_CODE,
    });
  }
}

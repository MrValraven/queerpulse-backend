import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ChangemakerNomination,
  ChangemakerNominationStatus,
} from './entities/changemaker-nomination.entity';
import {
  AdminChangemakerNominationDTO,
  AdminChangemakerNominationsPageDTO,
  toAdminChangemakerNominationDTO,
} from './admin-changemaker-nominations-response';
import { ListAdminChangemakerNominationsQuery } from './dto/list-admin-changemaker-nominations.query';
import { TriageChangemakerNominationDto } from './dto/triage-changemaker-nomination.dto';

/** One page of the admin changemaker-nomination list. */
export const ADMIN_CHANGEMAKER_NOMINATIONS_PAGE_SIZE = 20;

/**
 * Admin dashboard's changemaker-nomination oversight surface: every
 * "Nominate them" a member has submitted, newest first, paginated, plus
 * (COM-17) triage — approve or dismiss a pending nomination, which notifies
 * the nominator of the decision.
 *
 * Every row is hand-mapped to `AdminChangemakerNominationDTO` (never a raw
 * entity), and the nominating/reviewing members are resolved in ONE batched
 * profile lookup across the whole page — never one query per row — mirroring
 * `AdminInvitesService`.
 */
@Injectable()
export class AdminChangemakerNominationsService {
  constructor(
    @InjectRepository(ChangemakerNomination)
    private readonly nominations: Repository<ChangemakerNomination>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * `actorRole` is the caller's ACCOUNT TIER off the JWT. Since OPS-03 this
   * queue also opens on the additive `partnerships` grant, so the handler can
   * no longer assume its caller is Moderator/Admin: a grant holder reads every
   * row without the nominator being named. See
   * `AdminChangemakerNominationDTO`.
   */
  async list(
    query: ListAdminChangemakerNominationsQuery,
    actorRole: string,
  ): Promise<AdminChangemakerNominationsPageDTO> {
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_CHANGEMAKER_NOMINATIONS_PAGE_SIZE;

    const [rows, total] = await this.nominations.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    // One batched lookup covers the nominator, the linked nominee (COM-18) and
    // the reviewer refs — never one query per row, mirroring
    // `AdminWriterApplicationsService.list`. The nominator and nominee ids are
    // looked up only when the reader is platform staff; for anyone else the
    // ref is never built, so it cannot be serialized by accident later.
    const userIds = [
      ...new Set(
        rows.flatMap((row) => [
          ...(isPlatformStaffReader ? [row.nominatorId] : []),
          ...(isPlatformStaffReader && row.nomineeUserId
            ? [row.nomineeUserId]
            : []),
          ...(row.reviewedBy ? [row.reviewedBy] : []),
        ]),
      ),
    ];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminChangemakerNominationDTO[] = rows.map((nomination) =>
      toAdminChangemakerNominationDTO(
        nomination,
        refsByUserId.get(nomination.nominatorId) ?? null,
        nomination.nomineeUserId
          ? (refsByUserId.get(nomination.nomineeUserId) ?? null)
          : null,
        nomination.reviewedBy
          ? (refsByUserId.get(nomination.reviewedBy) ?? null)
          : null,
        isPlatformStaffReader,
      ),
    );

    return { items, total, page, pageSize };
  }

  /**
   * `PATCH /admin/changemaker-nominations/:id` — approve or dismiss a
   * nomination (COM-17). Mirrors `AdminWriterApplicationsService.triage`'s
   * guarded conditional-UPDATE claim (so a concurrent double-triage 409s
   * instead of racing) and best-effort notify-outside-the-write shape, minus
   * the role-grant step — a changemaker nomination has no role riding on it,
   * just a yes/no on the directory pitch.
   */
  async triage(
    actorUserId: string,
    actorRole: string,
    id: string,
    dto: TriageChangemakerNominationDto,
  ): Promise<AdminChangemakerNominationDTO> {
    const isPlatformStaffReader = isPlatformStaffTier(actorRole);
    const nomination = await this.nominations.findOne({ where: { id } });
    if (!nomination) {
      throw new NotFoundException('Nomination not found');
    }
    if (nomination.status !== ChangemakerNominationStatus.Pending) {
      throw new ConflictException('Nomination already resolved');
    }

    const newStatus =
      dto.status === 'approved'
        ? ChangemakerNominationStatus.Approved
        : ChangemakerNominationStatus.Dismissed;
    const reviewNote = dto.reviewNote?.trim() || null;

    const claim = await this.nominations
      .createQueryBuilder()
      .update(ChangemakerNomination)
      .set({
        status: newStatus,
        reviewedBy: actorUserId,
        reviewNote,
        reviewedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', {
        id: nomination.id,
        pending: ChangemakerNominationStatus.Pending,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('Nomination already resolved');
    }

    try {
      await this.notifications.create(
        nomination.nominatorId,
        newStatus === ChangemakerNominationStatus.Approved
          ? NotificationType.ChangemakerNominationApproved
          : NotificationType.ChangemakerNominationDismissed,
        { nomineeName: nomination.nomineeName, reviewNote },
      );
    } catch {
      // Intentionally ignored — the triage decision already committed.
    }

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([
      // Same narrowing as `list`: neither the nominator's profile nor the
      // linked nominee's is even fetched for a caller who reached this on the
      // `partnerships` grant.
      ...(isPlatformStaffReader ? [nomination.nominatorId] : []),
      ...(isPlatformStaffReader && nomination.nomineeUserId
        ? [nomination.nomineeUserId]
        : []),
      actorUserId,
    ]);
    return toAdminChangemakerNominationDTO(
      {
        ...nomination,
        status: newStatus,
        reviewedBy: actorUserId,
        reviewNote,
        reviewedAt: new Date(),
      },
      refsByUserId.get(nomination.nominatorId) ?? null,
      nomination.nomineeUserId
        ? (refsByUserId.get(nomination.nomineeUserId) ?? null)
        : null,
      refsByUserId.get(actorUserId) ?? null,
      isPlatformStaffReader,
    );
  }
}

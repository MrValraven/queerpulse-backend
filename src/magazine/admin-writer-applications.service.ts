import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminMembersService } from '../admin-members/admin-members.service';
import { MemberLookup } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { ListAdminWriterApplicationsQuery } from './dto/list-admin-writer-applications.query';
import { TriageWriterApplicationDto } from './dto/triage-writer-application.dto';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';
import {
  AdminWriterApplicationDTO,
  AdminWriterApplicationsPageDTO,
  toAdminWriterApplicationDTO,
} from './writer-application-response';

export const ADMIN_WRITER_APPLICATIONS_PAGE_SIZE = 20;

/**
 * Admin side of magazine writer applications: paginated list + triage.
 * Mirrors `AdminStorySubmissionsService`'s list pattern (batched profile
 * lookup, never one query per row) and `CommunitiesService.
 * triageJoinRequest`'s triage pattern (guarded conditional UPDATE claim,
 * best-effort notify outside the write).
 */
@Injectable()
export class AdminWriterApplicationsService {
  constructor(
    @InjectRepository(MagazineWriterApplication)
    private readonly applications: Repository<MagazineWriterApplication>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly adminMembers: AdminMembersService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(
    query: ListAdminWriterApplicationsQuery,
  ): Promise<AdminWriterApplicationsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_WRITER_APPLICATIONS_PAGE_SIZE;

    const [rows, total] = await this.applications.findAndCount({
      where: query.status ? { status: query.status } : {},
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const refsByUserId = await memberLookup.byUserIds(userIds);

    const items: AdminWriterApplicationDTO[] = rows.map((row) =>
      toAdminWriterApplicationDTO(row, refsByUserId.get(row.userId) ?? null),
    );

    return { items, total, page, pageSize };
  }

  async triage(
    actorUserId: string,
    id: string,
    dto: TriageWriterApplicationDto,
  ): Promise<AdminWriterApplicationDTO> {
    const application = await this.applications.findOne({ where: { id } });
    if (!application) {
      throw new NotFoundException('Writer application not found');
    }
    if (application.status !== WriterApplicationStatus.Pending) {
      throw new ConflictException('Application already resolved');
    }

    const newStatus =
      dto.status === 'approved'
        ? WriterApplicationStatus.Approved
        : WriterApplicationStatus.Declined;

    // Grant the role FIRST (if approving), before claiming the row.
    // `grantStaffRole` is idempotent, so a retry after a failure here is
    // always safe — this ordering means an application can never read
    // "approved" without the role actually having been granted.
    if (newStatus === WriterApplicationStatus.Approved) {
      await this.adminMembers.grantStaffRole(
        actorUserId,
        application.userId,
        'magazine_writer',
      );
    }

    const reviewNote = dto.reviewNote?.trim() || null;
    const claim = await this.applications
      .createQueryBuilder()
      .update(MagazineWriterApplication)
      .set({
        status: newStatus,
        reviewedBy: actorUserId,
        reviewNote,
        reviewedAt: () => 'now()',
      })
      .where('id = :id AND status = :pending', {
        id: application.id,
        pending: WriterApplicationStatus.Pending,
      })
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException('Application already resolved');
    }

    try {
      await this.notifications.create(
        application.userId,
        newStatus === WriterApplicationStatus.Approved
          ? NotificationType.WriterApplicationApproved
          : NotificationType.WriterApplicationDeclined,
        { reviewNote },
      );
    } catch {
      // Intentionally ignored — the triage decision already committed.
    }

    const memberLookup = new MemberLookup(this.profiles);
    const ref = (await memberLookup.byUserIds([application.userId])).get(
      application.userId,
    );
    return toAdminWriterApplicationDTO(
      {
        ...application,
        status: newStatus,
        reviewedBy: actorUserId,
        reviewNote,
        reviewedAt: new Date(),
      },
      ref ?? null,
    );
  }
}

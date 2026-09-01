import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { isUniqueViolation } from '../common/db-errors';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { CreateWriterApplicationDto } from './dto/create-writer-application.dto';
import { MagazineWriterApplication } from './entities/magazine-writer-application.entity';
import {
  toWriterApplicationDTO,
  WriterApplicationDTO,
} from './writer-application-response';

/**
 * Member-facing side of a magazine writer application: apply, and check your
 * own latest application's status. The admin triage side (list + approve/
 * decline) is `AdminWriterApplicationsService` — same split as
 * `StorySubmissionsService` / `AdminStorySubmissionsService`.
 */
@Injectable()
export class WriterApplicationsService {
  constructor(
    @InjectRepository(MagazineWriterApplication)
    private readonly applications: Repository<MagazineWriterApplication>,
    @InjectRepository(UserStaffRole)
    private readonly staffRoles: Repository<UserStaffRole>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  async create(
    userId: string,
    dto: CreateWriterApplicationDto,
  ): Promise<WriterApplicationDTO> {
    const sampleText = dto.sampleText?.trim() || null;
    const sampleLink = dto.sampleLink?.trim() || null;
    if (!sampleText && !sampleLink) {
      throw new BadRequestException(
        'Include a writing sample: pasted text or a link',
      );
    }

    const alreadyWriter = await this.staffRoles.exists({
      where: { userId, role: 'magazine_writer' },
    });
    if (alreadyWriter) {
      throw new ConflictException('Already a magazine writer');
    }

    try {
      const saved = await this.applications.save(
        this.applications.create({
          userId,
          pitchNote: dto.pitchNote?.trim() || null,
          sampleText,
          sampleLink,
        }),
      );
      // Tell whoever works the writer-application queue that an application
      // landed. Awaited, but safe to await: `announce` catches everything
      // internally, so a notification failure can never fail the member's
      // submission.
      await this.adminQueueNotifications.announce(
        AdminQueueKey.WriterApplications,
        saved.id,
      );
      return toWriterApplicationDTO(saved);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('An application is already pending');
      }
      throw err;
    }
  }

  async getMine(userId: string): Promise<WriterApplicationDTO | null> {
    const latest = await this.applications.findOne({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    return latest ? toWriterApplicationDTO(latest) : null;
  }
}

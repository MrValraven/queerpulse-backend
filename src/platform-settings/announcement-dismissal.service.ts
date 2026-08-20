import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnnouncementDismissal } from './entities/announcement-dismissal.entity';

/**
 * Per-member dismissal state for the sitewide announcement banner (ADM-25).
 * Signed-out visitors have no server-side row at all — they dismiss via
 * `localStorage` on the frontend, keyed by the same `announcementVersion`.
 */
@Injectable()
export class AnnouncementDismissalService {
  constructor(
    @InjectRepository(AnnouncementDismissal)
    private readonly dismissals: Repository<AnnouncementDismissal>,
  ) {}

  /** Has this member already dismissed this exact version of the banner? */
  async isDismissed(
    userId: string,
    announcementVersion: string,
  ): Promise<boolean> {
    const row = await this.dismissals.findOne({
      where: { userId, announcementVersion },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Idempotent: a repeat dismiss of the same version is absorbed by
   * `ON CONFLICT DO NOTHING` against the unique `(user_id, announcement_version)`
   * index, mirroring `NudgesService.dismiss`.
   */
  async dismiss(userId: string, announcementVersion: string): Promise<void> {
    await this.dismissals
      .createQueryBuilder()
      .insert()
      .into(AnnouncementDismissal)
      .values({ userId, announcementVersion })
      .orIgnore()
      .execute();
  }
}

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ScheduleStudioReleaseDto } from './dto/schedule-studio-release.dto';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioOwnershipService } from './studio-ownership.service';
import { firstUnmetPublishRequirement } from './studio-publish-rule';
import { StudioReleaseResponse } from './studio-response';
import {
  isWithinScheduleWindow,
  scheduleDateInLisbon,
} from './studio-schedule-rule';
import { studioError } from './studio.constants';

/**
 * Studio v3: schedule and unschedule a release. Both lock the release row
 * first (`lockReleaseForWrite`, which re-checks membership and the persona
 * kind) and answer with the owner view. The publish rule runs at
 * scheduling time; the drop itself (`StudioScheduledReleasesService`) runs
 * no rule, and the edit rules keep the release publishable until then.
 * Studio artist kinds: the publish rule's sources check runs at scheduling
 * time too; a show's episodes are stamped at the drop.
 */
@Injectable()
export class StudioSchedulingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
  ) {}

  async schedule(
    userId: string,
    releaseId: string,
    body: ScheduleStudioReleaseDto,
    now: Date = new Date(),
  ): Promise<StudioReleaseResponse> {
    const publishAt = new Date(body.publishAt);
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (
        release.status !== StudioReleaseStatus.Draft &&
        release.status !== StudioReleaseStatus.Scheduled
      ) {
        throw studioError('studio_release_not_schedulable');
      }
      if (!isWithinScheduleWindow(publishAt, now)) {
        throw studioError('studio_schedule_out_of_range');
      }
      const releaseTracks = await manager.find(StudioTrack, {
        where: { releaseId },
        select: {
          id: true,
          audioKey: true,
          durationSeconds: true,
          sources: true,
        },
      });
      const unmetRequirement = firstUnmetPublishRequirement(
        release,
        releaseTracks,
      );
      if (unmetRequirement) {
        throw studioError(unmetRequirement);
      }
      // A date that scheduling filled names the previous scheduled day;
      // a reschedule moves it. A typed date stays.
      const filledDate = release.publishAt
        ? scheduleDateInLisbon(release.publishAt)
        : null;
      if (!release.releasedOn || release.releasedOn === filledDate) {
        release.releasedOn = scheduleDateInLisbon(publishAt);
      }
      release.status = StudioReleaseStatus.Scheduled;
      release.publishAt = publishAt;
      await manager.save(release);
    });
    return this.catalog.getRelease(userId, releaseId);
  }

  /** Back to draft, keeping the reminders, so a rescheduled release keeps
   *  the members waiting for it. A draft comes back unchanged. */
  async unschedule(
    userId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status === StudioReleaseStatus.Draft) {
        return;
      }
      if (release.status !== StudioReleaseStatus.Scheduled) {
        throw studioError('studio_release_not_schedulable');
      }
      if (
        release.publishAt &&
        release.releasedOn === scheduleDateInLisbon(release.publishAt)
      ) {
        release.releasedOn = null;
      }
      release.status = StudioReleaseStatus.Draft;
      release.publishAt = null;
      await manager.save(release);
    });
    return this.catalog.getRelease(userId, releaseId);
  }
}

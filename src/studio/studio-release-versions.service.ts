import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CreateStudioReleaseVersionDto } from './dto/create-studio-release-version.dto';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { isPodcastRelease } from './studio-episode-rule';
import { StudioOwnershipService } from './studio-ownership.service';
import { nextVersionNumber } from './studio-release-edit-rule';
import {
  StudioReleaseResponse,
  hasUnnotedTrackChanges,
} from './studio-response';
import { studioError } from './studio.constants';

/** `clock_timestamp()` for the same reason the track stamp uses it: the
 *  note is dated after the release lock was granted. */
export const INSERT_VERSION_SQL = `INSERT INTO "studio_release_versions" ("release_id", "version", "note", "created_at")
VALUES ($1, $2, $3, clock_timestamp())`;

/**
 * Studio v3 version notes. A note is added to a published release whose
 * tracks changed after its publish and after its newest note; it becomes
 * version n+1 (the publish is version 1). Followers are never alerted.
 */
@Injectable()
export class StudioReleaseVersionsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly catalog: StudioCatalogService,
  ) {}

  async addVersion(
    userId: string,
    releaseId: string,
    body: CreateStudioReleaseVersionDto,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const { release } = await this.ownership.lockReleaseForWrite(
        manager,
        userId,
        releaseId,
      );
      if (release.status === StudioReleaseStatus.TakenDown) {
        throw studioError('studio_release_not_draft');
      }
      // Studio artist kinds: a podcast show gains episodes as it goes and
      // has no version notes.
      if (
        release.status !== StudioReleaseStatus.Published ||
        isPodcastRelease(release)
      ) {
        throw studioError('studio_release_no_changes');
      }
      const latestVersion = await manager.findOne(StudioReleaseVersion, {
        where: { releaseId: release.id },
        order: { version: 'DESC' },
      });
      if (!hasUnnotedTrackChanges(release, latestVersion?.createdAt ?? null)) {
        throw studioError('studio_release_no_changes');
      }
      await manager.query(INSERT_VERSION_SQL, [
        release.id,
        nextVersionNumber(latestVersion?.version ?? null),
        body.note,
      ]);
    });
    return this.catalog.getRelease(userId, releaseId);
  }
}

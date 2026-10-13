import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioReleaseResponse } from './studio-response';
import { STUDIO_AUDIT_ACTIONS } from './studio.constants';

/**
 * Studio v1: staff takedown and restore. Both lock the release row, are
 * idempotent, and write their `mod_audit_logs` row in the same transaction.
 * The audit row names no target member: the release belongs to a persona,
 * and the member drawer must never tie a pseudonymous persona to its owner.
 *
 * Restore returns a release to `published` only when it still holds a
 * `published_at`, which means it was live when it was taken down (unpublish
 * clears that column). A draft taken down comes back as a draft, so restore
 * never publishes anything that skipped the publish rule.
 */
@Injectable()
export class StudioModerationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly catalog: StudioCatalogService,
    private readonly modAudit: ModAuditService,
  ) {}

  async takedown(
    actorId: string,
    releaseId: string,
    reason: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const release = await this.lockRelease(manager, releaseId);
      if (release.status === StudioReleaseStatus.TakenDown) {
        return;
      }
      release.status = StudioReleaseStatus.TakenDown;
      release.takenDownAt = new Date();
      release.takenDownById = actorId;
      release.takedownReason = reason;
      await manager.save(release);
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        STUDIO_AUDIT_ACTIONS.releaseTakenDown,
        undefined,
        `${releaseId}: ${reason}`,
        undefined,
        manager,
        null,
      );
    });
    return this.catalog.getReleaseForStaff(releaseId);
  }

  async restore(
    actorId: string,
    releaseId: string,
  ): Promise<StudioReleaseResponse> {
    await this.dataSource.transaction(async (manager) => {
      const release = await this.lockRelease(manager, releaseId);
      if (release.status !== StudioReleaseStatus.TakenDown) {
        return;
      }
      release.status = release.publishedAt
        ? StudioReleaseStatus.Published
        : StudioReleaseStatus.Draft;
      release.takenDownAt = null;
      release.takenDownById = null;
      release.takedownReason = null;
      await manager.save(release);
      await this.modAudit.writeAuditLog(
        null,
        actorId,
        STUDIO_AUDIT_ACTIONS.releaseRestored,
        undefined,
        releaseId,
        undefined,
        manager,
        null,
      );
    });
    return this.catalog.getReleaseForStaff(releaseId);
  }

  private async lockRelease(
    manager: EntityManager,
    releaseId: string,
  ): Promise<StudioRelease> {
    const release = await manager.findOne(StudioRelease, {
      where: { id: releaseId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!release) {
      throw new NotFoundException('Release not found');
    }
    return release;
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { StudioReleaseReminder } from './entities/studio-release-reminder.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import { StudioReleaseExtras } from './studio-response';
import {
  StudioSupportLink,
  toStudioSupportLinks,
} from './studio-support-links';
import { STUDIO_SUPPORT_PLATFORMS } from './studio.constants';

/**
 * Studio v3: the parts of a release response that live beside the release
 * row (support links from the persona, version notes, the viewer's Notify
 * me). Kept out of `StudioCatalogService` so the catalog stays a reader of
 * releases and tracks.
 */
@Injectable()
export class StudioReleaseExtrasService {
  constructor(
    @InjectRepository(StudioReleaseVersion)
    private readonly versions: Repository<StudioReleaseVersion>,
    @InjectRepository(StudioReleaseReminder)
    private readonly reminders: Repository<StudioReleaseReminder>,
    @InjectRepository(SubprofileSocialLink)
    private readonly socialLinks: Repository<SubprofileSocialLink>,
  ) {}

  /** `viewerId` null is the staff read: no reminder state. */
  async forRelease(
    viewerId: string | null,
    release: Pick<StudioRelease, 'id' | 'subprofileId' | 'status'>,
  ): Promise<StudioReleaseExtras> {
    const [supportLinks, versions, isReminderSet] = await Promise.all([
      this.supportLinksFor(release.subprofileId),
      this.versions.find({
        where: { releaseId: release.id },
        order: { version: 'DESC' },
        select: { version: true, note: true, createdAt: true },
      }),
      viewerId && release.status === StudioReleaseStatus.Scheduled
        ? this.reminders.exists({
            where: { releaseId: release.id, userId: viewerId },
          })
        : Promise.resolve(false),
    ]);
    return { supportLinks, versions, isReminderSet };
  }

  /** The persona's Bandcamp, Ko-fi and Patreon links, in its link order. */
  async supportLinksFor(subprofileId: string): Promise<StudioSupportLink[]> {
    const links = await this.socialLinks.find({
      where: {
        subprofileId,
        platform: In([...STUDIO_SUPPORT_PLATFORMS]),
      },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    return toStudioSupportLinks(links);
  }

  /** Which of `releaseIds` the viewer asked to be told about. */
  async reminderStatesFor(
    viewerId: string,
    releaseIds: string[],
  ): Promise<Set<string>> {
    if (!releaseIds.length) {
      return new Set();
    }
    const rows = await this.reminders.find({
      where: { userId: viewerId, releaseId: In(releaseIds) },
      select: { releaseId: true },
    });
    return new Set(rows.map((row) => row.releaseId));
  }
}

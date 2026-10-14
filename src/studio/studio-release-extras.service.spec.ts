import { In, Repository } from 'typeorm';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { StudioReleaseReminder } from './entities/studio-release-reminder.entity';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioReleaseVersion } from './entities/studio-release-version.entity';
import { StudioReleaseExtrasService } from './studio-release-extras.service';

const VIEWER_ID = 'c8000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'c8000000-0000-4000-8000-000000000002';
const RELEASE_ID = 'c8000000-0000-4000-8000-000000000003';
const OTHER_RELEASE = 'c8000000-0000-4000-8000-000000000004';

describe('StudioReleaseExtrasService', () => {
  let versions: { find: jest.Mock };
  let reminders: { exists: jest.Mock; find: jest.Mock };
  let socialLinks: { find: jest.Mock };
  let service: StudioReleaseExtrasService;

  beforeEach(() => {
    versions = {
      find: jest.fn().mockResolvedValue([
        {
          version: 2,
          note: 'Added a bonus track',
          createdAt: new Date('2026-10-10T09:00:00.000Z'),
        },
      ]),
    };
    reminders = {
      exists: jest.fn().mockResolvedValue(true),
      find: jest.fn().mockResolvedValue([{ releaseId: RELEASE_ID }]),
    };
    socialLinks = {
      find: jest.fn().mockResolvedValue([
        { platform: 'kofi', urlOrHandle: 'nightshift', position: 2 },
        { platform: 'bandcamp', urlOrHandle: 'nightshift', position: 1 },
      ]),
    };
    service = new StudioReleaseExtrasService(
      versions as unknown as Repository<StudioReleaseVersion>,
      reminders as unknown as Repository<StudioReleaseReminder>,
      socialLinks as unknown as Repository<SubprofileSocialLink>,
    );
  });

  it('reads the support links, the notes newest first and the reminder of a scheduled release', async () => {
    const extras = await service.forRelease(VIEWER_ID, {
      id: RELEASE_ID,
      subprofileId: PERSONA_ID,
      status: StudioReleaseStatus.Scheduled,
    });
    expect(extras.supportLinks).toEqual([
      { platform: 'bandcamp', urlOrHandle: 'nightshift' },
      { platform: 'kofi', urlOrHandle: 'nightshift' },
    ]);
    expect(extras.versions).toHaveLength(1);
    expect(extras.isReminderSet).toBe(true);
    expect(versions.find).toHaveBeenCalledWith({
      where: { releaseId: RELEASE_ID },
      order: { version: 'DESC' },
      select: { version: true, note: true, createdAt: true },
    });
    expect(reminders.exists).toHaveBeenCalledWith({
      where: { releaseId: RELEASE_ID, userId: VIEWER_ID },
    });
  });

  it('reads no reminder for a published release or a staff read', async () => {
    const published = await service.forRelease(VIEWER_ID, {
      id: RELEASE_ID,
      subprofileId: PERSONA_ID,
      status: StudioReleaseStatus.Published,
    });
    const staff = await service.forRelease(null, {
      id: RELEASE_ID,
      subprofileId: PERSONA_ID,
      status: StudioReleaseStatus.Scheduled,
    });
    expect(published.isReminderSet).toBe(false);
    expect(staff.isReminderSet).toBe(false);
    expect(reminders.exists).not.toHaveBeenCalled();
  });

  it('asks the persona links for the support platforms only', async () => {
    await service.supportLinksFor(PERSONA_ID);
    expect(socialLinks.find).toHaveBeenCalledWith({
      where: {
        subprofileId: PERSONA_ID,
        platform: In(['bandcamp', 'kofi', 'patreon']),
      },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
  });

  it('drops a stored link on another platform even when the query returns it', async () => {
    socialLinks.find.mockResolvedValue([
      { platform: 'instagram', urlOrHandle: 'nightshift', position: 0 },
      { platform: 'patreon', urlOrHandle: 'nightshift', position: 3 },
    ]);
    expect(await service.supportLinksFor(PERSONA_ID)).toEqual([
      { platform: 'patreon', urlOrHandle: 'nightshift' },
    ]);
  });

  it('answers the reminded releases among a list, and nothing for an empty one', async () => {
    expect(
      await service.reminderStatesFor(VIEWER_ID, [RELEASE_ID, OTHER_RELEASE]),
    ).toEqual(new Set([RELEASE_ID]));
    expect(reminders.find).toHaveBeenCalledWith({
      where: { userId: VIEWER_ID, releaseId: In([RELEASE_ID, OTHER_RELEASE]) },
      select: { releaseId: true },
    });
    reminders.find.mockClear();
    expect(await service.reminderStatesFor(VIEWER_ID, [])).toEqual(new Set());
    expect(reminders.find).not.toHaveBeenCalled();
  });
});

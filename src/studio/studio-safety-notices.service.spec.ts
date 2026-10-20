import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  StudioSafetyNoticesService,
  TRACK_NOTICE_SQL,
} from './studio-safety-notices.service';

const CLAIM_ID = 'ca000000-0000-4000-8000-000000000001';
const TRACK_ID = 'ca100000-0000-4000-8000-000000000001';
const RELEASE_ID = 'ca200000-0000-4000-8000-000000000001';
const CREATOR_ID = 'ca300000-0000-4000-8000-000000000001';
const CO_OWNER_ID = 'ca300000-0000-4000-8000-000000000002';
const CLAIMANT_ID = 'ca300000-0000-4000-8000-000000000003';

describe('StudioSafetyNoticesService', () => {
  let query: jest.Mock;
  let notifications: { create: jest.Mock; createForRecipients: jest.Mock };
  let service: StudioSafetyNoticesService;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([
      { track_title: 'Opening', release_id: RELEASE_ID, user_id: CREATOR_ID },
      { track_title: 'Opening', release_id: RELEASE_ID, user_id: CO_OWNER_ID },
    ]);
    notifications = {
      create: jest.fn().mockResolvedValue(null),
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    service = new StudioSafetyNoticesService(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  it('reads the track owners at send time, creator and roster once each', async () => {
    await service.claimAccepted(CLAIM_ID, TRACK_ID);
    expect(query).toHaveBeenCalledWith(TRACK_NOTICE_SQL, [TRACK_ID]);
    expect(TRACK_NOTICE_SQL).toContain('UNION');
    expect(TRACK_NOTICE_SQL).toContain('"subprofile_members"');
  });

  it('tells the owners a claim was accepted, with no actor', async () => {
    await service.claimAccepted(CLAIM_ID, TRACK_ID);
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioCopyrightClaimAccepted,
      {
        claimId: CLAIM_ID,
        trackId: TRACK_ID,
        releaseId: RELEASE_ID,
        trackTitle: 'Opening',
      },
    );
    expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
  });

  it.each([
    ['claimDeclined', NotificationType.StudioCopyrightClaimDeclined],
    ['claimCountered', NotificationType.StudioCopyrightClaimCountered],
  ] as const)(
    '%s reaches the claimant alone with the claim and the title',
    async (method, type) => {
      await service[method](CLAIM_ID, CLAIMANT_ID, TRACK_ID);
      expect(notifications.create).toHaveBeenCalledWith(CLAIMANT_ID, type, {
        claimId: CLAIM_ID,
        trackTitle: 'Opening',
      });
      expect(notifications.create.mock.calls[0]).toHaveLength(3);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    },
  );

  it('tells both sides of a decision, each row naming its audience', async () => {
    await service.claimDecided(CLAIM_ID, CLAIMANT_ID, TRACK_ID, 'rejected');
    expect(notifications.create).toHaveBeenCalledWith(
      CLAIMANT_ID,
      NotificationType.StudioCopyrightClaimDecided,
      {
        claimId: CLAIM_ID,
        trackTitle: 'Opening',
        outcome: 'rejected',
        recipientRole: 'claimant',
      },
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioCopyrightClaimDecided,
      {
        claimId: CLAIM_ID,
        trackId: TRACK_ID,
        releaseId: RELEASE_ID,
        trackTitle: 'Opening',
        outcome: 'rejected',
        recipientRole: 'owner',
      },
    );
  });

  it('tells the owners of a withdrawn claim and a marked track', async () => {
    await service.claimWithdrawn(CLAIM_ID, TRACK_ID);
    await service.trackMarked(TRACK_ID, 'content_warning');
    expect(notifications.createForRecipients).toHaveBeenNthCalledWith(
      1,
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioCopyrightClaimWithdrawn,
      {
        claimId: CLAIM_ID,
        trackId: TRACK_ID,
        releaseId: RELEASE_ID,
        trackTitle: 'Opening',
      },
    );
    expect(notifications.createForRecipients).toHaveBeenNthCalledWith(
      2,
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioTrackMarked,
      {
        trackId: TRACK_ID,
        releaseId: RELEASE_ID,
        trackTitle: 'Opening',
        change: 'content_warning',
      },
    );
  });

  it('sends nothing for a track that is gone', async () => {
    query.mockResolvedValue([]);
    await service.claimAccepted(CLAIM_ID, TRACK_ID);
    await service.claimDeclined(CLAIM_ID, CLAIMANT_ID, TRACK_ID);
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('swallows a failed notice, since the action already committed', async () => {
    notifications.createForRecipients.mockRejectedValue(new Error('down'));
    await expect(
      service.trackMarked(TRACK_ID, 'explicit'),
    ).resolves.toBeUndefined();
    query.mockRejectedValue(new Error('down'));
    await expect(
      service.claimCountered(CLAIM_ID, CLAIMANT_ID, TRACK_ID),
    ).resolves.toBeUndefined();
  });
});

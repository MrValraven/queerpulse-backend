import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { StudioReleaseDisputeStatus } from './entities/studio-release-dispute.entity';
import {
  RELEASE_NOTICE_RECIPIENTS_SQL,
  StudioReleaseNoticesListener,
} from './studio-release-notices.listener';

const RELEASE_ID = 'd1000000-0000-4000-8000-000000000001';
const DISPUTE_ID = 'd2000000-0000-4000-8000-000000000001';
const CREATOR_ID = 'd3000000-0000-4000-8000-000000000001';
const CO_OWNER_ID = 'd3000000-0000-4000-8000-000000000002';

describe('StudioReleaseNoticesListener', () => {
  let dataSource: { query: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let listener: StudioReleaseNoticesListener;

  beforeEach(() => {
    dataSource = {
      query: jest.fn().mockResolvedValue([
        { release_title: 'Lisbon at four', user_id: CREATOR_ID },
        { release_title: 'Lisbon at four', user_id: CO_OWNER_ID },
      ]),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listener = new StudioReleaseNoticesListener(
      dataSource as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  it('tells the persona creator and co-owners a release was taken down, naming no actor', async () => {
    await listener.handleReleaseTakenDown({ releaseId: RELEASE_ID });

    expect(dataSource.query).toHaveBeenCalledWith(
      RELEASE_NOTICE_RECIPIENTS_SQL,
      [RELEASE_ID],
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioReleaseTakenDown,
      { releaseId: RELEASE_ID, releaseTitle: 'Lisbon at four' },
    );
    // No fourth argument: no actor for the block and mute filter either.
    expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
  });

  it('tells the same owners a dispute was decided, with the outcome and no staff reply', async () => {
    await listener.handleDisputeDecided({
      releaseId: RELEASE_ID,
      disputeId: DISPUTE_ID,
      outcome: StudioReleaseDisputeStatus.Rejected,
    });

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [CREATOR_ID, CO_OWNER_ID],
      NotificationType.StudioReleaseDisputeDecided,
      {
        releaseId: RELEASE_ID,
        releaseTitle: 'Lisbon at four',
        outcome: 'rejected',
      },
    );
  });

  it('names each owner once', async () => {
    dataSource.query.mockResolvedValue([
      { release_title: 'Lisbon at four', user_id: CREATOR_ID },
      { release_title: 'Lisbon at four', user_id: CREATOR_ID },
    ]);
    await listener.handleReleaseTakenDown({ releaseId: RELEASE_ID });
    expect(notifications.createForRecipients.mock.calls[0]![0]).toEqual([
      CREATOR_ID,
    ]);
  });

  it('sends nothing for a release that is gone', async () => {
    dataSource.query.mockResolvedValue([]);
    await listener.handleReleaseTakenDown({ releaseId: RELEASE_ID });
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('swallows a failure: the takedown has already committed', async () => {
    dataSource.query.mockRejectedValue(new Error('pool exhausted'));
    await expect(
      listener.handleReleaseTakenDown({ releaseId: RELEASE_ID }),
    ).resolves.toBeUndefined();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});

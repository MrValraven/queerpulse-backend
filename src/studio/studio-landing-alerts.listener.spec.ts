import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PREVIEW_ALERT_SQL,
  PREVIEW_LIVE_PERSONAS_SQL,
  PREVIEW_RECIPIENTS_SQL,
  StudioLandingAlertsListener,
} from './studio-landing-alerts.listener';

const PREVIEW_ID = 'f9000000-0000-4000-8000-000000000001';
const TRACK_ID = 'f9000000-0000-4000-8000-000000000002';
const MAIN = 'f9000000-0000-4000-8000-000000000003';
const CREDITED_ONE = 'f9000000-0000-4000-8000-000000000004';
const APPROVER = 'f9000000-0000-4000-8000-000000000005';
const OWNER_A = 'f9000000-0000-4000-8000-000000000006';
const OWNER_B = 'f9000000-0000-4000-8000-000000000007';
const OWNER_C = 'f9000000-0000-4000-8000-000000000008';

const previewRow = {
  preview_id: PREVIEW_ID,
  track_id: TRACK_ID,
  track_title: 'Opening',
  persona_id: MAIN,
  persona_name: 'Night Shift',
};

describe('StudioLandingAlertsListener', () => {
  let query: jest.Mock;
  let notifications: { createForRecipients: jest.Mock };
  let listener: StudioLandingAlertsListener;
  let previewRows: unknown[];
  let personaIds: string[];
  let recipientsByPersona: Record<string, string[]>;

  beforeEach(() => {
    previewRows = [previewRow];
    personaIds = [MAIN, CREDITED_ONE];
    recipientsByPersona = {
      [MAIN]: [APPROVER, OWNER_A],
      [CREDITED_ONE]: [OWNER_A, OWNER_C],
    };
    query = jest.fn((sql: string, parameters: unknown[]) => {
      if (sql === PREVIEW_ALERT_SQL) {
        return Promise.resolve(previewRows);
      }
      if (sql === PREVIEW_LIVE_PERSONAS_SQL) {
        return Promise.resolve(
          personaIds.map((personaId) => ({ persona_id: personaId })),
        );
      }
      const personaId = String(parameters[0]);
      return Promise.resolve(
        (recipientsByPersona[personaId] ?? []).map((userId) => ({
          user_id: userId,
        })),
      );
    });
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([]),
    };
    listener = new StudioLandingAlertsListener(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
    );
  });

  it('sends the request to grant-holding members of the release persona with no actor', async () => {
    recipientsByPersona = { [MAIN]: [OWNER_A, OWNER_B] };

    await listener.onPreviewRequested({ previewId: PREVIEW_ID });

    expect(query).toHaveBeenCalledWith(PREVIEW_ALERT_SQL, [
      PREVIEW_ID,
      'pending',
    ]);
    expect(query).toHaveBeenCalledWith(PREVIEW_RECIPIENTS_SQL, [MAIN]);
    expect(notifications.createForRecipients.mock.calls).toEqual([
      [
        [OWNER_A, OWNER_B],
        NotificationType.StudioLandingPreviewRequested,
        {
          previewId: PREVIEW_ID,
          subprofileId: MAIN,
          personaName: 'Night Shift',
          trackTitle: 'Opening',
        },
      ],
    ]);
  });

  it('sends nothing once the preview is no longer pending', async () => {
    previewRows = [];

    await listener.onPreviewRequested({ previewId: PREVIEW_ID });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(PREVIEW_ALERT_SQL).toContain('"preview"."status"::text = $2');
  });

  it('sends nothing when no member of the release persona holds a grant', async () => {
    recipientsByPersona = { [MAIN]: [] };

    await listener.onPreviewRequested({ previewId: PREVIEW_ID });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('sends the live notice once per persona, release persona first, leaving out the approver and anyone already sent', async () => {
    await listener.onPreviewApproved({
      previewId: PREVIEW_ID,
      approverUserId: APPROVER,
    });

    expect(query).toHaveBeenCalledWith(PREVIEW_ALERT_SQL, [
      PREVIEW_ID,
      'approved',
    ]);
    expect(query).toHaveBeenCalledWith(PREVIEW_LIVE_PERSONAS_SQL, [TRACK_ID]);
    expect(
      notifications.createForRecipients.mock.calls.map(
        ([userIds, type, payload]: [
          string[],
          NotificationType,
          { subprofileId: string },
        ]) => [userIds, type, payload.subprofileId],
      ),
    ).toEqual([
      [[OWNER_A], NotificationType.StudioLandingPreviewLive, MAIN],
      [[OWNER_C], NotificationType.StudioLandingPreviewLive, CREDITED_ONE],
    ]);
  });

  it('carries the release persona name, the track title and no member id in the live payload', async () => {
    await listener.onPreviewApproved({
      previewId: PREVIEW_ID,
      approverUserId: APPROVER,
    });

    expect(notifications.createForRecipients.mock.calls).toEqual([
      [
        [OWNER_A],
        NotificationType.StudioLandingPreviewLive,
        {
          previewId: PREVIEW_ID,
          subprofileId: MAIN,
          mainPersonaName: 'Night Shift',
          trackTitle: 'Opening',
        },
      ],
      [
        [OWNER_C],
        NotificationType.StudioLandingPreviewLive,
        {
          previewId: PREVIEW_ID,
          subprofileId: CREDITED_ONE,
          mainPersonaName: 'Night Shift',
          trackTitle: 'Opening',
        },
      ],
    ]);
  });

  it('skips a persona whose every recipient was already sent', async () => {
    recipientsByPersona = {
      [MAIN]: [APPROVER, OWNER_A],
      [CREDITED_ONE]: [OWNER_A, APPROVER],
    };

    await listener.onPreviewApproved({
      previewId: PREVIEW_ID,
      approverUserId: APPROVER,
    });

    expect(
      notifications.createForRecipients.mock.calls.map(
        ([userIds]: [string[]]) => userIds,
      ),
    ).toEqual([[OWNER_A]]);
  });

  it('sends no live notice once the preview is no longer approved', async () => {
    previewRows = [];

    await listener.onPreviewApproved({
      previewId: PREVIEW_ID,
      approverUserId: APPROVER,
    });

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('reads the release persona first, then accepted credits, and only grant-holding active members', () => {
    expect(PREVIEW_LIVE_PERSONAS_SQL).toContain('0 AS "rank"');
    expect(PREVIEW_LIVE_PERSONAS_SQL).toContain('1 AS "rank"');
    expect(PREVIEW_LIVE_PERSONAS_SQL).toContain(`= 'accepted'`);
    expect(PREVIEW_LIVE_PERSONAS_SQL).toContain(
      'ORDER BY "rank" ASC, "persona_id" ASC',
    );
    expect(PREVIEW_RECIPIENTS_SQL).toContain('"studio_access_grants"');
    expect(PREVIEW_RECIPIENTS_SQL).toContain('ORDER BY "user_id" ASC');
  });

  it('keeps sending to the next persona after one persona send fails', async () => {
    notifications.createForRecipients.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await expect(
      listener.onPreviewApproved({
        previewId: PREVIEW_ID,
        approverUserId: APPROVER,
      }),
    ).resolves.toBeUndefined();

    expect(
      notifications.createForRecipients.mock.calls.map(
        ([userIds, , payload]: [
          string[],
          NotificationType,
          { subprofileId: string },
        ]) => [userIds, payload.subprofileId],
      ),
    ).toEqual([
      [[OWNER_A], MAIN],
      [[OWNER_A, OWNER_C], CREDITED_ONE],
    ]);
  });

  it('logs and swallows a failed send', async () => {
    notifications.createForRecipients.mockRejectedValue(
      new Error('connection reset'),
    );
    recipientsByPersona = { [MAIN]: [OWNER_A] };

    await expect(
      listener.onPreviewRequested({ previewId: PREVIEW_ID }),
    ).resolves.toBeUndefined();
    await expect(
      listener.onPreviewApproved({
        previewId: PREVIEW_ID,
        approverUserId: APPROVER,
      }),
    ).resolves.toBeUndefined();
  });
});

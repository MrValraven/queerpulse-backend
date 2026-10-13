import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ClaimedReleaseRow,
  RELEASE_ALERT_CLAIM_SQL,
  RELEASE_ALERT_RECIPIENTS_SQL,
  StudioReleaseAlertsListener,
} from './studio-release-alerts.listener';

const RELEASE_ID = 'd1000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'd2000000-0000-4000-8000-000000000001';
const OWNER_ID = 'd3000000-0000-4000-8000-000000000001';

const claimedRow: ClaimedReleaseRow = {
  release_id: RELEASE_ID,
  release_title: 'Lisbon at four',
  release_type: 'mix',
  subprofile_id: PERSONA_ID,
  subprofile_name: 'Night Shift',
  subprofile_slug_or_handle: 'night-shift',
  owner_user_id: OWNER_ID,
};

const followerIds = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `d4000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

describe('StudioReleaseAlertsListener', () => {
  let query: jest.Mock;
  let createForRecipients: jest.Mock;
  let listener: StudioReleaseAlertsListener;

  const respond = (claimRows: ClaimedReleaseRow[], followers: string[]) => {
    query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql === RELEASE_ALERT_CLAIM_SQL
          ? claimRows
          : followers.map((followerId) => ({ follower_id: followerId })),
      ),
    );
  };

  beforeEach(() => {
    query = jest.fn();
    createForRecipients = jest.fn().mockResolvedValue([]);
    listener = new StudioReleaseAlertsListener(
      { query } as unknown as DataSource,
      { createForRecipients } as unknown as NotificationsService,
    );
  });

  it('claims the release before it reads a single follower', async () => {
    respond([claimedRow], followerIds(2));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query.mock.calls[0]).toEqual([
      RELEASE_ALERT_CLAIM_SQL,
      [RELEASE_ID],
    ]);
    expect(query.mock.calls[1]?.[0]).toBe(RELEASE_ALERT_RECIPIENTS_SQL);
  });

  it('sends nothing when the claim finds the release already alerted', async () => {
    respond([], followerIds(2));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query).toHaveBeenCalledTimes(1);
    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('asks for granted followers minus the creator and co-owners, up to 5000', async () => {
    respond([claimedRow], followerIds(1));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query.mock.calls[1]?.[1]).toEqual([PERSONA_ID, OWNER_ID, 5000]);
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('"studio_access_grants"');
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('"subprofile_members"');
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain(
      `"follower"."follower_id" <> $2`,
    );
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('LIMIT $3');
  });

  it('tells followers in chunks of 500, filtered under the persona owner', async () => {
    const followers = followerIds(1200);
    respond([claimedRow], followers);

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(createForRecipients).toHaveBeenCalledTimes(3);
    const chunks = createForRecipients.mock.calls.map(
      ([recipientIds]) => recipientIds as string[],
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 200]);
    expect(chunks.flat()).toEqual(followers);
    for (const call of createForRecipients.mock.calls) {
      expect(call[1]).toBe(NotificationType.StudioReleasePublished);
      expect(call[3]).toBe(OWNER_ID);
    }
  });

  it('puts the persona and the release on the payload and no owner id', async () => {
    respond([claimedRow], followerIds(1));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      subprofileName: 'Night Shift',
      subprofileSlugOrHandle: 'night-shift',
      subprofileId: PERSONA_ID,
      releaseId: RELEASE_ID,
      releaseTitle: 'Lisbon at four',
      releaseType: 'mix',
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
  });

  it('links a persona without a handle by its slug', async () => {
    respond(
      [{ ...claimedRow, subprofile_slug_or_handle: 'night-shift-slug' }],
      followerIds(1),
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload.subprofileSlugOrHandle).toBe('night-shift-slug');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `COALESCE("persona"."handle", "persona"."slug") AS "subprofile_slug_or_handle"`,
    );
  });

  it('names a persona with a blank display name by its link token', () => {
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `NULLIF(btrim("persona"."display_name"), '')`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toMatch(
      /COALESCE\(\s*NULLIF\(btrim\("persona"\."display_name"\), ''\),\s*"persona"\."handle",\s*"persona"\."slug"\s*\) AS "subprofile_name"/,
    );
  });

  it('sends nothing when no follower qualifies', async () => {
    respond([claimedRow], []);

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('claims only a published release of a listenable persona that was never alerted', () => {
    expect(RELEASE_ALERT_CLAIM_SQL).toMatch(/^WITH "claimed" AS \(/);
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"release"."followers_notified_at" IS NULL`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"persona"."visibility" = 'open'`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('content_moderation');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('RETURNING');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('SELECT * FROM "claimed"');
  });

  it('never throws back at the publish when the fan-out fails', async () => {
    respond([claimedRow], followerIds(1));
    createForRecipients.mockRejectedValue(new Error('pool exhausted'));

    await expect(
      listener.handleReleasePublished({ releaseId: RELEASE_ID }),
    ).resolves.toBeUndefined();
  });
});

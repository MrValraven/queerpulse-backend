import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ClaimedEpisodeRow,
  EPISODE_ALERT_CLAIM_SQL,
  StudioEpisodeAlertsListener,
} from './studio-episode-alerts.listener';
import { RELEASE_ALERT_RECIPIENTS_SQL } from './studio-release-alerts.listener';

const TRACK_ID = 'f2000000-0000-4000-8000-000000000001';
const SHOW_ID = 'f2000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'f2000000-0000-4000-8000-000000000003';
const OWNER_ID = 'f2000000-0000-4000-8000-000000000004';

const claimedRow: ClaimedEpisodeRow = {
  track_id: TRACK_ID,
  track_title: 'Housing in Lisbon',
  release_id: SHOW_ID,
  release_title: 'Lisbon After Dark',
  subprofile_id: PERSONA_ID,
  subprofile_name: 'Lisbon After Dark',
  subprofile_slug_or_handle: 'lisbon-after-dark',
  owner_user_id: OWNER_ID,
};

const followerIds = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `f3000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

describe('StudioEpisodeAlertsListener', () => {
  let query: jest.Mock;
  let createForRecipients: jest.Mock;
  let listener: StudioEpisodeAlertsListener;

  const respond = (claimRows: ClaimedEpisodeRow[], followers: string[]) => {
    query.mockImplementation((sql: string) => {
      if (sql === EPISODE_ALERT_CLAIM_SQL) {
        return Promise.resolve(claimRows);
      }
      if (sql === RELEASE_ALERT_RECIPIENTS_SQL) {
        return Promise.resolve(
          followers.map((recipientId) => ({
            recipient_id: recipientId,
            is_reminder_holder: false,
          })),
        );
      }
      return Promise.resolve([]);
    });
  };

  beforeEach(() => {
    query = jest.fn();
    createForRecipients = jest.fn().mockResolvedValue([]);
    listener = new StudioEpisodeAlertsListener(
      { query } as unknown as DataSource,
      { createForRecipients } as unknown as NotificationsService,
    );
  });

  it('sends nothing when the claim finds nothing', async () => {
    respond([], followerIds(2));

    await listener.handleEpisodePublished({ trackId: TRACK_ID });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(EPISODE_ALERT_CLAIM_SQL, [TRACK_ID]);
    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('claims a published episode of a published show of a listenable persona, once', () => {
    expect(EPISODE_ALERT_CLAIM_SQL).toMatch(/^WITH "claimed" AS \(/);
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(
      `"episode"."followers_notified_at" IS NULL`,
    );
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(
      `"episode"."published_at" IS NOT NULL`,
    );
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(
      `"episode"."audio_key" IS NOT NULL`,
    );
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(`"release"."type" = 'podcast'`);
    expect(EPISODE_ALERT_CLAIM_SQL).toContain(
      `"persona"."visibility" = 'open'`,
    );
    expect(EPISODE_ALERT_CLAIM_SQL).toContain('content_moderation');
    expect(EPISODE_ALERT_CLAIM_SQL).toContain('FROM "claimed"');
  });

  it('asks the release alert recipients for followers alone, up to 5000', async () => {
    respond([claimedRow], followerIds(1));

    await listener.handleEpisodePublished({ trackId: TRACK_ID });

    expect(query.mock.calls[1]).toEqual([
      RELEASE_ALERT_RECIPIENTS_SQL,
      [PERSONA_ID, OWNER_ID, 5000, []],
    ]);
  });

  it('puts the show, the episode and the persona on the payload and no member id', async () => {
    const followers = followerIds(2);
    respond([claimedRow], followers);

    await listener.handleEpisodePublished({ trackId: TRACK_ID });

    expect(createForRecipients).toHaveBeenCalledTimes(1);
    const [recipients, type, payload, actorId] = createForRecipients.mock
      .calls[0] as [string[], NotificationType, object, string];
    expect(recipients).toEqual(followers);
    expect(type).toBe(NotificationType.StudioEpisodePublished);
    expect(payload).toEqual({
      subprofileName: 'Lisbon After Dark',
      subprofileSlugOrHandle: 'lisbon-after-dark',
      subprofileId: PERSONA_ID,
      releaseId: SHOW_ID,
      trackId: TRACK_ID,
      releaseTitle: 'Lisbon After Dark',
      trackTitle: 'Housing in Lisbon',
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
    expect(actorId).toBe(OWNER_ID);
  });

  it('fans out in chunks of 500', async () => {
    respond([claimedRow], followerIds(1200));

    await listener.handleEpisodePublished({ trackId: TRACK_ID });

    expect(
      createForRecipients.mock.calls.map(
        ([recipients]: [string[]]) => recipients.length,
      ),
    ).toEqual([500, 500, 200]);
  });

  it('sends nothing to a show with no eligible follower', async () => {
    respond([claimedRow], []);

    await listener.handleEpisodePublished({ trackId: TRACK_ID });

    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('logs a failed claim and throws nothing back at the publish', async () => {
    query.mockRejectedValue(new Error('pool exhausted'));

    await expect(
      listener.handleEpisodePublished({ trackId: TRACK_ID }),
    ).resolves.toBeUndefined();
    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('logs a failed fan-out and throws nothing back at the publish', async () => {
    respond([claimedRow], followerIds(1));
    createForRecipients.mockRejectedValue(new Error('pool exhausted'));

    await expect(
      listener.handleEpisodePublished({ trackId: TRACK_ID }),
    ).resolves.toBeUndefined();
  });
});
